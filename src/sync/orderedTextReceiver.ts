import { encodeBinaryEnvelopeFrame, decodeBinaryEnvelopeFrame } from "../crypto/binaryEnvelope";
import { encodeBinaryTransportPacket, type TransportPacket } from "../adapters/transports/packetCodec";
import { computeBinaryRetryId, samePayloadBytes, sameOutboxPayload, validateBinaryEventOutbox } from "../storage/storedPayload";
import { canonicalBytes, parseCanonicalBytes } from "../crypto/canonicalJson";
import { writeVault, type VaultAccess } from "../db/vaultAccess";
import { legacyEventJson, legacyOutboxCiphertext } from "../storage/storedPayload";
import Dexie from "dexie";
import type { NKCVaultDB, MetaRecord, EventRecord, OutboxRecord } from "../db/schema";
import type { Conversation } from "../db/repo";
import { computeEnvelopeHash, decryptEnvelope, decryptEnvelopeBytes, isEnvelopeLike, encryptEnvelope, verifyEnvelopeSignature, type Envelope, type EnvelopeBytes, encryptEnvelopeBytes } from "../crypto/box";
import { createReceiveStateV1, createReceiveStateV2, prepareOrderedReceive, prepareSendKey, prepareSendDhKey, type OrderedReceiveState, type RetainedReceiveKey } from "../crypto/ratchet";
import { encryptJsonRecord, decryptJsonRecord, sameStoredCiphertext } from "../crypto/vault";
import { encodeBase64Url, decodeBase64Url } from "../security/base64url";
import { getSodium } from "../security/sodium";
import { buildReceivedText } from "./receivedText";

export const ORDERED_RECEIVE_LIMITS = Object.freeze({ keysPerChannel: 50, channelsPerAccount: 64,
  keysPerAccount: 512, chainsPerChannel: 4, lifetimeMs: 7 * 86400_000,
  stateBytes: 32_768, envelopeBytes: 128 * 1024, textBytes: 64 * 1024, lamportWindow: 128, activeCalls: 8 });

export type ReceiveCheckpoint = "authenticated" | "ratchet_written" | "event_written" | "message_written" | "before_return" | "send_prepared" | "outbox_written" | "reuse_prepared";

export type ChannelState = { v: 1; state: OrderedReceiveState | null; retained: RetainedReceiveKey[];
  maxLamport: number; legacySeen: number[]; sendLamport?: number; localIdentity?: string };

export type OrderedTextContext = { accountId: string; localConversation: string; wireConversation: string;
  author: string; verifyKey: Uint8Array; baseKey: Uint8Array; legacyKey: Uint8Array;
  seedState?: OrderedReceiveState; localSenderId?: string; peerSenderId?: string };

type OuterEvent = { eventId: string; convId: string; authorDeviceId: string; lamport: number; ts: number };

export const encodeOrderedState = (state: ChannelState) => JSON.parse(JSON.stringify(state,
  (_key, value) => value instanceof Uint8Array ? { bytes: encodeBase64Url(value) } : value));

export const decodeOrderedState = (value: unknown): ChannelState => JSON.parse(JSON.stringify(value),
  (_key, item) => item && typeof item === "object" && Object.keys(item).length === 1 && typeof item.bytes === "string"
    ? decodeBase64Url(item.bytes) : item);

/** Strict import/read validation; missing or corrupt states are never replaced with fresh keys. */
export const validateOrderedState = async (state: ChannelState) => {
  const counter = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const key = (value: unknown) => value instanceof Uint8Array && value.length === 32;

  if (state.v !== 1 || !counter(state.maxLamport) || !Array.isArray(state.legacySeen) || state.legacySeen.length > 128 ||
    state.legacySeen.some((value) => !counter(value) || value < 1 || value > state.maxLamport || value <= state.maxLamport - 128) ||
    new Set(state.legacySeen).size !== state.legacySeen.length || (state.sendLamport !== undefined && !counter(state.sendLamport)) ||
    !Array.isArray(state.retained) || state.retained.length > 50 || new Set(state.retained.map((item) => item.chain)).size > 4 ||
    state.retained.some((item) => typeof item.chain !== "string" || item.chain.length > 256 || !counter(item.index) ||
      !counter(item.expiresAt) || !key(item.key)) || JSON.stringify(encodeOrderedState(state)).length > ORDERED_RECEIVE_LIMITS.stateBytes) {
    throw new Error("INVALID_RECEIVE_STATE");
  }

  if (!state.state) return;
  const r = state.state.ratchet;

  if (!counter(r.sendI) || !counter(r.recvI)) throw new Error("INVALID_RATCHET_STATE");

  if (state.state.version === 1) {
    if (!key(state.state.ratchet.ck)) throw new Error("INVALID_RATCHET_STATE");
  } else if (state.state.version === 2) {
    const d = state.state.ratchet;

    if (d.v !== 2 || ![d.rk, d.sendCk, d.recvCk, d.dhSelfPriv, d.dhSelfPub].every(key) ||
      !(d.dhRemotePub === null || key(d.dhRemotePub)) || !["sym", "dh"].includes(d.mode) ||
      (d.pn !== undefined && !counter(d.pn)) || (d.mode === "dh" && !d.dhRemotePub) ||
      encodeBase64Url((await getSodium()).crypto_scalarmult_base(d.dhSelfPriv)) !== encodeBase64Url(d.dhSelfPub)) {
      throw new Error("INVALID_RATCHET_STATE");
    }
  } else throw new Error("INVALID_RATCHET_STATE");
};

/** Disposable-only shared receive/unified owner. Never overwrites legacy secret-store ratchet states. */
export const createExperimentalOrderedTextReceiver = (options: {
  database: NKCVaultDB; vaultKey: Uint8Array; accountId: string; disposableProfile: true;
  unified?: true;
  nativeOutboxOwner?: true;
  access?: VaultAccess;
  checkpoint?: (stage: ReceiveCheckpoint) => Promise<void>; now?: () => number;
}) => {
  const { database: db, accountId } = options;
  const unified = options.unified === true;
  const prefix = unified ? "phase2h:channel:" : "phase2g:receive:";
  const ownerKey = unified ? "phase2h:owner" : "phase2g:owner";
  const recordType = unified ? "unified-ratchet-v1" : "ordered-receive-v1";

  if (options.disposableProfile !== true || !db.name.startsWith(unified ? "nkc-phase2h-" : "nkc-phase2g-") || options.vaultKey.length !== 32 || !accountId) {
    throw new Error("DISPOSABLE_RECEIVE_ONLY");
  }

  const vk = new Uint8Array(options.vaultKey);
  let closed = false;
  let active = 0;
  const assertOpen = () => { if (closed) throw new Error("RECEIVER_CLOSED"); };

  const enter = () => {
    assertOpen();

    if (Dexie.currentTransaction) throw new Error("EXTERNAL_TRANSACTION_FORBIDDEN");

    if (active >= ORDERED_RECEIVE_LIMITS.activeCalls) throw new Error("RECEIVER_BUSY");
    active++;
  };

  const leave = () => { active--;

 if (closed && active === 0) vk.fill(0); };

  const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
    enter();

    try { return await operation(); } finally { leave(); }
  };

  const checkpoint = async (stage: ReceiveCheckpoint) => {
    await options.checkpoint?.(stage); assertOpen();
  };

  const now = options.now ?? Date.now;

  const hash = async (bytes: Uint8Array) => encodeBase64Url((await getSodium()).crypto_generichash(32, bytes));

  const readState = async (key: string, value: string) => {
    const state = decodeOrderedState(await decryptJsonRecord(vk, key, recordType, value));
    await validateOrderedState(state);

    if (unified && !state.state) throw new Error("INVALID_RATCHET_STATE");

    return state;
  };

  const channelKey = async (context: OrderedTextContext) => prefix + await hash(new TextEncoder().encode(JSON.stringify([
    accountId, context.localConversation, context.wireConversation, context.author, encodeBase64Url(context.verifyKey),
  ])));

  const validateContext = (context: OrderedTextContext) => {
    if (![context.accountId, context.localConversation, context.wireConversation, context.author]
      .every((value) => typeof value === "string" && value.length > 0 && value.length <= 256) ||
      ![context.verifyKey, context.baseKey, context.legacyKey].every((value) => value instanceof Uint8Array && value.length === 32)) {
      throw new Error("INVALID_TRUSTED_CONTEXT");
    }
  };

  // Ciphertext tokens are revision tokens: every state/conversation write gets a fresh nonce.
  // Validation and writes share an IDB transaction, including across independent connections/renderers.
  const snapshot = (conversation: string, wireConversation?: string) => db.transaction("r", [db.meta, db.conversations, db.events], async () => {
    assertOpen();
    const owner = await db.meta.get(ownerKey);

    if (owner && owner.value !== accountId) throw new Error("ACCOUNT_MISMATCH");
    const migration = unified ? await db.meta.get("phase2h:migration") : undefined;

    if (migration && !migration.value.startsWith("complete:")) throw new Error("MIGRATION_IN_PROGRESS");

    const binaryHistory = wireConversation && wireConversation !== conversation
      ? await db.events.where("convId").equals(wireConversation)
        .filter(event => event.envelopeFormat === "nkce-v1" && event.localConvId === conversation).count() : 0;

    return { owner, migration, rows: await db.meta.where("key").startsWith(prefix).toArray(),
      conv: await db.conversations.get(conversation), history: wireConversation && options.nativeOutboxOwner
        ? await db.events.where("convId").equals(conversation).filter((event) => {
          // A new experimental text domain never imports or reseeds a legacy control chain.
          const envelope = event.envelopeFormat === "nkce-v1" ? decodeBinaryEnvelopeFrame(event.envelopeBytes)
            : JSON.parse(legacyEventJson(event)) as Envelope;

          return envelope.header.convId === wireConversation;
        }).count()
        : await db.events.where("convId").equals(conversation).count(), binaryHistory };
  });

  const sameRows = (a: MetaRecord[], b: MetaRecord[]) => JSON.stringify(a) === JSON.stringify(b);

  const unchanged = async (before: Awaited<ReturnType<typeof snapshot>>, conversation: string) => {
    assertOpen();

    return (await db.meta.get(ownerKey))?.value === before.owner?.value &&
      (!unified || (await db.meta.get("phase2h:migration"))?.value === before.migration?.value) &&
      sameRows(await db.meta.where("key").startsWith(prefix).toArray(), before.rows) &&
      (await db.conversations.get(conversation))?.enc_b64 === before.conv?.enc_b64;
  };

  const blank = (context: OrderedTextContext): ChannelState => ({ v: 1,
    state: context.seedState && !unified ? structuredClone(context.seedState) : null,
    retained: [], maxLamport: 0, legacySeen: [] });

  const hasCapacity = async (rows: MetaRecord[], key: string, next: ChannelState) => {
    if (!rows.some((row) => row.key === key) && rows.length >= ORDERED_RECEIVE_LIMITS.channelsPerAccount) return false;
    let keys = next.retained.length;

    for (const row of rows) if (row.key !== key) keys += (await readState(row.key, row.value)).retained.length;

    return keys <= ORDERED_RECEIVE_LIMITS.keysPerAccount && JSON.stringify(encodeOrderedState(next)).length <= ORDERED_RECEIVE_LIMITS.stateBytes;
  };

  // Only test hooks use waitFor. Normal transactions contain IDB requests only, never crypto/network awaits.
  const transactionCheckpoint = async (stage: ReceiveCheckpoint) => {
    if (options.checkpoint) await Dexie.waitFor(checkpoint(stage));
    assertOpen();
  };

  type SendRequest = { eventId: string; author: string; signKey: Uint8Array; text: string; lamport: number; ts: number; version: 1 | 2;
    nativeRoute?: { accountId: string; friendId: string; onionAddress: string; inboxWriteToken: string };
    persistence?: { format: "nkcp-v2"; session: { id: string; meta: MetaRecord }; replyRoute: NonNullable<TransportPacket["replyRoute"]> }; };

  function sendText(context: OrderedTextContext, request: SendRequest & { persistence: NonNullable<SendRequest["persistence"]> }): Promise<{ envelope: EnvelopeBytes; reused: boolean }>;
  function sendText(context: OrderedTextContext, request: SendRequest & { persistence?: undefined }): Promise<{ envelope: Envelope; reused: boolean }>;
  function sendText(context: OrderedTextContext, request: SendRequest): Promise<{ envelope: Envelope | EnvelopeBytes; reused: boolean }> { return owned(async () => {
      if (!unified) throw new Error("UNIFIED_DISPOSABLE_ONLY");

      if (context.accountId !== accountId) throw new Error("ACCOUNT_MISMATCH");
      validateContext(context);

      if (context.seedState) throw new Error("MIGRATION_REQUIRED");
      context = structuredClone(context); request = structuredClone(request);

      if (![request.eventId, request.author].every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) ||
        !Number.isSafeInteger(request.lamport) || request.lamport < 1 || !Number.isSafeInteger(request.ts) || request.ts < 0 ||
        typeof request.text !== "string" || new TextEncoder().encode(request.text).length > ORDERED_RECEIVE_LIMITS.textBytes ||
        ![1, 2].includes(request.version)) throw new Error("INVALID_SEND_REQUEST");
      const binary = request.persistence;
      const access = options.access;

      if (binary) {
        if (request.eventId.length > 128 || binary.format !== "nkcp-v2" || options.nativeOutboxOwner || !access || access.db !== db ||
            access.accountId !== accountId || access.session.accountId !== accountId || !samePayloadBytes(access.key, vk) ||
            binary.replyRoute.toDeviceId !== request.author || binary.replyRoute.sentAt !== request.ts ||
            !binary.session.id || binary.session.meta.key !== "fresh_session_v1:" + context.wireConversation) throw new Error("BINARY_PERSISTENCE_AUTHORITY_REQUIRED");
        await access.assertMain();
        access.assertLocal();
        const storedSession: unknown = JSON.parse(binary.session.meta.value);

        if (!storedSession || typeof storedSession !== "object" || !("id" in storedSession) ||
            storedSession.id !== binary.session.id || "rollbackSuspected" in storedSession && storedSession.rollbackSuspected) throw new Error("OWNER_SESSION_CHANGED");

        if ((await db.meta.get(binary.session.meta.key))?.value !== binary.session.meta.value) throw new Error("OWNER_SESSION_CHANGED");
      }

      const sodium = await getSodium();
      const identity = `${request.author}:${encodeBase64Url(sodium.crypto_sign_ed25519_sk_to_pk(request.signKey))}`;
      const key = await channelKey(context);
      const requestKey = `phase2h:outbound:${request.eventId}`;

      const requestMaterial = [key, identity, request.text, request.lamport, request.ts, request.version,
        ...(request.nativeRoute ? [request.nativeRoute] : []), ...(binary ? [binary] : [])];

      const requestHash = await hash(binary ? canonicalBytes(requestMaterial) : new TextEncoder().encode(JSON.stringify(requestMaterial)));

      if (options.nativeOutboxOwner && (!request.nativeRoute || request.nativeRoute.accountId !== accountId)) {
        throw new Error("NATIVE_ROUTE_REQUIRED");
      }

      for (let attempt = 0; attempt < 8; attempt++) {
        const before = await snapshot(context.localConversation, context.wireConversation);
        const previous = await db.outbox.get(request.eventId);

        if (previous) {
          const tag = await db.meta.get(requestKey);

          if (!tag || previous.convId !== context.localConversation) throw new Error("OUTBOX_CONFLICT");
          const admission = await decryptJsonRecord<{ hash: string; packetHash: string }>(vk, requestKey, "unified-outbox-v1", tag.value);
          const storedEvent = await db.events.get(request.eventId);

          if (Boolean(binary) !== (previous.payloadFormat === "nkcp-v2")) throw new Error("OUTBOX_CONFLICT");
          let packet: Envelope | EnvelopeBytes;

          if (binary) {
            if (!storedEvent || previous.payloadFormat !== "nkcp-v2") throw new Error("OUTBOX_CONFLICT");

            if (previous.status === "expired" || previous.lastError === "LOCAL_SOURCE_CANCELLED" ||
                previous.lastError === "SESSION_SUPERSEDED") throw new Error("APPLICATION_CANCELLED");
            const restored = validateBinaryEventOutbox(storedEvent, previous);

            if (previous.ownerAccountId !== accountId || previous.nativeRetryId !== await computeBinaryRetryId(previous.payloadBytes) ||
                previous.recipientIdentityPub !== encodeBase64Url(context.verifyKey) ||
                !samePayloadBytes(canonicalBytes(restored.packet.replyRoute), canonicalBytes(binary.replyRoute)) ||
                restored.envelope.header.friendSessionId !== binary.session.id) throw new Error("OUTBOX_CONFLICT");
            packet = restored.envelope;
          } else packet = JSON.parse(legacyOutboxCiphertext(previous)) as Envelope;

          if (admission.hash !== requestHash || packet.header.eventId !== request.eventId || packet.header.authorDeviceId !== request.author ||
            packet.header.convId !== context.wireConversation || await computeEnvelopeHash(packet) !== admission.packetHash ||
            !await verifyEnvelopeSignature(packet, sodium.crypto_sign_ed25519_sk_to_pk(request.signKey))) throw new Error("OUTBOX_CONFLICT");
          const event = await db.events.get(request.eventId); const message = await db.messages.get(request.eventId);

          if (!event || !message || event.eventHash !== admission.packetHash || message.convId !== context.localConversation) {
            throw new Error("STORED_EVENT_REPAIR_REQUIRED");
          }

          if (!binary) legacyEventJson(event);

          if (binary) {
            if (!access || !storedEvent || storedEvent.envelopeFormat !== "nkce-v1") throw new Error("BINARY_PERSISTENCE_AUTHORITY_REQUIRED");
            await checkpoint("reuse_prepared");
            await writeVault(access, [db.meta, db.outbox, db.events, db.messages], async () => {
              const current = await db.outbox.get(previous.id), currentEvent = await db.events.get(storedEvent.eventId);

              if (!current || !sameOutboxPayload(current, previous) || current.ownerAccountId !== previous.ownerAccountId ||
                  current.recipientIdentityPub !== previous.recipientIdentityPub || current.status !== previous.status || current.lastError !== previous.lastError ||
                  currentEvent?.envelopeFormat !== "nkce-v1" || !samePayloadBytes(currentEvent.envelopeBytes, storedEvent.envelopeBytes) ||
                  currentEvent.eventHash !== storedEvent.eventHash || !sameStoredCiphertext((await db.messages.get(message.id))?.enc_b64, message.enc_b64) ||
                  (await db.meta.get(requestKey))?.value !== tag.value ||
                  (await db.meta.get(binary.session.meta.key))?.value !== binary.session.meta.value) throw new Error("OUTBOX_CONFLICT");
              validateBinaryEventOutbox(currentEvent, current);

              if (current.convId !== previous.convId || currentEvent.localConvId !== storedEvent.localConvId) throw new Error("OUTBOX_CONFLICT");
            });
          }

          return { envelope: packet, reused: true };
        }

        const raw = before.rows.find((row) => row.key === key);

        if (!raw && (before.history || before.binaryHistory)) throw new Error("MIGRATION_REQUIRED");
        const current = raw ? await readState(key, raw.value) : blank(context);

        if (current.localIdentity && current.localIdentity !== identity) throw new Error("LOCAL_IDENTITY_MISMATCH");
        const sendLamport = Math.max(request.lamport, (current.sendLamport ?? 0) + 1, current.maxLamport + 1);

        if (!Number.isSafeInteger(sendLamport)) throw new Error("SEND_LAMPORT_EXHAUSTED");

        const state = current.state ?? (request.version === 1
          ? { version: 1 as const, ratchet: await createReceiveStateV1(context.baseKey) }
          : { version: 2 as const, ratchet: await createReceiveStateV2(context.baseKey) });

        if (state.version !== request.version) throw new Error("RATCHET_VERSION_MISMATCH");

        // v1 has one shared chain, not independent directional chains. Never pretend to unify a bidirectional v1 channel.
        if (state.version === 1 && state.ratchet.recvI > 0) throw new Error("V1_BIDIRECTIONAL_UNSUPPORTED");
        const prepared = state.version === 1 ? await prepareSendKey(state.ratchet) : await prepareSendDhKey(state.ratchet);

        try {
          const header = { v: 1 as const, convId: context.wireConversation, eventId: request.eventId,
            authorDeviceId: request.author, lamport: sendLamport, ts: request.ts, rk: prepared.headerRk };

          const body = { type: "msg", text: request.text };
          let envelope: Envelope | EnvelopeBytes;
          let envelopeBytes: Uint8Array | undefined;

          if (binary) {
            const rawEnvelope = await encryptEnvelopeBytes(prepared.msgKey,
              { ...header, friendSessionId: binary.session.id, bodyCodec: "canonical-json-v1" }, canonicalBytes(body), request.signKey);

            envelope = rawEnvelope;
            envelopeBytes = encodeBinaryEnvelopeFrame(rawEnvelope);
          } else envelope = await encryptEnvelope(prepared.msgKey, header, body, request.signKey);

          const payloadBytes = envelopeBytes ? encodeBinaryTransportPacket({ id: request.eventId,
            payload: envelopeBytes, replyRoute: binary?.replyRoute }, 2) : undefined;

          if (binary && (!envelopeBytes || !payloadBytes)) throw new Error("BINARY_PACKET_REQUIRED");

          if ((envelopeBytes?.length ?? JSON.stringify(envelope).length) > ORDERED_RECEIVE_LIMITS.envelopeBytes) throw new Error("SEND_CAPACITY");
          const nativeRetryId = payloadBytes ? await computeBinaryRetryId(payloadBytes) : undefined;

          const next: ChannelState = { ...current, localIdentity: identity, sendLamport,
            state: prepared.headerRk.v === 1
              ? { version: 1, ratchet: prepared.nextState as Awaited<ReturnType<typeof prepareSendKey>>["nextState"] }
              : { version: 2, ratchet: prepared.nextState as Awaited<ReturnType<typeof prepareSendDhKey>>["nextState"] } };

          await validateOrderedState(next);

          if (!await hasCapacity(before.rows, key, next)) throw new Error("STATE_CAPACITY");

          if (!before.conv) throw new Error("CONVERSATION_MISSING");
          const conv = await decryptJsonRecord<Conversation>(vk, before.conv.id, "conv", before.conv.enc_b64);
          const built = buildReceivedText(conv, envelope, request.text, context.localSenderId ?? request.author, false, request.ts >= conv.lastTs);
          const eventHash = await computeEnvelopeHash(envelope);

          const encrypted = await Promise.all([
            encryptJsonRecord(vk, key, recordType, encodeOrderedState(next)),
            encryptJsonRecord(vk, requestKey, "unified-outbox-v1", { hash: requestHash, packetHash: eventHash }),
            encryptJsonRecord(vk, built.message.id, "message", built.message, binary ? "raw-v3" : undefined),
            encryptJsonRecord(vk, conv.id, "conv", built.conversation),
          ]);

          const nativeRoute_enc = request.nativeRoute
            ? await encryptJsonRecord(vk, request.eventId, "native-handoff-v1", request.nativeRoute) : undefined;

          const outbox: OutboxRecord = { id: request.eventId, convId: conv.id,
            ...(payloadBytes && nativeRetryId ? { payloadFormat: "nkcp-v2", payloadBytes, nativeRetryId,
              ownerAccountId: accountId, recipientIdentityPub: encodeBase64Url(context.verifyKey) } : { ciphertext: JSON.stringify(envelope) }),
            createdAtMs: now(), expiresAtMs: now() + 7 * 86400_000, nextAttemptAtMs: now(), attempts: 0,
            status: binary || options.nativeOutboxOwner ? "prepared" : "pending", nativeRoute_enc };

          const event: EventRecord = { eventId: request.eventId, convId: binary ? context.wireConversation : conv.id,

            authorDeviceId: request.author, lamport: sendLamport, ts: request.ts, eventHash,
            ...(envelopeBytes ? { envelopeFormat: "nkce-v1", envelopeBytes, localConvId: conv.id } : { envelopeJson: JSON.stringify(envelope) }) };

          if (binary) {
            const decoded = validateBinaryEventOutbox(event, outbox).envelope;

            if (await computeEnvelopeHash(decoded) !== eventHash ||
                !await verifyEnvelopeSignature(decoded, sodium.crypto_sign_ed25519_sk_to_pk(request.signKey))) throw new Error("BINARY_PRECOMMIT_VALIDATION_FAILED");
          }

          await checkpoint("send_prepared");

          const commit = async () => {
            if (binary && (await db.meta.get(binary.session.meta.key))?.value !== binary.session.meta.value) throw new Error("OWNER_SESSION_CHANGED");

            if (!await unchanged(before, context.localConversation) || await db.outbox.get(request.eventId)) return false;

            if (await db.events.get(request.eventId) || await db.meta.get(requestKey)) throw new Error("OUTBOX_CONFLICT");

            if (await db.outbox.count() >= 1000) throw new Error("OUTBOX_CAPACITY");
            await db.meta.put({ key: ownerKey, value: accountId });
            await db.meta.put({ key, value: encrypted[0] });
            await transactionCheckpoint("ratchet_written");
            await db.outbox.add(outbox);
            await db.meta.put({ key: requestKey, value: encrypted[1] });
            await transactionCheckpoint("outbox_written");
            await db.events.add(event);
            await transactionCheckpoint("event_written");
            await db.messages.add({ id: built.message.id, convId: conv.id, ts: request.ts, enc_b64: encrypted[2] });
            await db.conversations.put({ id: conv.id, updatedAt: now(), enc_b64: encrypted[3] });
            await transactionCheckpoint("message_written");

            return true;
          };

          const tables = [db.meta, db.outbox, db.events, db.messages, db.conversations];
          const committed = binary ? await writeVault(access, tables, commit) : await db.transaction("rw", tables, commit);

          if (!committed) continue;
          await checkpoint("before_return");

          return { envelope, reused: false };
        } finally { prepared.msgKey.fill(0); }
      }

      throw new Error("STATE_CONTENTION");
    }); }

  return {
    close: () => { closed = true;

 if (active === 0) vk.fill(0); },
    /** No network or legacy store calls. The returned packet already has durable outbox ownership. */
    sendText,
    pruneExpired: () => owned(async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const before = await snapshot("");
        let removed = 0;
        const updates: MetaRecord[] = [];

        for (const row of before.rows) {
          const state = await readState(row.key, row.value);
          const expired = state.retained.filter((item) => item.expiresAt <= now());

          if (!expired.length) continue;
          state.retained = state.retained.filter((item) => item.expiresAt > now());
          expired.forEach((item) => item.key.fill(0)); removed += expired.length;
          updates.push({ key: row.key, value: await encryptJsonRecord(vk, row.key, recordType, encodeOrderedState(state)) });
        }

        const committed = await db.transaction("rw", [db.meta, db.conversations], async () => {
          if (!await unchanged(before, "")) return false;
          await db.meta.bulkPut(updates);

 return true;
        });

        if (committed) return removed;
      }

      throw new Error("STATE_CONTENTION");
    }),
    receive: (context: OrderedTextContext, envelope: Envelope | EnvelopeBytes, outer: OuterEvent = envelope.header,
      binarySession?: { id: string; meta: MetaRecord }) => owned(async () => {
      if (context.accountId !== accountId) throw new Error("ACCOUNT_MISMATCH");
      validateContext(context);

      const binaryBytes = isEnvelopeLike(envelope) ? undefined : encodeBinaryEnvelopeFrame(envelope);

      if ((binaryBytes?.byteLength ?? JSON.stringify(envelope).length) > ORDERED_RECEIVE_LIMITS.envelopeBytes) return { outcome: "outside_window" as const };
      context = structuredClone(context); envelope = structuredClone(envelope); outer = { ...outer };
      const h = envelope.header;

      if (binaryBytes) {
        if (!unified || !options.access || options.access.db !== db || options.access.accountId !== accountId ||
            !samePayloadBytes(options.access.key, vk) || !binarySession || typeof binarySession.id !== "string" ||
            !binarySession.id || binarySession.id.length > 256 || binarySession.meta.key !== "fresh_session_v1:" + context.wireConversation ||
            h.bodyCodec !== "canonical-json-v1" || h.rk?.v !== 2 || h.friendSessionId !== binarySession.id || h.deviceDelivery) {
          throw new Error("BINARY_RECEIVE_AUTHORITY_REQUIRED");
        }

        binarySession = structuredClone(binarySession);
        const session: unknown = JSON.parse(binarySession.meta.value);

        if (!session || typeof session !== "object" || !("id" in session) || session.id !== binarySession.id ||
            "rollbackSuspected" in session && session.rollbackSuspected ||
            (await db.meta.get(binarySession.meta.key))?.value !== binarySession.meta.value) throw new Error("OWNER_SESSION_CHANGED");
        await options.access.assertMain();
      }

      if (!h || h.v !== 1 || typeof h.eventId !== "string" || h.convId !== context.wireConversation || h.authorDeviceId !== context.author ||
        !h.eventId || !Number.isSafeInteger(h.lamport) || h.lamport < 1 || !Number.isSafeInteger(h.ts) || h.ts < 0 ||
        h.eventId.length > 256 || h.convId.length > 256 || h.authorDeviceId.length > 256 ||
        outer.eventId !== h.eventId || outer.convId !== h.convId || outer.authorDeviceId !== h.authorDeviceId ||
        outer.lamport !== h.lamport || outer.ts !== h.ts) {
        return { outcome: "metadata_mismatch" as const };
      }

      if (!await verifyEnvelopeSignature(envelope, context.verifyKey)) return { outcome: "invalid_signature" as const };

      if (unified && !h.rk) throw new Error("UNIFIED_RATCHET_REQUIRED");

      if (unified && context.seedState) throw new Error("MIGRATION_REQUIRED");
      const key = await channelKey(context);
      const eventHash = await computeEnvelopeHash(envelope);

      for (let attempt = 0; attempt < 8; attempt++) {
        const before = await snapshot(context.localConversation, context.wireConversation);
        const existing = await db.events.get(h.eventId);

        if (existing) {
          if (existing.eventHash !== eventHash || existing.convId !== (binaryBytes ? context.wireConversation : context.localConversation) ||
              binaryBytes && (existing.localConvId !== context.localConversation || existing.envelopeFormat !== "nkce-v1" ||
                !samePayloadBytes(existing.envelopeBytes, binaryBytes))) return { outcome: "event_conflict" as const };
          const message = await db.messages.get(h.eventId);

          if (!message || message.convId !== context.localConversation) throw new Error("STORED_EVENT_REPAIR_REQUIRED");

          return { outcome: "duplicate" as const };
        }

        const raw = before.rows.find((row) => row.key === key);

        if (!raw && (unified || !before.owner) && (before.history || before.binaryHistory)) {
          // Starting a fresh chain over a populated historical channel is not migration.
          throw new Error("MIGRATION_REQUIRED");
        }

        const current: ChannelState = raw ? await readState(key, raw.value) : blank(context);

        if (unified && current.state?.version === 1 && current.state.ratchet.sendI > 0) throw new Error("V1_BIDIRECTIONAL_UNSUPPORTED");

        if (current.v !== 1 || current.retained.length > 50 || new Set(current.retained.map((item) => item.chain)).size > 4) {
          throw new Error("INVALID_RECEIVE_STATE");
        }

        let body: unknown;

        const authenticated = async (messageKey: Uint8Array) => {
          body = isEnvelopeLike(envelope) ? await decryptEnvelope<unknown>(messageKey, envelope, context.verifyKey)
            : parseCanonicalBytes(await decryptEnvelopeBytes(messageKey, envelope, context.verifyKey, "canonical-json-v1"));
        };

        let next = structuredClone(current);

        const prepared = await (async () => {
          if (h.rk) {
            if (!current.state) current.state = h.rk.v === 1
              ? { version: 1, ratchet: await createReceiveStateV1(context.baseKey) }
              : { version: 2, ratchet: await createReceiveStateV2(context.baseKey) };
            const result = await prepareOrderedReceive(current.state, h.rk, current.retained, now(), authenticated);

            if ("deferred" in result) return false;
            next = { ...next, state: result.state, retained: result.retained };
          } else {
            if (current.state) return false; // Reject a downgrade of an established ratchet channel.
            await authenticated(context.legacyKey);
          }

          return true;
        })();

        if (!prepared) return { outcome: "outside_window" as const };
        await checkpoint("authenticated");

        if (!body || typeof body !== "object" || !("type" in body) || body.type !== "msg" ||
            !("text" in body) || typeof body.text !== "string" || "media" in body && body.media !== undefined) return { outcome: "unsupported_control" as const };

        if (new TextEncoder().encode(body.text).length > ORDERED_RECEIVE_LIMITS.textBytes) return { outcome: "outside_window" as const };

        if (h.lamport <= current.maxLamport - ORDERED_RECEIVE_LIMITS.lamportWindow || current.legacySeen.includes(h.lamport)) {
          return { outcome: "replay_or_outside_window" as const };
        }

        next.maxLamport = Math.max(current.maxLamport, h.lamport);
        next.legacySeen = [...current.legacySeen.filter((i) => i > next.maxLamport - 128), h.lamport];
        next.retained = next.retained.filter((item) => item.expiresAt > now());
        await validateOrderedState(next);

        if (!await hasCapacity(before.rows, key, next)) return { outcome: "capacity" as const };
        const encoded = encodeOrderedState(next);
        const storedConv = before.conv;

        if (!storedConv) throw new Error("CONVERSATION_MISSING");
        const conv = await decryptJsonRecord<Conversation>(vk, storedConv.id, "conv", storedConv.enc_b64);

        const built = buildReceivedText(conv, envelope, body.text, context.peerSenderId ?? context.author, false,
          h.lamport >= current.maxLamport && h.ts >= conv.lastTs);

        const encrypted = await Promise.all([
          encryptJsonRecord(vk, key, recordType, encoded),
          encryptJsonRecord(vk, built.message.id, "message", built.message, binaryBytes ? "raw-v3" : undefined),
          encryptJsonRecord(vk, conv.id, "conv", built.conversation),
        ]);

        const commit = async () => {
          if (!await unchanged(before, context.localConversation) || await db.events.get(h.eventId)) return false;

          if (binarySession && (await db.meta.get(binarySession.meta.key))?.value !== binarySession.meta.value) throw new Error("OWNER_SESSION_CHANGED");
          await db.meta.put({ key: ownerKey, value: accountId });
          await db.meta.put({ key, value: encrypted[0] });
          await transactionCheckpoint("ratchet_written");
          await db.events.add({ eventId: h.eventId, convId: binaryBytes ? context.wireConversation : context.localConversation, authorDeviceId: h.authorDeviceId,
            lamport: h.lamport, ts: h.ts, prevHash: h.prev, eventHash,
            ...(binaryBytes ? { envelopeFormat: "nkce-v1", envelopeBytes: binaryBytes, localConvId: context.localConversation,
              applicationCryptoCommitted: true, applicationState: "stored", bodyType: "msg", ratchetVersion: 2 } : { envelopeJson: JSON.stringify(envelope) }) });
          await transactionCheckpoint("event_written");
          await db.messages.add({ id: built.message.id, convId: conv.id, ts: h.ts, enc_b64: encrypted[1] });
          await db.conversations.put({ id: conv.id, updatedAt: now(), enc_b64: encrypted[2] });
          await transactionCheckpoint("message_written");

          return true;
        };

        const tables = [db.meta, db.events, db.messages, db.conversations];
        const committed = binaryBytes ? await writeVault(options.access, tables, commit) : await db.transaction("rw", tables, commit);

        if (!committed) continue;
        // No new receipt protocol. This is the local completion boundary only.
        await checkpoint("before_return");

        return { outcome: "stored" as const };
      }

      throw new Error("STATE_CONTENTION");
    }),
  };
};

/** Same implementation and encrypted state; no parallel sender/receiver store. */
export const createExperimentalUnifiedRatchetManager = (
  options: Omit<Parameters<typeof createExperimentalOrderedTextReceiver>[0], "unified">,
) => createExperimentalOrderedTextReceiver({ ...options, unified: true });

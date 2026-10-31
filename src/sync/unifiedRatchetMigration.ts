import { legacyEventJson } from "../storage/storedPayload";
import type { NKCVaultDB, EventRecord, OutboxRecord } from "../db/schema";
import Dexie from "dexie";
import type { Conversation, Message } from "../db/repo";
import { encryptJsonRecord, decryptJsonRecord } from "../crypto/vault";
import { computeEnvelopeHash, verifyEnvelopeSignature, type Envelope } from "../crypto/box";
import { getSodium } from "../security/sodium";
import { encodeBase64Url, decodeBase64Url } from "../security/base64url";
import { decodeOrderedState, encodeOrderedState, validateOrderedState, type ChannelState } from "./orderedTextReceiver";

export type MigrationStage = "owner_frozen" | "quiesced" | "validated" | "copied" | "verified" | "activated" | "source_finalized";

export type FrozenRatchetSnapshot = {
  version: 1; accountId: string;
  channels: Array<{ key: string; state: ChannelState }>;
  events: EventRecord[]; messages: Message[]; conversations: Conversation[]; outbox: OutboxRecord[];
  outbound: Array<{ key: string; hash: string; packetHash: string }>;
  identities: Array<{ author: string; verifyKey: Uint8Array }>;
};

const encode = (value: unknown) => JSON.parse(JSON.stringify(value,
  (_key, item) => item instanceof Uint8Array ? { bytes: encodeBase64Url(item) } : item));

/** Fence the ACTUAL experimental owner before exporting. In-flight CAS commits observe this fence and abort. */
export const freezeDisposableRatchetOwner = async (source: NKCVaultDB, destination: string, accountId: string) => {
  if (!source.name.startsWith("nkc-phase2h-") || !destination.startsWith("nkc-phase2h-import-") || source.name === destination ||
    Dexie.currentTransaction) throw new Error("DISPOSABLE_MIGRATION_ONLY");

  return source.transaction("rw", [source.meta, source.events, source.messages, source.conversations, source.outbox], async () => {
    if ((await source.meta.get("phase2h:owner"))?.value !== accountId) throw new Error("ACCOUNT_MISMATCH");
    const fence = await source.meta.get("phase2h:migration");

    if (fence && fence.value !== `retired:${destination}`) throw new Error("MIGRATION_CONFLICT");
    await source.meta.put({ key: "phase2h:migration", value: `retired:${destination}` });

    return { meta: await source.meta.toArray(), events: await source.events.toArray(), messages: await source.messages.toArray(),
      conversations: await source.conversations.toArray(), outbox: await source.outbox.toArray() };
  });
};

/** A cooperating synthetic legacy writer. Fence check and write cannot race with quiescence. */
export const writeDisposableLegacySnapshot = async (source: NKCVaultDB, encrypted: string) => {
  if (!source.name.startsWith("nkc-phase2h-source-")) throw new Error("DISPOSABLE_MIGRATION_ONLY");
  await source.transaction("rw", source.meta, async () => {
    if (await source.meta.get("legacy:fence")) throw new Error("LEGACY_OWNER_RETIRED");
    await source.meta.put({ key: "legacy:snapshot", value: encrypted });
  });
};

/** Strict decoder of existing secret-store JSON. Caller must supply frozen replay/history/outbox separately. */
export const parseFrozenLegacyRatchet = async (version: 1 | 2, raw: string | null) => {
  if (!raw) throw new Error("MIGRATION_SOURCE_MISSING");
  const value = JSON.parse(raw);

  const bytes = (name: string) => {
    if (typeof value[name] !== "string") throw new Error("INVALID_RATCHET_STATE");

    return decodeBase64Url(value[name]);
  };

  const state: ChannelState = { v: 1, maxLamport: 0, legacySeen: [], retained: [], state: version === 1
    ? { version: 1, ratchet: { ck: bytes("ck"), sendI: value.sendI, recvI: value.recvI } }
    : { version: 2, ratchet: { v: value.v, rk: bytes("rk"), sendCk: bytes("sendCk"), recvCk: bytes("recvCk"),
      dhSelfPriv: bytes("dhSelfPriv"), dhSelfPub: bytes("dhSelfPub"), dhRemotePub: value.dhRemotePub ? bytes("dhRemotePub") : null,
      sendI: value.sendI, recvI: value.recvI, pn: value.pn, mode: value.mode ?? "sym" } } };

  await validateOrderedState(state);

  return state.state!;
};

/** Synthetic encrypted source adapter only. Deployed old secret-store writers cannot be fenced by this marker. */
export const migrateDisposableRatchet = async (options: {
  source: NKCVaultDB; target: NKCVaultDB; vaultKey: Uint8Array; accountId: string; disposableProfile: true;
  checkpoint?: (stage: MigrationStage) => Promise<void>;
}) => {
  const { source, target, accountId, vaultKey: vk } = options;

  if (Dexie.currentTransaction) throw new Error("EXTERNAL_TRANSACTION_FORBIDDEN");

  if (options.disposableProfile !== true || !source.name.startsWith("nkc-phase2h-source-") ||
    !target.name.startsWith("nkc-phase2h-") || target.name.startsWith("nkc-phase2h-source-") || vk.length !== 32 || !accountId) {
    throw new Error("DISPOSABLE_MIGRATION_ONLY");
  }

  const checkpoint = async (stage: MigrationStage) => options.checkpoint?.(stage);

  // Source writers must check this fence in the SAME source transaction as every write.
  const encrypted = await source.transaction("rw", source.meta, async () => {
    const row = await source.meta.get("legacy:snapshot");

    if (!row) throw new Error("MIGRATION_SOURCE_MISSING");
    const fence = await source.meta.get("legacy:fence");

    if (fence && fence.value !== target.name) throw new Error("MIGRATION_DESTINATION_CONFLICT");
    await source.meta.put({ key: "legacy:fence", value: target.name });

    if (row.value.length > 12 * 1024 * 1024) throw new Error("MIGRATION_SOURCE_CAPACITY");

    return row.value;
  });

  await checkpoint("quiesced");
  const snapshot = decodeOrderedState(await decryptJsonRecord(vk, "legacy:snapshot", "migration-source-v1", encrypted)) as unknown as FrozenRatchetSnapshot;

  if ([snapshot.events, snapshot.messages, snapshot.conversations, snapshot.outbox, snapshot.outbound, snapshot.identities]
    .some((rows) => !Array.isArray(rows) || rows.length > 10000)) throw new Error("INVALID_MIGRATION_SOURCE");

  if (snapshot.version !== 1 || snapshot.accountId !== accountId || !Array.isArray(snapshot.channels) || !snapshot.channels.length ||
    snapshot.channels.length > 64 || snapshot.outbox.length > 1000 || snapshot.channels.reduce((n, item) => n + item.state.retained.length, 0) > 512) {
    throw new Error("INVALID_MIGRATION_SOURCE");
  }

  const unique = (ids: string[]) => new Set(ids).size === ids.length;

  if (!unique(snapshot.channels.map((item) => item.key)) || !unique(snapshot.events.map((item) => item.eventId)) ||
    !unique(snapshot.messages.map((item) => item.id)) || !unique(snapshot.outbox.map((item) => item.id)) ||
    !unique(snapshot.conversations.map((item) => item.id))) throw new Error("INVALID_MIGRATION_SOURCE");

  for (const channel of snapshot.channels) {
    if (!channel.key.startsWith("phase2h:channel:") || !channel.state.state) throw new Error("INVALID_MIGRATION_SOURCE");
    await validateOrderedState(channel.state);
  }

  for (const event of snapshot.events) {
    const envelope: Envelope = JSON.parse(legacyEventJson(event));
    const identity = snapshot.identities.find((item) => item.author === envelope.header.authorDeviceId);

    if (!identity || !await verifyEnvelopeSignature(envelope, identity.verifyKey) ||
      await computeEnvelopeHash(envelope) !== event.eventHash || event.eventId !== envelope.header.eventId ||
      event.lamport !== envelope.header.lamport || event.authorDeviceId !== envelope.header.authorDeviceId || event.ts !== envelope.header.ts ||
      !snapshot.messages.some((item) => item.id === event.eventId && item.convId === event.convId)) throw new Error("MIGRATION_REPAIR_REQUIRED");
  }

  for (const row of snapshot.outbox) {
    const event = snapshot.events.find((item) => item.eventId === row.id);

    if (!event || row.ciphertext !== event.envelopeJson || row.convId !== event.convId ||
      !snapshot.outbound.some((item) => item.key === `phase2h:outbound:${row.id}` && item.packetHash === event.eventHash)) throw new Error("MIGRATION_REPAIR_REQUIRED");
  }

  for (const message of snapshot.messages) if (!snapshot.events.some((item) => item.eventId === message.id) ||
    !snapshot.conversations.some((item) => item.id === message.convId)) throw new Error("MIGRATION_REPAIR_REQUIRED");
  const digest = encodeBase64Url((await getSodium()).crypto_generichash(32, new TextEncoder().encode(JSON.stringify(encode(snapshot)))));
  await checkpoint("validated");

  // Immutable crypto candidates outside either store's transactions; old source remains encrypted and fenced.
  const channels = await Promise.all(snapshot.channels.map(async (item) => ({ key: item.key,
    value: await encryptJsonRecord(vk, item.key, "unified-ratchet-v1", encodeOrderedState(item.state)) })));

  const tags = await Promise.all(snapshot.outbound.map(async (item) => ({ key: item.key,
    value: await encryptJsonRecord(vk, item.key, "unified-outbox-v1", { hash: item.hash, packetHash: item.packetHash }) })));

  const messages = await Promise.all(snapshot.messages.map(async (item) => ({ id: item.id, convId: item.convId, ts: item.ts,
    enc_b64: await encryptJsonRecord(vk, item.id, "message", item) })));

  const conversations = await Promise.all(snapshot.conversations.map(async (item) => ({ id: item.id, updatedAt: item.lastTs,
    enc_b64: await encryptJsonRecord(vk, item.id, "conv", item) })));

  await target.transaction("rw", [target.meta, target.outbox, target.events, target.messages, target.conversations], async () => {
    const phase = await target.meta.get("phase2h:migration");

    if (phase) {
      if (!["copied:", "complete:"].some((prefix) => phase.value === prefix + digest)) throw new Error("MIGRATION_CONFLICT");

      return;
    }

    if (await target.meta.count() || await target.events.count() || await target.messages.count() || await target.conversations.count() ||
      await target.outbox.count()) throw new Error("MIGRATION_TARGET_NOT_EMPTY");
    await target.meta.bulkAdd([...channels, ...tags, { key: "phase2h:owner", value: accountId },
      { key: "phase2h:migration", value: `copied:${digest}` }]);
    await target.events.bulkAdd(snapshot.events); await target.messages.bulkAdd(messages); await target.conversations.bulkAdd(conversations);
    // Ownership is transferred without creating another ciphertext or changing a retry counter.
    await target.outbox.bulkAdd(snapshot.outbox);
  });
  await checkpoint("copied");
  // On resume after activation the new owner may already have progressed. NEVER re-import an old snapshot.
  const phase = await target.meta.get("phase2h:migration");

  if (phase?.value !== `complete:${digest}`) {
    const rows = await target.transaction("r", [target.meta, target.messages, target.conversations, target.events, target.outbox], async () => ({
      channels: await target.meta.where("key").startsWith("phase2h:channel:").toArray(),
      tags: await target.meta.where("key").startsWith("phase2h:outbound:").toArray(),
      messages: await target.messages.toArray(), conversations: await target.conversations.toArray(),
      events: await target.events.toArray(), outbox: await target.outbox.toArray(),
    }));

    const restored: FrozenRatchetSnapshot = { ...snapshot,
      channels: await Promise.all(rows.channels.map(async (item) => ({ key: item.key,
        state: decodeOrderedState(await decryptJsonRecord(vk, item.key, "unified-ratchet-v1", item.value)) }))),
      outbound: await Promise.all(rows.tags.map(async (item) => ({ key: item.key,
        ...await decryptJsonRecord<{ hash: string; packetHash: string }>(vk, item.key, "unified-outbox-v1", item.value) }))),
      messages: await Promise.all(rows.messages.map((item) => decryptJsonRecord<Message>(vk, item.id, "message", item.enc_b64))),
      conversations: await Promise.all(rows.conversations.map((item) => decryptJsonRecord<Conversation>(vk, item.id, "conv", item.enc_b64))),
      events: rows.events, outbox: rows.outbox };

    // Table order is key order, not export order. Canonicalize collections before comparing full copies.
    const canonical = (value: FrozenRatchetSnapshot) => JSON.stringify(encode({ ...value,
      channels: [...value.channels].sort((a,b) => a.key.localeCompare(b.key)), outbound: [...value.outbound].sort((a,b) => a.key.localeCompare(b.key)),
      events: [...value.events].sort((a,b) => a.eventId.localeCompare(b.eventId)), messages: [...value.messages].sort((a,b) => a.id.localeCompare(b.id)),
      conversations: [...value.conversations].sort((a,b) => a.id.localeCompare(b.id)), outbox: [...value.outbox].sort((a,b) => a.id.localeCompare(b.id)) }));

    if (canonical(restored) !== canonical(snapshot)) throw new Error("MIGRATION_COPY_MISMATCH");
    await checkpoint("verified");
    await target.transaction("rw", target.meta, async () => {
      if ((await target.meta.get("phase2h:migration"))?.value !== `copied:${digest}`) throw new Error("MIGRATION_CONFLICT");
      await target.meta.put({ key: "phase2h:migration", value: `complete:${digest}` });
    });
  }

  await checkpoint("activated");
  await source.transaction("rw", source.meta, async () => {
    if ((await source.meta.get("legacy:fence"))?.value !== target.name || (await source.meta.get("legacy:snapshot"))?.value !== encrypted) {
      throw new Error("MIGRATION_SOURCE_CHANGED");
    }

    await source.meta.put({ key: "legacy:retired", value: digest });
  });
  await checkpoint("source_finalized");

  return { migrated: true, ordinaryProfilesSupported: false };
};

// Test fault hooks are outside transactions; actual migration commits contain IDB operations only.

// Disposable v2 admission journal around the existing single-IDB sender/receiver.
// This is not an ordinary-profile migration or a second Ratchet implementation.
import type { NKCVaultDB } from "../db/schema";
import type { Message, Conversation } from "../db/repo";
import { encryptJsonRecord, decryptJsonRecord } from "../crypto/vault";
import { computeEnvelopeHash, verifyEnvelopeSignature, type Envelope } from "../crypto/box";
import { encodeBase64Url } from "../security/base64url";
import { getSodium } from "../security/sodium";
import { createExperimentalUnifiedRatchetManager, type OrderedTextContext } from "./orderedTextReceiver";

type Outer = Parameters<ReturnType<typeof createExperimentalUnifiedRatchetManager>["receive"]>[2];

type Pending = { v: 1; binding: string; hash: string; envelope: Envelope; outer?: Outer };

type SendRequest = Parameters<ReturnType<typeof createExperimentalUnifiedRatchetManager>["sendText"]>[1];

const validName = (value: string) => /^[A-Za-z0-9:_-]{1,96}$/.test(value);

const fingerprint = async (value: unknown) => encodeBase64Url((await getSodium()).crypto_generichash(32,
  new TextEncoder().encode(JSON.stringify(value))));

export function createDisposableUnifiedRecovery(options: {
  database: NKCVaultDB; vaultKey: Uint8Array; accountId: string; disposableProfile: boolean;
  appIntegration?: boolean;
  sessionValid: () => Promise<boolean>; checkpoint?: (stage: string) => Promise<void>;
}) {
  const db = options.database, account = options.accountId, vk = new Uint8Array(options.vaultKey);
  const allowedDb = options.appIntegration ? db.name.startsWith("nkc-phase2h-app-") : db.name.startsWith("nkc-phase2h-phase2p-");

  if (!options.disposableProfile || !allowedDb || !validName(account) || vk.length !== 32) {
    vk.fill(0); throw new Error("RECOVERY_PROFILE_BLOCKED");
  }

  if (!globalThis.navigator?.locks) { vk.fill(0); throw new Error("RECOVERY_OWNER_UNAVAILABLE"); }

  let closed = false, active = 0;

  const live = async () => {
    if (closed || !await options.sessionValid()) throw new Error("RECOVERY_SESSION_CLOSED");
  };

  const checkpoint = async (stage: string) => { await options.checkpoint?.(stage); await live(); };

  const manager = createExperimentalUnifiedRatchetManager({ database: db, vaultKey: vk, accountId: account,
    disposableProfile: true, checkpoint, ...(options.appIntegration ? { nativeOutboxOwner: true as const } : {}) });

  const locked = async <T>(operation: () => Promise<T>): Promise<T> => {
    active++;

    try {
      await live();

      return await navigator.locks.request(`nkc:phase2p:${db.name}:${account}`, async () => {
        await live();

 return operation();
      });
    } finally { active--;

 if (closed && active === 0) vk.fill(0); }
  };

  const binding = async (context: OrderedTextContext) => {
    if (context.accountId !== account || !validName(context.localConversation) || !validName(context.wireConversation) ||
      !validName(context.author) || context.verifyKey.length !== 32 || context.baseKey.length !== 32) {
      throw new Error("RECOVERY_CONTEXT_INVALID");
    }

    return fingerprint({ account, local: context.localConversation, wire: context.wireConversation,
      author: context.author, verify: encodeBase64Url(context.verifyKey), base: encodeBase64Url(context.baseKey) });
  };

  const keyFor = (context: OrderedTextContext) => `phase2p:inbound:${account}:${context.localConversation}`;

  const ensureOwner = async () => {
    const marker = await db.meta.get("phase2p:owner");

    if (marker) { if (marker.value !== account) throw new Error("RECOVERY_OWNER_CONFLICT");

 return; }

    await db.transaction("rw", [db.meta, db.events, db.outbox], async () => {
      if (await db.meta.get("phase2p:owner") || await db.meta.where("key").startsWith("phase2h:channel:").count() ||
        await db.events.count() || await db.outbox.count()) throw new Error("RECOVERY_IMPORT_REQUIRED");
      await db.meta.add({ key: "phase2p:owner", value: account });
    });
  };

  const readPending = async (context: OrderedTextContext): Promise<{ pending: Pending; token: string } | null> => {
    const id = keyFor(context), row = await db.meta.get(id);

    if (!row) return null;
    let pending: Pending;

    try { pending = await decryptJsonRecord<Pending>(vk, id, "unified-inbound-v1", row.value); }
    catch { throw new Error("RECOVERY_JOURNAL_UNREADABLE"); }

    if (pending.v !== 1 || pending.binding !== await binding(context) ||
      pending.envelope?.header?.convId !== context.wireConversation ||
      pending.envelope?.header?.authorDeviceId !== context.author ||
      pending.envelope?.header?.rk?.v !== 2 ||
      !await verifyEnvelopeSignature(pending.envelope, context.verifyKey) ||
      pending.hash !== await computeEnvelopeHash(pending.envelope)) throw new Error("RECOVERY_JOURNAL_CONFLICT");

    return { pending, token: row.value };
  };

  const stored = async (context: OrderedTextContext, pending: Pending) => {
    const id = pending.envelope.header.eventId;

    const [event, row, conversation] = await Promise.all([
      db.events.get(id), db.messages.get(id), db.conversations.get(context.localConversation),
    ]);

    if (event?.eventHash !== pending.hash || event.convId !== context.localConversation ||
      row?.convId !== context.localConversation || !conversation) throw new Error("RECOVERY_COMMIT_INCOMPLETE");

    try {
      const message = await decryptJsonRecord<Message>(vk, id, "message", row.enc_b64);
      const conv = await decryptJsonRecord<Conversation>(vk, context.localConversation, "conv", conversation.enc_b64);

      if (message.id !== id || message.convId !== context.localConversation || conv.id !== context.localConversation) {
        throw new Error("RECOVERY_COMMIT_INCOMPLETE");
      }
    } catch { throw new Error("RECOVERY_COMMIT_INCOMPLETE"); }
  };

  const drain = async (context: OrderedTextContext) => {
    const existing = await readPending(context);

    if (!existing) return { outcome: "idle" as const };
    await live();
    const result = await manager.receive(context, existing.pending.envelope, existing.pending.outer);

    if (result.outcome !== "stored" && result.outcome !== "duplicate") throw new Error("RECOVERY_PENDING_UNRESOLVED");
    await stored(context, existing.pending);
    await live();
    await db.transaction("rw", db.meta, async () => {
      if ((await db.meta.get(keyFor(context)))?.value !== existing.token) throw new Error("RECOVERY_JOURNAL_CONFLICT");
      await db.meta.delete(keyFor(context));
    });

    return { outcome: result.outcome };
  };

  return {
    close: () => { closed = true; manager.close();

 if (active === 0) vk.fill(0); },
    recover: (context: OrderedTextContext) => locked(async () => {
      await binding(context); await ensureOwner();

 return drain(context);
    }),
    receive: (context: OrderedTextContext, envelope: Envelope, outer?: Outer) => locked(async () => {
      await binding(context); await ensureOwner();
      const h = envelope?.header;

      if (!h || h.v !== 1 || h.rk?.v !== 2 || h.convId !== context.wireConversation || h.authorDeviceId !== context.author ||
        !validName(h.eventId) || !Number.isSafeInteger(h.lamport) || h.lamport < 1 ||
        JSON.stringify(envelope).length > 131072 ||
        (outer && (["eventId", "convId", "authorDeviceId", "lamport", "ts"] as const)
          .some(field => outer[field] !== h[field])) || !await verifyEnvelopeSignature(envelope, context.verifyKey)) {
        throw new Error("RECOVERY_INPUT_REJECTED");
      }

      const prior = await readPending(context);

      if (prior) {
        const recovered = await drain(context);

        if (prior.pending.hash === await computeEnvelopeHash(envelope)) return recovered;
      }

      const id = keyFor(context);

      const pending: Pending = { v: 1, binding: await binding(context), hash: await computeEnvelopeHash(envelope), envelope,
        ...(outer ? { outer: { eventId: outer.eventId, convId: outer.convId, authorDeviceId: outer.authorDeviceId,
          lamport: outer.lamport, ts: outer.ts } } : {}) };

      const value = await encryptJsonRecord(vk, id, "unified-inbound-v1", pending);
      await live();
      await db.transaction("rw", db.meta, async () => {
        if (await db.meta.get(id)) throw new Error("RECOVERY_JOURNAL_CONFLICT");

        if (await db.meta.where("key").startsWith(`phase2p:inbound:${account}:`).count() >= 64) throw new Error("RECOVERY_CAPACITY");
        await db.meta.add({ key: id, value });
      });
      await checkpoint("intake_written");

      return drain(context);
    }),
    sendText: (context: OrderedTextContext, request: SendRequest) => locked(async () => {
      await binding(context); await ensureOwner();

      if (request.version !== 2) throw new Error("RECOVERY_V2_ONLY");
      await drain(context); // An admitted receive must precede the next Root/DH send step.
      await live();

 return manager.sendText(context, request);
    }),
  };
}

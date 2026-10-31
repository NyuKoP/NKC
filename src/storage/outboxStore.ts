import type { EventRecord, OutboxRecord } from "../db/schema";
import { ensureVaultAccess, writeVault, type VaultAccess } from "../db/vaultAccess";
import { sameOutboxPayload, samePayloadBytes } from "./storedPayload";
import { sameStoredCiphertext } from "../crypto/vault";

const normalizedDefaults = new WeakSet<object>();

const sameOwnedEnvelope = (a: OutboxRecord, b: OutboxRecord) =>
  a.convId === b.convId && sameOutboxPayload(a, b) &&
  a.ownerAccountId === b.ownerAccountId && a.recipientIdentityPub === b.recipientIdentityPub &&
  (a.retention ?? "standard") === (b.retention ?? "standard") && Boolean(a.binaryTransport) === Boolean(b.binaryTransport) &&
  a.transferId === b.transferId && a.chunkIndex === b.chunkIndex;

export const ensureOutboxDefaults = async (access?: VaultAccess) => {
  const db = await ensureVaultAccess(access);

  if (normalizedDefaults.has(db)) return;

  const records = await db.outbox
    .filter((record) => record.nextAttemptAtMs === undefined || record.nextAttemptAtMs === null)
    .toArray();

  if (records.length) {
    await writeVault(access, [db.outbox], () => Promise.all(
      records.map((record) =>
        db.outbox.update(record.id, {
          nextAttemptAtMs: record.createdAtMs ?? Date.now(),
          attempts: record.attempts ?? 0,
          status: record.status ?? "pending",
        })
      )
    ));
  }

  normalizedDefaults.add(db);
};

export const putOutbox = async (record: OutboxRecord, access?: VaultAccess) => {
  record = structuredClone(record);
  const selected = await ensureVaultAccess(access);
  await writeVault(access, [selected.outbox], async () => {
    if (access) {
      const current = await selected.outbox.get(record.id);

      if (record.payloadFormat === "nkcp-v2" && !current) throw new Error("BINARY_ATOMIC_ADMISSION_REQUIRED");

      if (record.ownerAccountId !== access.accountId || (current && !sameOwnedEnvelope(current, record))) {
        throw new Error("OWNER_OUTBOX_MISMATCH");
      }

      if (current?.status === "acked" || current?.lastError === "LOCAL_SOURCE_CANCELLED" || current?.lastError === "SESSION_SUPERSEDED") return;
    }

    if (record.payloadFormat === "nkcp-v2" && !access) throw new Error("OWNER_OUTBOX_MISMATCH");
    await selected.outbox.put(record);
  });
};

export const claimOutbox = async (record: OutboxRecord, access: VaultAccess, event?: EventRecord, admission?: {
  key: string; expected: string; committed: string; keyId: string | null;
  profileId: string; profileCiphertext: string; conversationId: string; conversationCiphertext: string;
  logicalId: string;
  alreadyAdmitted: boolean;
}) => {
  record = structuredClone(record);
  // Own the admission evidence before awaiting Main authority.
  if (event) event = structuredClone(event);

  if (admission) admission = { ...admission };

  if (record.ownerAccountId !== access.accountId) throw new Error("OWNER_OUTBOX_MISMATCH");
  const selected = await ensureVaultAccess(access);

  return writeVault(access, event ? [selected.outbox, selected.events, selected.meta, selected.profiles,
    selected.conversations, selected.tombstones] : [selected.outbox], async () => {
    const current = await selected.outbox.get(record.id);

    if (event) {
      if (!admission || (await selected.meta.get(admission.key))?.value !== admission.expected) throw new Error("FRESH_INTENT_CONFLICT");

      if (admission.alreadyAdmitted && !current) throw new Error("SEND_COMMIT_TERMINAL");
      const keyId = (await selected.meta.get("vault_key_id_v1"))?.value;

      if (keyId && keyId !== admission.keyId) throw new Error("OWNER_SESSION_CHANGED");

      if (!sameStoredCiphertext((await selected.profiles.get(admission.profileId))?.enc_b64, admission.profileCiphertext) ||
          !sameStoredCiphertext((await selected.conversations.get(admission.conversationId))?.enc_b64, admission.conversationCiphertext) ||
          await selected.tombstones.get(admission.logicalId) || await selected.tombstones.get(admission.conversationId)) {
        throw new Error("OUTGOING_SOURCE_CHANGED");
      }

      if (current && (current.status === "acked" || current.status === "expired" || current.lastError === "LOCAL_SOURCE_CANCELLED" ||
          current.lastError === "SESSION_SUPERSEDED")) throw new Error("SEND_COMMIT_TERMINAL");

      if (event.envelopeFormat !== undefined || record.payloadFormat !== undefined || event.eventId !== record.id ||
          event.convId !== record.convId || event.envelopeJson !== record.ciphertext) throw new Error("OWNER_EVENT_MISMATCH");
      const previous = await selected.events.get(event.eventId);

      if (previous && (previous.envelopeFormat !== undefined || previous.envelopeJson !== event.envelopeJson ||
          previous.eventHash !== event.eventHash)) throw new Error("OWNER_EVENT_MISMATCH");

      if (!previous && current) throw new Error("OWNER_EVENT_MISMATCH");

      if (!previous) await selected.events.add(event);
      await selected.meta.put({ key: admission.key, value: admission.committed });
    }

    if (current) {
      if (!sameOwnedEnvelope(current, record)) throw new Error("OWNER_OUTBOX_MISMATCH");

      return false;
    }

    if (record.payloadFormat === "nkcp-v2") throw new Error("BINARY_ATOMIC_ADMISSION_REQUIRED");
    await selected.outbox.add(record);

    return true;
  });
};

export const getOutbox = async (id: string, access?: VaultAccess) => {
  const selected = await ensureVaultAccess(access);
  const record = await selected.outbox.get(id);
  access?.assertLocal();

  return record;
};

export const deleteOutbox = async (id: string, access?: VaultAccess) => {
  const selected = await ensureVaultAccess(access);
  await writeVault(access, [selected.outbox], () => selected.outbox.delete(id));
};

export const listPendingOutbox = async (access?: VaultAccess) => {
  const db = await ensureVaultAccess(access);
  const result = await db.outbox.where("status").equals("pending").toArray();
  access?.assertLocal();

  return result;
};

export const listRetryableOutbox = async (now: number, limit: number, access?: VaultAccess) => {
  const db = await ensureVaultAccess(access);

  const items = await db.outbox
    .where("[status+nextAttemptAtMs]")
    .between(["pending", 0], ["pending", now], true, true)
    .filter((record) => record.expiresAtMs > now)
    .sortBy("nextAttemptAtMs");

  items.sort((a, b) => {
    // Prioritize before truncating the candidate batch sent to the native planner.
    // Otherwise a large media backlog can hide newer chat from that planner.
    const priorityDifference = Number(b.priority === "high") - Number(a.priority === "high");

    if (priorityDifference) return priorityDifference;

    if (a.nextAttemptAtMs !== b.nextAttemptAtMs) {
      return a.nextAttemptAtMs - b.nextAttemptAtMs;
    }

    return a.createdAtMs - b.createdAtMs;
  });
  access?.assertLocal();

  return items.slice(0, limit);
};

export const listInFlightTimedOut = async (now: number, limit: number, access?: VaultAccess) => {
  const db = await ensureVaultAccess(access);

  const items = await db.outbox
    .where("[status+ackDeadlineMs]")
    .between(["in_flight", 0], ["in_flight", now], true, true)
    .filter((record) => record.expiresAtMs > now)
    .sortBy("ackDeadlineMs");

  access?.assertLocal();

  return items.slice(0, limit);
};

export const updateOutbox = async (id: string, patch: Partial<OutboxRecord>, access?: VaultAccess) => {
  patch = structuredClone(patch);
  const selected = await ensureVaultAccess(access);
  await writeVault(access, [selected.outbox], async () => {
    const current = await selected.outbox.get(id);

    if (!current || (current.status === "acked" && patch.status && patch.status !== "acked")) return;

    if (current.payloadFormat === undefined && (patch.payloadFormat !== undefined || "payloadBytes" in patch || "nativeRetryId" in patch)) {
      throw new Error("BINARY_ATOMIC_ADMISSION_REQUIRED");
    }

    if (current.payloadFormat === "nkcp-v2" && (!access || current.ownerAccountId !== access.accountId)) throw new Error("OWNER_OUTBOX_MISMATCH");

    if (current.payloadFormat === "nkcp-v2" && (
      "ciphertext" in patch || "payloadFormat" in patch && patch.payloadFormat !== current.payloadFormat ||
      "payloadBytes" in patch && (!(patch.payloadBytes instanceof Uint8Array) || !samePayloadBytes(patch.payloadBytes, current.payloadBytes)) ||
      "nativeRetryId" in patch && patch.nativeRetryId !== current.nativeRetryId ||
      "ownerAccountId" in patch && patch.ownerAccountId !== current.ownerAccountId ||
      "recipientIdentityPub" in patch && patch.recipientIdentityPub !== current.recipientIdentityPub ||
      "convId" in patch && patch.convId !== current.convId || "id" in patch && patch.id !== current.id
    )) throw new Error("OWNER_OUTBOX_MISMATCH");

    if (current.lastError === "LOCAL_SOURCE_CANCELLED" &&
        (patch.status && patch.status !== "expired" || "lastError" in patch && patch.lastError !== "LOCAL_SOURCE_CANCELLED")) return;
    await selected.outbox.update(id, patch);
  });
};

export const markOutboxInFlightUnlessAcked = async (
  id: string,
  patch: Pick<OutboxRecord, "inFlightAtMs" | "ackDeadlineMs">, access?: VaultAccess
) => {
  const db = await ensureVaultAccess(access);

  const work = async () => {
    const current = await db.outbox.get(id);

    if (!current || current.status === "acked" || current.lastError === "LOCAL_SOURCE_CANCELLED") return false;
    await db.outbox.update(id, { ...patch, status: "in_flight" });

    return true;
  };

  return access ? writeVault(access, [db.outbox], work) : db.transaction("rw", db.outbox, work);
};

export const deleteExpiredOutbox = async (now = Date.now(), access?: VaultAccess) => {
  const db = await ensureVaultAccess(access);

  return writeVault(access, [db.outbox], () => db.outbox
    .where("expiresAtMs")
    .belowOrEqual(now)
    .and((record) => record.status === "pending" || record.status === "in_flight")
    .delete());
};

export const deleteFailedOutbox = async (minAttempts = 12, access?: VaultAccess) => {
  const db = await ensureVaultAccess(access);

  return writeVault(access, [db.outbox], () => db.outbox
    .where("status")
    .equals("pending")
    .filter((record) => (record.attempts ?? 0) >= minAttempts)
    .delete());
};

export const listOutboxByConv = async (convId: string, access?: VaultAccess) => {
  const db = await ensureVaultAccess(access);
  const items = await db.outbox.where("convId").equals(convId).toArray();
  access?.assertLocal();

  return items;
};

export const clearOutboxQueue = async (access?: VaultAccess) => {
  const db = await ensureVaultAccess(access);
  await writeVault(access, [db.outbox], () => db.outbox.clear());
};

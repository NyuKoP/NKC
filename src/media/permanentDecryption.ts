import { captureLocalOperationContext } from "../accounts/receiveContext";
import { decryptJsonRecord, encryptJsonRecord, sameStoredCiphertext } from "../crypto/vault";
import { readMessageMediaChunks, type MediaRef, type Message } from "../db/repo";
import { writeVault, type VaultAccess } from "../db/vaultAccess";
import { parseIncomingMediaRef } from "../security/mediaPolicy";
import { mediaCustodyKey, readMediaCustody, writeMediaCustody, type MediaCustody } from "../storage/mediaCustody";
import { notifyMessageMediaReady } from "../storage/mediaReady";
import { createLogicalMediaChunk, type LogicalMediaChunk } from "../sync/receivedText";
import { captureDeviceRegistryContext, VAULT_REGISTRY_KEY } from "../devices/deviceRegistry";
import { getAccountRootIdentity, getAuthorizedDevice } from "../devices/deviceApprovals";
import { getOrCreateDeviceId } from "../security/deviceRole";

const captureConversionContext = async () => {
  let context = await captureLocalOperationContext();

  if (!context) return undefined;

  if (await getAccountRootIdentity(context)) {
    if (!await getAuthorizedDevice(getOrCreateDeviceId(context), context)) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
    context = await captureDeviceRegistryContext(context);
  }

  return context;
};

const assertConversionCurrent = async (access: VaultAccess) => {
  await access.assertMain();

  if (access.authorizationMeta && (await access.db.meta.get(VAULT_REGISTRY_KEY))?.value !== access.authorizationMeta.value) {
    throw new Error("DEVICE_AUTHORITY_CHANGED");
  }

  access.assertLocal();
};

const conversionChains = new WeakMap<Uint8Array, Promise<void>>();

const withConversionLock = async <T>(access: VaultAccess, operation: () => Promise<T>) => {
  const previous = conversionChains.get(access.key) ?? Promise.resolve();


  const task = previous.then(async () => {
    await assertConversionCurrent(access);


    return operation();
  });
  // The next gate settles on failure; this caller still receives its task's rejection.


  const settled = task.then(() => {}, () => {});
  conversionChains.set(access.key, settled);

  try { return await task; }
  finally { if (conversionChains.get(access.key) === settled) conversionChains.delete(access.key); }
};

const finish = async (record: MediaCustody, access: VaultAccess) => {
  const request = window.nkc?.permanentMedia;

  if (!request) throw new Error("MEDIA_CONVERSION_UNAVAILABLE");
  await assertConversionCurrent(access);
  const message = await access.db.messages.get(record.media.ownerId);

  if (!message || await access.db.tombstones.get(record.media.ownerId)) throw new Error("MEDIA_SOURCE_DELETED");
  await request(access.session, { operation: "publish", token: record.token });
  await assertConversionCurrent(access);
  const key = mediaCustodyKey(record.media.ownerId), previous = await access.db.meta.get(key);
  const current = await readMediaCustody(record.media.ownerId, access.db, access.key);

  if (current?.phase !== "ready" || current.token !== record.token) throw new Error("MEDIA_CONVERSION_CONFLICT");
  const value = await encryptJsonRecord(access.key, key, "media-custody", { ...record, phase: "plaintext" });
  await writeVault(access, [access.db.meta, access.db.mediaChunks, access.db.messages, access.db.tombstones], async () => {
    if ((await access.db.meta.get(key))?.value !== previous?.value) throw new Error("MEDIA_CONVERSION_CONFLICT");

    if (!sameStoredCiphertext((await access.db.messages.get(record.media.ownerId))?.enc_b64, message.enc_b64) ||
        await access.db.tombstones.get(record.media.ownerId)) throw new Error("MEDIA_SOURCE_DELETED");
    await access.db.meta.put({ key, value });
    await access.db.mediaChunks.where("ownerId").equals(record.media.ownerId)
      .and(chunk => chunk.ownerType === "message").delete();
  });
  notifyMessageMediaReady(record.media.ownerId);
};

export const permanentlyDecryptMedia = async (media: MediaRef) => {
  const context = await captureConversionContext(), parsed = parseIncomingMediaRef(media, media.ownerId);
  const request = window.nkc?.permanentMedia;

  if (!context || !parsed || !request) throw new Error("MEDIA_CONVERSION_UNAVAILABLE");
  const access = context.vault;


  return withConversionLock(access, async () => {
    const existing = await readMediaCustody(parsed.ownerId, access.db, access.key);

    if (existing) throw new Error("MEDIA_CONVERSION_ALREADY_STARTED");
    const sourceRow = await access.db.messages.get(parsed.ownerId);

    if (!sourceRow) throw new Error("MEDIA_MANIFEST_UNAVAILABLE");
    const source = await decryptJsonRecord<Message>(access.key, parsed.ownerId, "message", sourceRow.enc_b64);
    const sourceMedia = parseIncomingMediaRef(source.media, parsed.ownerId);

    if (!sourceMedia || JSON.stringify(sourceMedia) !== JSON.stringify(parsed)) throw new Error("MEDIA_MANIFEST_CONFLICT");
    const begin = await request(access.session, { operation: "begin", media: parsed });

    if (begin.cancelled) return false;

    if (!begin.token) throw new Error("MEDIA_TICKET_INVALID");
    let record: MediaCustody = { version: 1, phase: "preparing", token: begin.token, media: parsed };
    await writeMediaCustody(record, access);

    try {
      let offset = 0;
      const proofs: Array<LogicalMediaChunk | null> = [];

      for await (const chunk of readMessageMediaChunks(media, access)) {
        await assertConversionCurrent(access);
        const id = `${parsed.ownerId}:${chunk.idx}`, row = await access.db.mediaChunks.get(id);
        proofs.push(row?.logicalProof_enc ? await decryptJsonRecord<LogicalMediaChunk>(access.key, id, "media-proof", row.logicalProof_enc) :
          source.logicalProof ? await createLogicalMediaChunk(source.logicalProof, chunk.idx, chunk.bytes, context) : null);
        await request(access.session, { operation: "write", token: record.token, offset, bytes: chunk.bytes });
        offset += chunk.bytes.length;
      }

      await assertConversionCurrent(access);
      const sealed = await request(access.session, { operation: "seal", token: record.token });

      if (!sealed.token) throw new Error("MEDIA_TICKET_INVALID");
      record = { ...record, phase: "ready", token: sealed.token, proofs };
      await writeMediaCustody(record, access, begin.token);
      await finish(record, access);
    } catch (error) {
      try {
        await request(access.session, { operation: "discard", token: record.token });
        const key = mediaCustodyKey(parsed.ownerId), row = await access.db.meta.get(key);
        const current = await readMediaCustody(parsed.ownerId, access.db, access.key);

        if (current?.phase !== "plaintext" && current?.token === record.token) {
          await writeVault(access, [access.db.meta], async () => {
            if ((await access.db.meta.get(key))?.value === row?.value) await access.db.meta.delete(key);
          });
        }
      } catch { /* A published file or revoked owner requires recovery; encrypted custody remains. */ }

      throw error;
    }

    return true;
  });
};

export const recoverPermanentMediaDecryption = async () => {
  const context = await captureConversionContext();
  const request = window.nkc?.permanentMedia;

  if (!context || !request) return;
  const access = context.vault;


  return withConversionLock(access, async () => {
    const rows = await access.db.meta.where("key").startsWith("media-custody:v1:").toArray();

    for (const row of rows) {
      await assertConversionCurrent(access);
      const record = await readMediaCustody(row.key.slice("media-custody:v1:".length), access.db, access.key);

      if (!record || record.phase === "plaintext") continue;

      if (record.phase === "ready") await finish(record, access);
      else {
        await request(access.session, { operation: "discard", token: record.token });
        await writeVault(access, [access.db.meta], async () => {
          if ((await access.db.meta.get(row.key))?.value !== row.value) throw new Error("MEDIA_CONVERSION_CONFLICT");
          await access.db.meta.delete(row.key);
        });
      }
    }
  });
};

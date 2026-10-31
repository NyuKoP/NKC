import { decryptJsonRecord, encryptJsonRecord } from "../crypto/vault";
import type { NKCVaultDB } from "../db/schema";
import type { VaultAccess } from "../db/vaultAccess";
import { writeVault } from "../db/vaultAccess";
import { parseIncomingMediaRef, type ValidatedIncomingMediaRef } from "../security/mediaPolicy";
import type { LogicalMediaChunk } from "../sync/receivedText";

export type MediaCustody = {
  version: 1; phase: "preparing" | "ready" | "plaintext";
  token: string; media: ValidatedIncomingMediaRef;
  proofs?: Array<LogicalMediaChunk | null>;
};

export const mediaCustodyKey = (id: string) => `media-custody:v1:${id}`;

export const readMediaCustody = async (id: string, db: NKCVaultDB, key: Uint8Array) => {
  const name = mediaCustodyKey(id), row = await db.meta.get(name);

  if (!row) return undefined;
  const value = await decryptJsonRecord<MediaCustody>(key, name, "media-custody", row.value);

  if (value?.version !== 1 || !["preparing", "ready", "plaintext"].includes(value.phase) ||
      typeof value.token !== "string" || !value.token || value.token.length > 32768 ||
      !parseIncomingMediaRef(value.media, id)) throw new Error("MEDIA_CUSTODY_INVALID");

  return value;
};

export const writeMediaCustody = async (record: MediaCustody, access: VaultAccess, previousToken?: string) => {
  const key = mediaCustodyKey(record.media.ownerId);
  const value = await encryptJsonRecord(access.key, key, "media-custody", record);
  const previous = await access.db.meta.get(key);
  const current = previous && await readMediaCustody(record.media.ownerId, access.db, access.key);

  if (current?.token !== previousToken) throw new Error("MEDIA_CONVERSION_CONFLICT");
  await writeVault(access, [access.db.meta], async () => {
    if ((await access.db.meta.get(key))?.value !== previous?.value) throw new Error("MEDIA_CONVERSION_CONFLICT");
    await access.db.meta.put({ key, value });
  });
};

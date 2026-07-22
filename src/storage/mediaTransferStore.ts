import { decryptJsonRecord, encryptJsonRecord } from "../crypto/vault";
import { getVaultKey } from "../crypto/sessionKeyring";
import { db, ensureDbOpen } from "../db/schema";

export type MediaTransferProgress = {
  version: 1;
  transferId: string;
  convId: string;
  totalChunks: number;
  storedThrough: number;
  ackedThrough: number;
  ackedOutOfOrder: number[];
  status: "active" | "complete" | "failed";
  updatedAt: number;
};

const updateChains = new Map<string, Promise<void>>();

const withTransferLock = async <T>(transferId: string, operation: () => Promise<T>) => {
  const previous = updateChains.get(transferId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => {}).then(() => current);
  updateChains.set(transferId, chain);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (updateChains.get(transferId) === chain) updateChains.delete(transferId);
  }
};

const readUnlocked = async (transferId: string) => {
  await ensureDbOpen();
  const record = await db.mediaTransfers.get(transferId);
  const key = getVaultKey();
  if (!record || !key) return null;
  return decryptJsonRecord<MediaTransferProgress>(key, transferId, "mediaTransfer", record.enc_b64);
};

const writeUnlocked = async (progress: MediaTransferProgress) => {
  const key = getVaultKey();
  if (!key) return false;
  await ensureDbOpen();
  const updatedAt = Date.now();
  const next = { ...progress, updatedAt };
  const enc_b64 = await encryptJsonRecord(key, progress.transferId, "mediaTransfer", next);
  await db.mediaTransfers.put({ transferId: progress.transferId, enc_b64, updatedAt });
  return true;
};

export const createMediaTransferProgress = async (
  transferId: string,
  convId: string,
  totalChunks: number
) =>
  withTransferLock(transferId, () =>
    writeUnlocked({
      version: 1,
      transferId,
      convId,
      totalChunks,
      storedThrough: -1,
      ackedThrough: -1,
      ackedOutOfOrder: [],
      status: "active",
      updatedAt: Date.now(),
    })
  );

export const markMediaTransferStored = async (transferId: string, chunkIndex: number) =>
  withTransferLock(transferId, async () => {
    const current = await readUnlocked(transferId);
    if (!current || chunkIndex <= current.storedThrough) return false;
    return writeUnlocked({ ...current, storedThrough: chunkIndex });
  });

export const markMediaTransferAcked = async (transferId: string, chunkIndex: number) =>
  withTransferLock(transferId, async () => {
    const current = await readUnlocked(transferId);
    if (!current || chunkIndex < 0 || chunkIndex >= current.totalChunks) return false;
    const pending = new Set(current.ackedOutOfOrder);
    if (chunkIndex > current.ackedThrough) pending.add(chunkIndex);
    let ackedThrough = current.ackedThrough;
    while (pending.delete(ackedThrough + 1)) ackedThrough += 1;
    return writeUnlocked({
      ...current,
      ackedThrough,
      ackedOutOfOrder: [...pending].sort((a, b) => a - b),
      status: ackedThrough === current.totalChunks - 1 ? "complete" : current.status,
    });
  });

export const getMediaTransferProgress = (transferId: string) =>
  withTransferLock(transferId, () => readUnlocked(transferId));

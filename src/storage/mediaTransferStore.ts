import { decryptJsonRecord, encryptJsonRecord } from "../crypto/vault";
import { captureLocalOperationContext } from "../accounts/receiveContext";
import { getActiveAccountId } from "../accounts/accountRegistry";
import { getAccountOwnerGeneration } from "../accounts/accountOwnerLifecycle";
import { writeVault, type VaultAccess } from "../db/vaultAccess";

export type MediaTransferProgress = {
  version: 1;
  transferId: string;
  convId: string;
  totalChunks: number;
  storedThrough: number;
  ackedThrough: number;
  ackedOutOfOrder: number[];
  recipients?: string[];
  acknowledgements?: Record<string, { ackedThrough: number; ackedOutOfOrder: number[] }>;
  status: "active" | "complete" | "failed";
  updatedAt: number;
};

const updateChains = new Map<string, Promise<void>>();

const listeners = new Map<string, Set<(progress: MediaTransferProgress) => void>>();
const ownerKey = (accountId: string, transferId: string) => JSON.stringify([accountId, transferId]);
const captureAccess = async (access?: VaultAccess) => {
  if (access) { access.assertLocal(); return access; }
  try { return (await captureLocalOperationContext())?.vault; }
  catch (error) {
    if (error instanceof Error && error.message === "RECIPIENT_VAULT_UNAVAILABLE") return undefined;
    throw error;
  }
};

export const subscribeMediaTransferProgress = (
  transferId: string,
  listener: (progress: MediaTransferProgress) => void,
  access?: VaultAccess
) => {
  access?.assertLocal();
  const accountId = access?.accountId ?? getActiveAccountId();
  const generation = getAccountOwnerGeneration();
  const key = ownerKey(accountId, transferId);
  const currentListener = (progress: MediaTransferProgress) => {
    if (getActiveAccountId() !== accountId || getAccountOwnerGeneration() !== generation) return;
    access?.assertLocal();
    listener(progress);
  };
  const group = listeners.get(key) ?? new Set();
  group.add(currentListener);
  listeners.set(key, group);

  return () => {
    group.delete(currentListener);

    if (!group.size) listeners.delete(key);
  };
};

const withTransferLock = async <T>(transferId: string, access: VaultAccess, operation: () => Promise<T>) => {
  const key = ownerKey(access.accountId, transferId);
  const previous = updateChains.get(key) ?? Promise.resolve();
  let release!: () => void;

  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  const chain = previous.catch(() => {}).then(() => current);
  updateChains.set(key, chain);
  await previous.catch(() => {});

  try {
    access.assertLocal();
    return await operation();
  } finally {
    release();

    if (updateChains.get(key) === chain) updateChains.delete(key);
  }
};

const readUnlocked = async (transferId: string, access: VaultAccess) => {
  await access.assertMain();
  const record = await access.db.mediaTransfers.get(transferId);
  access.assertLocal();

  if (!record) return null;

  const progress = await decryptJsonRecord<MediaTransferProgress>(access.key, transferId, "mediaTransfer", record.enc_b64);
  access.assertLocal();
  return progress;
};

const writeUnlocked = async (progress: MediaTransferProgress, access: VaultAccess) => {
  await access.assertMain();
  const updatedAt = Date.now();
  const next = { ...progress, updatedAt };
  const enc_b64 = await encryptJsonRecord(access.key, progress.transferId, "mediaTransfer", next);
  await writeVault(access, [access.db.mediaTransfers, access.db.tombstones], async () => {
    if (await access.db.tombstones.get(progress.transferId) || await access.db.tombstones.get(progress.convId)) throw new Error("MEDIA_SOURCE_DELETED");
    await access.db.mediaTransfers.put({ transferId: progress.transferId, enc_b64, updatedAt });
  });
  access.assertLocal();
  listeners.get(ownerKey(access.accountId, progress.transferId))?.forEach((listener) => {
    try { listener(next); } catch (error) { console.error("Media progress listener failed", error); }
  });

  return true;
};

export const createMediaTransferProgress = async (
  transferId: string,
  convId: string,
  totalChunks: number,
  access?: VaultAccess,
  recipients?: string[]
) => {
  const selected = await captureAccess(access);
  if (!selected) return false;
  return withTransferLock(transferId, selected, () =>
    writeUnlocked({
      version: 1,
      transferId,
      convId,
      totalChunks,
      storedThrough: -1,
      ackedThrough: -1,
      ackedOutOfOrder: [],
      ...(recipients ? { recipients: [...new Set(recipients)], acknowledgements: {} } : {}),
      status: "active",
      updatedAt: Date.now(),
    }, selected)
  );
};

export const markMediaTransferStored = async (transferId: string, chunkIndex: number, access?: VaultAccess) => {
  const selected = await captureAccess(access);
  if (!selected) return false;
  return withTransferLock(transferId, selected, async () => {
    const current = await readUnlocked(transferId, selected);

    if (!current || chunkIndex <= current.storedThrough) return false;

    return writeUnlocked({ ...current, storedThrough: chunkIndex }, selected);
  });
};

export const advanceMediaTransferAcknowledgement = (current: MediaTransferProgress, chunkIndex: number, peerAccount?: string) => {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= current.totalChunks ||
      current.recipients && (!peerAccount || !current.recipients.includes(peerAccount))) return null;
  const previous = current.recipients ? current.acknowledgements?.[peerAccount!] ?? { ackedThrough: -1, ackedOutOfOrder: [] } : current;
  const pending = new Set(previous.ackedOutOfOrder);
  if (chunkIndex > previous.ackedThrough) pending.add(chunkIndex);
  let ackedThrough = previous.ackedThrough;
  while (pending.delete(ackedThrough + 1)) ackedThrough += 1;
  const acknowledgements = current.recipients ? { ...current.acknowledgements,
    [peerAccount!]: { ackedThrough, ackedOutOfOrder: [...pending].sort((a, b) => a - b) } } : undefined;
  if (current.recipients) ackedThrough = Math.min(...current.recipients.map(identity => acknowledgements![identity]?.ackedThrough ?? -1));
  return { ...current, ackedThrough, ackedOutOfOrder: current.recipients ? [] : [...pending].sort((a, b) => a - b),
    ...(acknowledgements ? { acknowledgements } : {}),
    status: ackedThrough === current.totalChunks - 1 ? "complete" as const : current.status, updatedAt: Date.now() };
};

export const publishMediaTransferProgress = (progress: MediaTransferProgress, access: VaultAccess) => {
  access.assertLocal();
  listeners.get(ownerKey(access.accountId, progress.transferId))?.forEach(listener => {
    try { listener(progress); } catch (error) { console.error("Media progress listener failed", error); }
  });
};

export const markMediaTransferAcked = async (transferId: string, chunkIndex: number, access?: VaultAccess) => {
  const selected = await captureAccess(access);
  if (!selected) return false;
  return withTransferLock(transferId, selected, async () => {
    const current = await readUnlocked(transferId, selected);

    const next = current ? advanceMediaTransferAcknowledgement(current, chunkIndex) : null;
    return next ? writeUnlocked(next, selected) : false;
  });
};

export const getMediaTransferProgress = async (transferId: string, access?: VaultAccess) => {
  const selected = await captureAccess(access);
  if (!selected) return null;
  return withTransferLock(transferId, selected, () => readUnlocked(transferId, selected));
};

export const waitForMediaTransferCompletion = async (
  transferId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number; access?: VaultAccess } = {}
) => {
  const selected = await captureAccess(options.access);
  if (!selected) return null;
  const timeoutMs = Math.max(0, options.timeoutMs ?? 5 * 60 * 1000);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 500);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const progress = await getMediaTransferProgress(transferId, selected);

    if (!progress || progress.status !== "active" || Date.now() >= deadline) return progress;
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
};

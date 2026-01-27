import { db, ensureDbOpen } from "../db/schema";

export type StorageUsage = {
  chatBytes: number;
  mediaBytes: number;
  pendingBytes: number;
  totalBytes: number;
};

const encoder = new TextEncoder();

const byteLengthUtf8 = (value: string) => encoder.encode(value).length;

const byteLengthOfJson = (value: unknown) => {
  try {
    return byteLengthUtf8(JSON.stringify(value));
  } catch {
    return 0;
  }
};

export async function estimateStorageUsage(): Promise<StorageUsage> {
  await ensureDbOpen();

  const [profiles, conversations, messages, mediaChunks, outbox, meta] = await Promise.all([
    db.profiles.toArray(),
    db.conversations.toArray(),
    db.messages.toArray(),
    db.mediaChunks.toArray(),
    db.outbox ? db.outbox.toArray() : Promise.resolve([]),
    db.meta.toArray(),
  ]);

  const chatBytes =
    profiles.reduce((sum, record) => sum + byteLengthOfJson(record), 0) +
    conversations.reduce((sum, record) => sum + byteLengthOfJson(record), 0) +
    messages.reduce((sum, record) => sum + byteLengthOfJson(record), 0) +
    meta.reduce((sum, record) => sum + byteLengthOfJson(record), 0);

  const mediaBytes = mediaChunks.reduce((sum, record) => sum + byteLengthOfJson(record), 0);

  const pendingBytes = outbox.reduce((sum, record) => {
    if (record.ciphertext) {
      return sum + byteLengthUtf8(record.ciphertext);
    }
    return sum + byteLengthOfJson(record);
  }, 0);

  const totalBytes = chatBytes + mediaBytes + pendingBytes;

  return {
    chatBytes,
    mediaBytes,
    pendingBytes,
    totalBytes,
  };
}

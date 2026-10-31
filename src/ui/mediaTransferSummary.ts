import type { MediaRef } from "../db/repo";
import type { MediaTransferProgress } from "../storage/mediaTransferStore";

export const summarizeMediaTransfers = (
  media: MediaRef[],
  progress: Record<string, MediaTransferProgress>
) => {
  let receivedBytes = 0;
  let completed = 0;
  let failed = false;
  const totalBytes = media.reduce((sum, item) => sum + item.size, 0);

  for (const item of media) {
    const state = progress[item.ownerId];

    if (!state) continue;
    failed ||= state.status === "failed";

    if (state.status === "complete") {
      completed += 1;
      receivedBytes += item.size;
      continue;
    }

    const through = Math.min(state.ackedThrough, item.total - 1);
    receivedBytes += Math.min(item.size, Math.max(0, through + 1) * item.chunkSize);

    for (const index of new Set(state.ackedOutOfOrder)) {
      if (index <= through || index < 0 || index >= item.total) continue;
      receivedBytes += Math.max(0, Math.min(item.chunkSize, item.size - index * item.chunkSize));
    }
  }

  const complete = completed === media.length && media.length > 0;

  return {
    completed, failed, complete,
    // Reserve 100% for confirmed completion of every file.
    percent: complete ? 100 : Math.min(99, totalBytes > 0 ? Math.floor(receivedBytes / totalBytes * 100) : 0),
  };
};

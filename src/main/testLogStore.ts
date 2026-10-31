import fs from "node:fs/promises";
import path from "node:path";

export type TestLogAppendPayload = {
  channel: string;
  event: unknown;
  at?: string;
};

const TEST_LOG_FILENAME = "nkc-test-events.log";

const FRIEND_FLOW_TEST_LOG_FILENAME = "nkc-test-friend-flow.log";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
let pendingAppend: Promise<void> = Promise.resolve();

export const getTestLogPath = (userDataPath: string) =>
  path.join(userDataPath, "logs", TEST_LOG_FILENAME);

export const getFriendFlowTestLogPath = (userDataPath: string) =>
  path.join(userDataPath, "logs", FRIEND_FLOW_TEST_LOG_FILENAME);

const shouldMirrorToFriendFlowLog = (payload: TestLogAppendPayload) => {
  return typeof payload.channel === "string" && payload.channel.trim().length > 0;
};

const stringifyTestLogRecord = (payload: TestLogAppendPayload) => {
  const record = {
    at: payload.at ?? new Date().toISOString(),
    channel: payload.channel,
    event: payload.event,
  };

  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      at: record.at,
      channel: record.channel,
      event: String(payload.event),
      note: "non-serializable event converted to string",
    });
  }
};

export const appendTestLogRecord = async (
  userDataPath: string,
  payload: TestLogAppendPayload
) => {
  const line = `${stringifyTestLogRecord(payload)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_LOG_BYTES) throw new Error("DIAGNOSTIC_RECORD_TOO_LARGE");
  const paths = [getTestLogPath(userDataPath)];
  if (shouldMirrorToFriendFlowLog(payload)) paths.push(getFriendFlowTestLogPath(userDataPath));
  const operation = pendingAppend.then(async () => {
    await fs.mkdir(path.dirname(paths[0]), { recursive: true });
    for (const file of paths) {
      const previous = `${file}.1`;
      const sizes: number[] = [];
      for (const candidate of [file, previous]) {
        try { sizes.push((await fs.stat(candidate)).size); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          sizes.push(0);
        }
      }
      if (sizes[1] > MAX_LOG_BYTES) await fs.unlink(previous);
      if (sizes[0] > MAX_LOG_BYTES) await fs.truncate(file, 0);
      else if (sizes[0] + bytes > MAX_LOG_BYTES) {
        try { await fs.unlink(previous); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await fs.rename(file, previous);
      }
      await fs.appendFile(file, line, "utf8");
    }
  });
  // Callers receive failures; the serialization tail must still admit the next append.
  pendingAppend = operation.then(() => {}, () => {});
  return operation;
};

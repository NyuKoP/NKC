import fs from "node:fs/promises";
import path from "node:path";

export type TestLogAppendPayload = {
  channel: string;
  event: unknown;
  at?: string;
};

const TEST_LOG_FILENAME = "nkc-test-events.log";
const FRIEND_FLOW_TEST_LOG_FILENAME = "nkc-test-friend-flow.log";

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
  const logPath = getTestLogPath(userDataPath);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const line = stringifyTestLogRecord(payload);
  await fs.appendFile(logPath, `${line}\n`, "utf8");
  if (shouldMirrorToFriendFlowLog(payload)) {
    await fs.appendFile(getFriendFlowTestLogPath(userDataPath), `${line}\n`, "utf8");
  }
};

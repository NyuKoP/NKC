import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTestLogRecord,
  getFriendFlowTestLogPath,
  getTestLogPath,
} from "../testLogStore";

const tempDirs: string[] = [];

const createTempUserDataPath = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nkc-testlog-"));
  tempDirs.push(dir);
  return dir;
};

const readJsonLogLines = async (filePath: string) => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { channel: string; event: unknown });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe("testLogStore friend-flow mirror", () => {
  it("mirrors friend-add logs to friend-flow file", async () => {
    const userDataPath = await createTempUserDataPath();
    await appendTestLogRecord(userDataPath, {
      channel: "friend-add",
      event: { stage: "result:added" },
    });

    const allLogs = await readJsonLogLines(getTestLogPath(userDataPath));
    const friendFlowLogs = await readJsonLogLines(getFriendFlowTestLogPath(userDataPath));

    expect(allLogs).toHaveLength(1);
    expect(friendFlowLogs).toHaveLength(1);
    expect(friendFlowLogs[0].channel).toBe("friend-add");
  });

  it("mirrors friend-route control frame logs to friend-flow file", async () => {
    const userDataPath = await createTempUserDataPath();
    await appendTestLogRecord(userDataPath, {
      channel: "friend-route",
      event: { frameType: "friend_req" },
    });
    await appendTestLogRecord(userDataPath, {
      channel: "friend-route",
      event: { frameType: "message" },
    });

    const friendFlowLogs = await readJsonLogLines(getFriendFlowTestLogPath(userDataPath));
    expect(friendFlowLogs).toHaveLength(1);
    expect(friendFlowLogs[0].channel).toBe("friend-route");
  });

  it("mirrors router logs to friend-flow file", async () => {
    const userDataPath = await createTempUserDataPath();
    await appendTestLogRecord(userDataPath, {
      channel: "router",
      event: { stage: "app-bootstrap:result", status: "failed" },
    });

    const allLogs = await readJsonLogLines(getTestLogPath(userDataPath));
    const friendFlowLogs = await readJsonLogLines(getFriendFlowTestLogPath(userDataPath));

    expect(allLogs).toHaveLength(1);
    expect(friendFlowLogs).toHaveLength(1);
    expect(friendFlowLogs[0].channel).toBe("router");
  });
});

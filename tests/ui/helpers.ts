import fs from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

export const disableAnimations = async (page: Page) => {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
    `,
  });
};

export const ensureOnboarded = async (page: Page) => {
  const createButton = page.getByTestId("onboarding-create-button");
  if (await createButton.isVisible()) {
    await page.getByTestId("onboarding-display-name").fill("Tester");
    await page.getByTestId("onboarding-confirm-checkbox").check();
    await createButton.click();
  }
  await expect(page.getByTestId("open-settings")).toBeVisible();
};

export const openNetworkSettings = async (page: Page) => {
  await page.getByTestId("open-settings").click();
  const networkButton = page.getByTestId("settings-network-button");
  await expect(networkButton).toBeVisible();
  await networkButton.click();
  await expect(page.getByTestId("network-mode-directP2P")).toBeVisible();
};

export const getSelectedConversationId = async (page: Page) => {
  const selected = page.locator(
    '[data-selected="true"][data-testid^="conversation-row-"]'
  );
  if ((await selected.count()) === 0) return null;
  return selected.first().getAttribute("data-conversation-id");
};

export const ensureChatsList = async (page: Page) => {
  const chatsToggle = page.getByTestId("list-mode-chats");
  if (await chatsToggle.isVisible()) {
    await chatsToggle.click();
  }
};

export type FriendFlowLogRecord = {
  at: string;
  channel: string;
  event: unknown;
};

export type FriendFlowAction = "add" | "accept" | "decline";

type TestLogApi = {
  getFriendFlowPath?: () => Promise<string>;
};

type WindowWithTestLog = Window & {
  testLog?: TestLogApi;
};

const FRIEND_FLOW_BUFFER_KEY = "__nkcFriendFlowLogs";
const FRIEND_FLOW_COLLECTOR_KEY = "__nkcFriendFlowCollectorAttached";

const toFriendFlowRecordKey = (record: FriendFlowLogRecord) => {
  let eventPart = "";
  try {
    eventPart = JSON.stringify(record.event);
  } catch {
    eventPart = String(record.event);
  }
  return `${record.at}|${record.channel}|${eventPart}`;
};

export const enableFriendFlowCapture = async (page: Page) => {
  await page.addInitScript(
    ({ addEventName, routeEventName, bufferKey, collectorKey }) => {
      const globalWindow = window as typeof window & Record<string, unknown>;
      if (!Array.isArray(globalWindow[bufferKey])) {
        globalWindow[bufferKey] = [];
      }
      if (globalWindow[collectorKey]) return;
      const pushRecord = (channel: string, eventDetail: unknown) => {
        const records = globalWindow[bufferKey];
        if (!Array.isArray(records)) return;
        records.push({
          at: new Date().toISOString(),
          channel,
          event: eventDetail,
        });
      };
      window.addEventListener(addEventName, (event) => {
        pushRecord("friend-add", (event as CustomEvent<unknown>).detail);
      });
      window.addEventListener(routeEventName, (event) => {
        pushRecord("friend-route", (event as CustomEvent<unknown>).detail);
      });
      globalWindow[collectorKey] = true;
    },
    {
      addEventName: "nkc:test:friend-add",
      routeEventName: "nkc:test:friend-route",
      bufferKey: FRIEND_FLOW_BUFFER_KEY,
      collectorKey: FRIEND_FLOW_COLLECTOR_KEY,
    }
  );
};

export const resetFriendFlowLogs = async (page: Page) => {
  const logPath = await page.evaluate(async () => {
    const api = (window as WindowWithTestLog).testLog;
    if (!api?.getFriendFlowPath) return null;
    try {
      return await api.getFriendFlowPath();
    } catch {
      return null;
    }
  });
  if (logPath) {
    try {
      await fs.writeFile(logPath, "", "utf8");
    } catch {
      // Best-effort cleanup.
    }
  }
  await page.evaluate((bufferKey) => {
    const globalWindow = window as typeof window & Record<string, unknown>;
    globalWindow[bufferKey] = [];
  }, FRIEND_FLOW_BUFFER_KEY);
};

export const readFriendFlowLogs = async (page: Page): Promise<FriendFlowLogRecord[]> => {
  const logPath = await page.evaluate(async () => {
    const api = (window as WindowWithTestLog).testLog;
    if (!api?.getFriendFlowPath) return null;
    try {
      return await api.getFriendFlowPath();
    } catch {
      return null;
    }
  });
  let raw = "";
  if (logPath) {
    try {
      raw = await fs.readFile(logPath, "utf8");
    } catch {
      raw = "";
    }
  }
  const fileLogs = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as FriendFlowLogRecord;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is FriendFlowLogRecord => Boolean(entry));
  const inPageLogs = await page.evaluate((bufferKey) => {
    const globalWindow = window as typeof window & Record<string, unknown>;
    const logs = globalWindow[bufferKey];
    if (!Array.isArray(logs)) return [];
    return logs.filter((entry) => Boolean(entry && typeof entry === "object"));
  }, FRIEND_FLOW_BUFFER_KEY);
  const browserLogs = inPageLogs.filter((entry): entry is FriendFlowLogRecord => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<FriendFlowLogRecord>;
    return typeof candidate.channel === "string";
  });
  const uniqueLogs = new Map<string, FriendFlowLogRecord>();
  [...fileLogs, ...browserLogs].forEach((record) => {
    uniqueLogs.set(toFriendFlowRecordKey(record), record);
  });
  return [...uniqueLogs.values()].sort((a, b) => a.at.localeCompare(b.at));
};

export const filterFriendFlowLogsByAction = (
  logs: FriendFlowLogRecord[],
  action: FriendFlowAction
) => {
  if (action === "add") {
    return logs.filter((record) => record.channel === "friend-add");
  }
  const frameType = action === "accept" ? "friend_accept" : "friend_decline";
  return logs.filter((record) => {
    if (record.channel !== "friend-route") return false;
    if (!record.event || typeof record.event !== "object") return false;
    return (record.event as { frameType?: unknown }).frameType === frameType;
  });
};

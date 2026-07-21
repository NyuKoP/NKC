import { isInfoCollectionEnabled } from "../diagnostics/infoCollectionConfig";

type TestLogApi = {
  append?: (payload: { channel: string; event: unknown; at?: string }) => Promise<unknown>;
  getPath?: () => Promise<string>;
  getFriendFlowPath?: () => Promise<string>;
};

const getTestLogApi = () => {
  const candidate = globalThis as { window?: { testLog?: TestLogApi } };
  return candidate.window?.testLog ?? null;
};

export const appendTestLog = async (channel: string, event: unknown) => {
  if (!isInfoCollectionEnabled()) return;
  if (!channel.trim()) return;
  const api = getTestLogApi();
  if (!api?.append) return;
  try {
    await api.append({
      channel: channel.trim(),
      event,
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[test-log] append failed", error);
  }
};

export const getTestLogPath = async () => {
  if (!isInfoCollectionEnabled()) return null;
  const api = getTestLogApi();
  if (!api?.getPath) return null;
  try {
    return await api.getPath();
  } catch {
    return null;
  }
};

export const getFriendFlowTestLogPath = async () => {
  if (!isInfoCollectionEnabled()) return null;
  const api = getTestLogApi();
  if (!api?.getFriendFlowPath) return null;
  try {
    return await api.getFriendFlowPath();
  } catch {
    return null;
  }
};

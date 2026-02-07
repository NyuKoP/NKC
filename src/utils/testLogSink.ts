export const appendTestLog = async (channel: string, event: unknown) => {
  if (!channel.trim()) return;
  const api = window.testLog;
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
  const api = window.testLog;
  if (!api?.getPath) return null;
  try {
    return await api.getPath();
  } catch {
    return null;
  }
};

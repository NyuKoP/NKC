import { beforeEach, describe, expect, it, vi } from "vitest";

const secretStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../secretStore", () => ({
  getSecretStore: () => secretStore,
}));

import { clearSession, getSession, setSession } from "../session";

describe("session", () => {
  beforeEach(async () => {
    await clearSession();
    vi.clearAllMocks();
  });

  it("keeps the vault key in memory without persisting it", async () => {
    const vaultKey = new Uint8Array([1, 2, 3, 4]);

    await setSession(vaultKey);

    expect(secretStore.set).not.toHaveBeenCalled();
    await expect(getSession()).resolves.toMatchObject({ vaultKey });
  });

  it("removes a legacy persisted session instead of automatically logging in", async () => {
    await expect(getSession()).resolves.toBeNull();

    expect(secretStore.get).not.toHaveBeenCalled();
    expect(secretStore.remove).toHaveBeenCalledWith("nkc_session_v1");
  });
});

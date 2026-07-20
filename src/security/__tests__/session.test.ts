import { beforeEach, describe, expect, it, vi } from "vitest";

const secretStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn().mockResolvedValue(undefined),
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

  it("persists the vault key in the encrypted secret store", async () => {
    const vaultKey = new Uint8Array([1, 2, 3, 4]);

    await setSession(vaultKey);

    expect(secretStore.set).toHaveBeenCalledWith(
      "nkc_session_v1",
      expect.stringContaining('"vaultKey_b64":"AQIDBA"')
    );
    await expect(getSession()).resolves.toMatchObject({ vaultKey });
  });

  it("restores a valid persisted session after an app restart", async () => {
    const expiresAt = Date.now() + 60_000;
    secretStore.get.mockResolvedValueOnce(
      JSON.stringify({
        v: 1,
        vaultKey_b64: "AQIDBA",
        createdAt: Date.now(),
        expiresAt,
      })
    );

    await expect(getSession()).resolves.toMatchObject({
      vaultKey: new Uint8Array([1, 2, 3, 4]),
      expiresAt,
    });
    expect(secretStore.get).toHaveBeenCalledWith("nkc_session_v1");
  });
});

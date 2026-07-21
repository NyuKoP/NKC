import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getBinaryPath } from "../../componentRegistry";
import { removeTorInstallationArtifacts } from "../cleanupTor";
import { installTor } from "../installTor";

const runLive = process.env.NKC_TOR_REINSTALL_LIVE === "1" ? it : it.skip;
let testRoot: string | null = null;

afterAll(async () => {
  if (testRoot) await fs.rm(testRoot, { recursive: true, force: true });
});

describe("Tor live reinstall", () => {
  runLive("downloads, completely removes, and downloads Tor 15.0.18 again", async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nkc-tor-reinstall-live-"));

    const firstInstall = await installTor(testRoot, "15.0.18");
    const firstBinary = path.join(firstInstall.installPath, getBinaryPath("tor"));
    await expect(fs.stat(firstBinary)).resolves.toMatchObject({ isFile: expect.any(Function) });

    await removeTorInstallationArtifacts(testRoot);
    await expect(fs.stat(path.join(testRoot, "onion", "components", "tor"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const secondInstall = await installTor(testRoot, "15.0.18");
    const secondBinary = path.join(secondInstall.installPath, getBinaryPath("tor"));
    const secondStat = await fs.stat(secondBinary);
    expect(secondStat.isFile()).toBe(true);
  }, 180_000);
});

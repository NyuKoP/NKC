import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTorInstallationArtifacts } from "../cleanupTor";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("removeTorInstallationArtifacts", () => {
  it("removes Tor versions and Tor download remnants but preserves runtime identity data", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nkc-tor-cleanup-"));
    roots.push(root);
    const torComponents = path.join(root, "onion", "components", "tor", "15.0.18");
    const torTemp = path.join(root, "onion", "tmp-old-download");
    const torIdentity = path.join(root, "nkc-tor", "hs-onion");
    await fs.mkdir(torComponents, { recursive: true });
    await fs.mkdir(torTemp, { recursive: true });
    await fs.mkdir(torIdentity, { recursive: true });
    await fs.writeFile(path.join(torTemp, "tor-expert-bundle-windows-x86_64-15.0.18.tar.gz"), "x");
    await fs.writeFile(path.join(torIdentity, "private_key"), "preserve");

    const removed = await removeTorInstallationArtifacts(root);

    await expect(fs.stat(path.join(root, "onion", "components", "tor"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(torTemp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(torIdentity, "private_key"), "utf8")).resolves.toBe(
      "preserve"
    );
    expect(removed).toContain(torTemp);
  });
});

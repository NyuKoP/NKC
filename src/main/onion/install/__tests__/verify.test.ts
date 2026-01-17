import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySha256 } from "../verify";

const sha256 = (data: string) => crypto.createHash("sha256").update(data).digest("hex");

describe("verifySha256", () => {
  it("verifies SHA256 matches", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "onion-verify-"));
    const filePath = path.join(tmp, "payload.txt");
    await fs.writeFile(filePath, "hello");
    await expect(verifySha256(filePath, sha256("hello"))).resolves.toBeUndefined();
  });

  it("throws on mismatch", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "onion-verify-"));
    const filePath = path.join(tmp, "payload.txt");
    await fs.writeFile(filePath, "hello");
    await expect(verifySha256(filePath, sha256("bye"))).rejects.toThrow("SHA256 mismatch");
  });
});

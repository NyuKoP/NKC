import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCurrentPointer, swapWithRollback } from "../swapperRollback";

describe("swapperRollback", () => {
  it("rolls back to previous pointer", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "onion-swap-"));
    await swapWithRollback(userDataDir, "tor", { version: "1.0.0", path: "v1" });
    const rollback = await swapWithRollback(userDataDir, "tor", { version: "2.0.0", path: "v2" });
    await rollback();
    const current = await readCurrentPointer(userDataDir, "tor");
    expect(current?.version).toBe("1.0.0");
    expect(current?.path).toBe("v1");
  });
});

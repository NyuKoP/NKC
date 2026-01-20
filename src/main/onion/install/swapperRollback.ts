import fs from "node:fs/promises";
import path from "node:path";
import type { OnionNetwork } from "../../../net/netConfig";

type CurrentPointer = {
  version: string;
  path: string;
};

const currentFileName = "current.json";

const getComponentRoot = (userDataDir: string, network: OnionNetwork) =>
  path.join(userDataDir, "onion", "components", network);

const getPointerPath = (userDataDir: string, network: OnionNetwork) =>
  path.join(getComponentRoot(userDataDir, network), currentFileName);

const writeJsonAtomic = async (filePath: string, data: CurrentPointer) => {
  const tempPath = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
  await fs.rename(tempPath, filePath);
};

export const readCurrentPointer = async (userDataDir: string, network: OnionNetwork) => {
  try {
    const raw = await fs.readFile(getPointerPath(userDataDir, network), "utf8");
    return JSON.parse(raw) as CurrentPointer;
  } catch {
    return null;
  }
};

export const swapWithRollback = async (
  userDataDir: string,
  network: OnionNetwork,
  next: CurrentPointer
) => {
  const previous = await readCurrentPointer(userDataDir, network);
  await writeJsonAtomic(getPointerPath(userDataDir, network), next);
  return async () => {
    if (previous) {
      await writeJsonAtomic(getPointerPath(userDataDir, network), previous);
    }
  };
};

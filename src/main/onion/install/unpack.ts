import { execFile } from "node:child_process";
import path from "node:path";

export const unpackArchive = async (archivePath: string, destDir: string) => {
  const lowerPath = archivePath.toLowerCase();
  if (lowerPath.endsWith(".zip")) {
    await new Promise<void>((resolve, reject) => {
      if (process.platform === "win32") {
        execFile(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`,
          ],
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
        return;
      }
      execFile("unzip", ["-o", archivePath, "-d", destDir], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }
  if (
    lowerPath.endsWith(".tar.gz") ||
    lowerPath.endsWith(".tgz") ||
    lowerPath.endsWith(".tar.xz")
  ) {
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-xf", archivePath, "-C", destDir], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }
  throw new Error("Unsupported archive format");
};

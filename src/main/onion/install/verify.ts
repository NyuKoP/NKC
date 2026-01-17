import crypto from "node:crypto";
import fs from "node:fs";

const hashFile = async (filePath: string) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
};

export const verifySha256 = async (filePath: string, expectedSha256: string) => {
  const actual = await hashFile(filePath);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error("SHA256 mismatch");
  }
};

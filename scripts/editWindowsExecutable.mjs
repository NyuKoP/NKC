import fs from "node:fs";
import path from "node:path";
import editResources from "resedit-cli";

const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
const executablePath = path.join(process.cwd(), "release", "win-unpacked", "NKC.exe");
const outputPath = path.join(process.cwd(), "release", "win-unpacked", "NKC.resources.exe");
const iconPath = path.join(process.cwd(), "build", "icon.ico");

if (!fs.existsSync(executablePath)) {
  throw new Error(`Windows executable not found: ${executablePath}`);
}
if (!fs.existsSync(iconPath)) {
  throw new Error(`Windows icon not found: ${iconPath}`);
}

const numericVersion = `${packageJson.version}.0`.split(".").slice(0, 4).join(".");
await editResources({
  in: executablePath,
  out: outputPath,
  definition: {
    icons: [{ id: 1, sourceFile: iconPath }],
    version: {
      lang: 1033,
      companyName: "NyuKoP",
      fileDescription: "NKC serverless secure chat",
      fileVersion: numericVersion,
      internalName: "NKC",
      legalCopyright: "Copyright (c) 2026 NyuKoP",
      originalFileName: "NKC.exe",
      productName: "NKC",
      productVersion: numericVersion,
    },
  },
});
fs.copyFileSync(outputPath, executablePath);
fs.unlinkSync(outputPath);

console.info(`Updated Windows resources: ${executablePath}`);

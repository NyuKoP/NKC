import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const sourcePath = path.join(projectRoot, "assets", "nkc-app-icon.png");
const hdSourcePath = path.join(projectRoot, "assets", "nkc-app-icon-hd.png");
const markSourcePath = path.join(projectRoot, "assets", "nkc-n-mark.png");
const hdMarkSourcePath = path.join(projectRoot, "assets", "nkc-n-mark-hd.png");
const buildDirectory = path.join(projectRoot, "build");
const publicDirectory = path.join(projectRoot, "public");

if (!fs.existsSync(sourcePath)) {
  throw new Error(`NKC app icon source is missing: ${sourcePath}`);
}
for (const requiredPath of [hdSourcePath, markSourcePath, hdMarkSourcePath]) {
  if (!fs.existsSync(requiredPath)) throw new Error(`NKC image asset is missing: ${requiredPath}`);
}

const png = fs.readFileSync(sourcePath);
const hdPng = fs.readFileSync(hdSourcePath);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
if (!png.subarray(0, pngSignature.length).equals(pngSignature)) {
  throw new Error(`NKC app icon source is not a PNG file: ${sourcePath}`);
}

const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader[6] = 0;
icoHeader[7] = 0;
icoHeader[8] = 0;
icoHeader[9] = 0;
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);
const ico = Buffer.concat([icoHeader, png]);

fs.mkdirSync(buildDirectory, { recursive: true });
fs.mkdirSync(publicDirectory, { recursive: true });
fs.writeFileSync(path.join(buildDirectory, "icon.png"), hdPng);
fs.writeFileSync(path.join(buildDirectory, "icon.ico"), ico);
fs.writeFileSync(path.join(publicDirectory, "icon.png"), hdPng);
fs.copyFileSync(hdMarkSourcePath, path.join(publicDirectory, "nkc-n-mark.png"));
console.info(`Copied the NKC app icon to ${buildDirectory} and ${publicDirectory}`);

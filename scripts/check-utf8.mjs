import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.cjs",
  "*.mjs",
  "*.json",
  "*.md",
  "*.css",
  "*.html",
  "*.yml",
  "*.yaml",
];

const ignore = [
  "!node_modules/**",
  "!dist/**",
  "!dist-electron/**",
  "!playwright-report/**",
  "!test-results/**",
];

const args = ["--files", ...patterns.flatMap((p) => ["-g", p]), ...ignore.flatMap((p) => ["-g", p])];

let output = "";
try {
  output = execSync(`rg ${args.join(" ")}`, { encoding: "utf8" });
} catch (error) {
  console.error("Failed to list files with rg.");
  process.exit(2);
}

const files = output.split(/\r?\n/).filter(Boolean);
const decoder = new TextDecoder("utf-8", { fatal: true });
const bad = [];

for (const file of files) {
  const buf = readFileSync(file);
  try {
    decoder.decode(buf);
  } catch {
    bad.push(file);
  }
}

if (bad.length > 0) {
  console.error("Non-UTF-8 files detected:\n" + bad.join("\n"));
  process.exit(1);
}

console.log("All checked files are valid UTF-8.");

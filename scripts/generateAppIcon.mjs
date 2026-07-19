import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SIZE = 256;
const SCALE = 4;
const HI_SIZE = SIZE * SCALE;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
};

const roundedRectDistance = (x, y, left, top, right, bottom, radius) => {
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const halfX = (right - left) / 2 - radius;
  const halfY = (bottom - top) / 2 - radius;
  const dx = Math.abs(x - centerX) - halfX;
  const dy = Math.abs(y - centerY) - halfY;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
};

const insideTriangle = (x, y, ax, ay, bx, by, cx, cy) => {
  const edge = (x1, y1, x2, y2) => (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  const a = edge(ax, ay, bx, by);
  const b = edge(bx, by, cx, cy);
  const c = edge(cx, cy, ax, ay);
  return (a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0);
};

const high = new Uint8Array(HI_SIZE * HI_SIZE * 4);
for (let y = 0; y < HI_SIZE; y += 1) {
  for (let x = 0; x < HI_SIZE; x += 1) {
    const px = (x + 0.5) / SCALE;
    const py = (y + 0.5) / SCALE;
    const offset = (y * HI_SIZE + x) * 4;
    const background = roundedRectDistance(px, py, 10, 10, 246, 246, 54) <= 0;
    if (!background) continue;

    const blend = Math.min(1, Math.max(0, (px + py) / (SIZE * 2)));
    high[offset] = Math.round(36 + 21 * blend);
    high[offset + 1] = Math.round(102 + 45 * blend);
    high[offset + 2] = Math.round(235 + 10 * blend);
    high[offset + 3] = 255;

    const bubbleDistance = roundedRectDistance(px, py, 43, 43, 213, 177, 31);
    const bubbleOutline = bubbleDistance <= 0 && bubbleDistance >= -12;
    const bubbleTail = insideTriangle(px, py, 73, 169, 103, 169, 68, 208);
    const bubbleTailCutout = insideTriangle(px, py, 82, 169, 100, 169, 76, 192);
    if (bubbleOutline || (bubbleTail && !bubbleTailCutout)) {
      high[offset] = 255;
      high[offset + 1] = 255;
      high[offset + 2] = 255;
    }

    const lockBody = roundedRectDistance(px, py, 91, 103, 165, 158, 12) <= 0;
    const shackleOuter = Math.hypot((px - 128) / 30, (py - 105) / 35) <= 1;
    const shackleInner = Math.hypot((px - 128) / 17, (py - 105) / 22) <= 1;
    const shackle = shackleOuter && !shackleInner && py <= 112;
    if (lockBody || shackle) {
      high[offset] = 255;
      high[offset + 1] = 255;
      high[offset + 2] = 255;
    }

    const keyhole = Math.hypot(px - 128, py - 129) <= 7 || (px >= 124 && px <= 132 && py >= 129 && py <= 144);
    if (keyhole) {
      high[offset] = 45;
      high[offset + 1] = 119;
      high[offset + 2] = 239;
    }
  }
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const outputOffset = (y * SIZE + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      let sum = 0;
      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          const inputOffset = (((y * SCALE + sy) * HI_SIZE + x * SCALE + sx) * 4) + channel;
          sum += high[inputOffset];
        }
      }
      rgba[outputOffset + channel] = Math.round(sum / (SCALE * SCALE));
    }
  }
}

const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const rowOffset = y * (SIZE * 4 + 1);
  rows[rowOffset] = 0;
  rgba.copy(rows, rowOffset + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk("IHDR", ihdr),
  pngChunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
  pngChunk("IEND", Buffer.alloc(0)),
]);

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

const outputDirectory = path.join(process.cwd(), "build");
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "icon.png"), png);
fs.writeFileSync(path.join(outputDirectory, "icon.ico"), Buffer.concat([icoHeader, png]));
console.info(`Generated NKC app icons in ${outputDirectory}`);

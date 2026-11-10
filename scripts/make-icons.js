// Generates the extension icons (orange rounded square, white "download" arrow over a tray)
// as PNGs with no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'extension', 'icons');

function crc32(buf) {
  let c;
  const table = crc32.t || (crc32.t = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape tests in unit coordinates (0..1).
const inRoundRect = (u, v, r) => {
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
};
const inArrow = (u, v) => {
  const shaft = Math.abs(u - 0.5) <= 0.075 && v >= 0.18 && v <= 0.52;
  const head = v >= 0.42 && v <= 0.66 && Math.abs(u - 0.5) <= (0.66 - v) * 1.15;
  return shaft || head;
};
const inTray = (u, v) => {
  const bottom = v >= 0.74 && v <= 0.82 && u >= 0.2 && u <= 0.8;
  const sides = v >= 0.6 && v <= 0.82 && ((u >= 0.2 && u <= 0.28) || (u >= 0.72 && u <= 0.8));
  return bottom || sides;
};

function render(size) {
  const ss = 4; // supersampling for smooth edges
  return png(size, (x, y) => {
    let bg = 0;
    let fg = 0;
    for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) {
      const u = (x + (i + 0.5) / ss) / size;
      const v = (y + (j + 0.5) / ss) / size;
      if (inRoundRect(u, v, 0.22)) {
        bg++;
        if (inArrow(u, v) || inTray(u, v)) fg++;
      }
    }
    const n = ss * ss;
    if (!bg) return [0, 0, 0, 0];
    const t = fg / bg;
    // Orange gradient-ish base (#e8590c) blended with white glyph.
    const base = [232, 89, 12];
    const col = base.map((c) => Math.round(c + (255 - c) * t));
    return [...col, Math.round((bg / n) * 255)];
  });
}

fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(outDir, `icon${s}.png`), render(s));
console.log(`icons written to ${outDir}`);

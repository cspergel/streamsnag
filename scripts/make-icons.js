// Generates the extension icons (orange rounded square, a white arrow down into an open book) as PNGs with
// no dependencies. The same drawing is brand/icon-book-line.svg (MARK below); the website's icons are made
// from it too (planning/site-tooling/make-icons.mjs imports render() and ico() from here).
// icon128 follows the Chrome Web Store's rule: 96 x 96 artwork with 16 px of clear space round it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const outDir = path.join(path.dirname(path.dirname(HERE)), 'extension', 'icons');

export const ORANGE = '#e8590c';
// The mark as SVG, on a 32 x 32 grid. Keep it in step with the shapes below.
export const MARK_INNER = '<path d="M16 5.6v9.4m0 0l-4.2-4.2M16 15l4.2-4.2" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><g fill="#fff" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"><path d="M15.1 20.4c-2.3-1.5-5.1-1.9-8.1-1.4v6.7c3-.5 5.8-.1 8.1 1.4z"/><path d="M16.9 20.4c2.3-1.5 5.1-1.9 8.1-1.4v6.7c-3-.5-5.8-.1-8.1 1.4z"/></g>';
export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${ORANGE}"/>${MARK_INNER}</svg>`;

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
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- The shapes, in the SVG's own 32-unit coordinates -------------------------------------------------
const cubic = (p0, p1, p2, p3, n = 24) => Array.from({ length: n }, (_, i) => {
  const t = (i + 1) / n, s = 1 - t;
  return [s * s * s * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t * t * t * p3[0],
    s * s * s * p0[1] + 3 * s * s * t * p1[1] + 3 * s * t * t * p2[1] + t * t * t * p3[1]];
});
// Left page: M15.1 20.4 c-2.3-1.5-5.1-1.9-8.1-1.4 v6.7 c3-.5 5.8-.1 8.1 1.4 z
const LEFT = [[15.1, 20.4], ...cubic([15.1, 20.4], [12.8, 18.9], [10, 18.5], [7, 19]),
  [7, 25.7], ...cubic([7, 25.7], [10, 25.2], [12.8, 25.6], [15.1, 27.1])];
const RIGHT = LEFT.map(([x, y]) => [32 - x, y]);
const PAGES = [LEFT, RIGHT];
const PAGE_EDGE = 1.1 / 2; // the pages' 1.1 stroke with round joins
const ARROW = [[[16, 5.6], [16, 15]], [[16, 15], [11.8, 10.8]], [[16, 15], [20.2, 10.8]]];
const ARROW_HALF = 2.6 / 2; // round caps and joins

const segDist2 = (x, y, [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  const ex = ax + t * dx - x, ey = ay + t * dy - y;
  return ex * ex + ey * ey;
};
const inPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const nearPoly = (x, y, poly, r2) => poly.some((p, i) => segDist2(x, y, p, poly[(i + 1) % poly.length]) <= r2);
const inGlyph = (x, y) => {
  if (y >= 4 && y <= 16.5) return ARROW.some(([a, b]) => segDist2(x, y, a, b) <= ARROW_HALF * ARROW_HALF);
  if (y >= 17.8 && y <= 28) return PAGES.some((p) => inPoly(x, y, p) || nearPoly(x, y, p, PAGE_EDGE * PAGE_EDGE));
  return false;
};
const inSquare = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 32 - r);
  const cy = Math.min(Math.max(y, r), 32 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/**
 * The mark as a PNG of size x size pixels.
 * pad: clear space on each side, in pixels (icon128 uses 16). rounded: false for a touch icon, which the
 * phone rounds itself.
 */
export function render(size, { pad = 0, rounded = true } = {}) {
  const art = size - 2 * pad;
  const ss = art <= 64 ? 8 : art <= 200 ? 5 : 3; // samples per side of each pixel
  const base = [0xe8, 0x59, 0x0c];
  const r = rounded ? 8 : 0;
  return png(size, (px, py) => {
    let bg = 0;
    let fg = 0;
    for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) {
      const x = ((px - pad + (i + 0.5) / ss) / art) * 32;
      const y = ((py - pad + (j + 0.5) / ss) / art) * 32;
      if (x < 0 || y < 0 || x > 32 || y > 32 || !inSquare(x, y, r)) continue;
      bg++;
      if (inGlyph(x, y)) fg++;
    }
    if (!bg) return [0, 0, 0, 0];
    const t = fg / bg;
    return [...base.map((c) => Math.round(c + (255 - c) * t)), Math.round((bg / (ss * ss)) * 255)];
  });
}

/** A .ico holding the given PNGs (each { size, data }), as browsers read favicons. */
export function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head[o] = size >= 256 ? 0 : size;
    head[o + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, o + 4); // colour planes
    head.writeUInt16LE(32, o + 6); // bits per pixel
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((im) => im.data)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const s of [16, 32, 48]) fs.writeFileSync(path.join(outDir, `icon${s}.png`), render(s));
  fs.writeFileSync(path.join(outDir, 'icon128.png'), render(128, { pad: 16 }));
  fs.writeFileSync(path.join(outDir, 'mark.svg'), MARK + '\n');
  console.log(`icons written to ${outDir}`);
}

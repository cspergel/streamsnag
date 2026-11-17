// The icon: one drawing (scripts/make-icons.js) for the toolbar, the store, StreamSnag's own pages and the
// website. These checks fail if a committed icon is not what the drawing makes (so `npm run build` cannot
// quietly bring an old icon back), if the 128 px icon loses the store's clear border, or if a copy of the
// mark somewhere still has another shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MARK, MARK_INNER, render, ico } from '../scripts/make-icons.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ICONS = path.join(ROOT, 'extension', 'icons');

/** Pixels of a PNG as the generator writes it (8-bit RGBA, no row filters): px(x, y) -> [r, g, b, a]. */
function decode(buf) {
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  let o = 8;
  let size = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString();
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') size = data.readUInt32BE(0);
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const row = size * 4 + 1;
  return { size, px: (x, y) => { assert.equal(raw[y * row], 0); return [...raw.subarray(y * row + 1 + x * 4, y * row + 5 + x * 4)]; } };
}
const ORANGE = [0xe8, 0x59, 0x0c, 255];
const WHITE = [255, 255, 255, 255];

test('the extension icons are exactly what the drawing makes', () => {
  for (const n of [16, 32, 48]) assert.ok(fs.readFileSync(path.join(ICONS, `icon${n}.png`)).equals(render(n)), `icon${n}.png`);
  assert.ok(fs.readFileSync(path.join(ICONS, 'icon128.png')).equals(render(128, { pad: 16 })), 'icon128.png');
  assert.equal(fs.readFileSync(path.join(ICONS, 'mark.svg'), 'utf8'), MARK + '\n');
});

test('icon128 is 96 px of artwork with 16 px of clear space on every side (the store\'s rule)', () => {
  const { size, px } = decode(fs.readFileSync(path.join(ICONS, 'icon128.png')));
  assert.equal(size, 128);
  for (let i = 0; i < 128; i++) {
    for (const [x, y] of [[i, 15], [i, 112], [15, i], [112, i]]) assert.equal(px(x, y)[3], 0, `(${x}, ${y}) is clear`);
  }
  // The artwork starts right at the border: the square's straight left edge, half way down.
  assert.deepEqual(px(16, 64), ORANGE);
  assert.deepEqual(px(111, 64), ORANGE);
});

test('the shapes are where the SVG puts them: arrow, a gap, then the two pages either side of the spine', () => {
  // 96 px: 3 px per unit of the 32-unit drawing, so pixel p covers units p/3 to (p+1)/3.
  const { px } = decode(render(96));
  assert.deepEqual(px(47, 27), WHITE, 'the arrow\'s shaft (x 15.7-16, y 9)');
  assert.deepEqual(px(47, 51), ORANGE, 'between the arrow\'s tip (y 16.3) and the book (y 17)');
  assert.deepEqual(px(30, 69), WHITE, 'the left page (x 10, y 23)');
  assert.deepEqual(px(66, 69), WHITE, 'the right page (x 22, y 23)');
  // The pages end at x 15.65 and start at 16.35 (15.1 and 16.9, less half their 1.1 outline).
  assert.deepEqual(px(47, 69), ORANGE, 'the spine, left half (x 15.7-16)');
  assert.deepEqual(px(48, 69), ORANGE, 'the spine, right half (x 16-16.3)');
  assert.notDeepEqual(px(46, 69), ORANGE, 'the left page\'s edge (x 15.3-15.7)');
  assert.deepEqual(px(12, 69), ORANGE, 'left of the book (x 4)');
  assert.deepEqual(px(9, 9), ORANGE, 'inside the rounded corner\'s curve (x 3, y 3)');
  assert.equal(px(0, 0)[3], 0, 'the corner itself is cut away');
});

test('a touch icon is square to the corners (the phone rounds it); the mark is not', () => {
  assert.deepEqual(decode(render(180, { rounded: false })).px(0, 0), ORANGE);
  assert.equal(decode(render(180)).px(0, 0)[3], 0);
});

test('ico() holds each PNG whole, with its size and where it starts', () => {
  const images = [16, 32, 48].map((size) => ({ size, data: render(size) }));
  const buf = ico(images);
  assert.equal(buf.readUInt16LE(2), 1);
  assert.equal(buf.readUInt16LE(4), 3);
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    assert.equal(buf[e], size);
    assert.equal(buf[e + 1], size);
    assert.equal(buf.readUInt16LE(e + 6), 32);
    assert.equal(buf.readUInt32LE(e + 8), data.length);
    const at = buf.readUInt32LE(e + 12);
    assert.ok(buf.subarray(at, at + data.length).equals(data), `the ${size} px image`);
  });
  assert.equal(buf.length, 6 + 16 * 3 + images.reduce((s, im) => s + im.data.length, 0));
});

test('the website and brand/ carry the same mark', { skip: !fs.existsSync(path.join(ROOT, 'docs', 'icon.svg')) }, () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'docs', 'icon.svg'), 'utf8'), MARK + '\n');
  const brand = path.join(ROOT, 'brand', 'icon-book-line.svg');
  if (fs.existsSync(brand)) assert.equal(fs.readFileSync(brand, 'utf8').trim(), MARK);
  const ico16 = fs.readFileSync(path.join(ROOT, 'docs', 'favicon.ico'));
  assert.ok(ico16.equals(ico([16, 32, 48].map((size) => ({ size, data: render(size) })))), 'docs/favicon.ico');
  const pages = fs.readdirSync(path.join(ROOT, 'docs'), { recursive: true }).filter((f) => f.endsWith('.html'));
  let marks = 0;
  for (const f of pages) {
    const s = fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8');
    assert.ok(!s.includes('M16 8v11'), `${f} still has the old mark`);
    if (s.includes('id="i-mark"')) { marks++; assert.ok(s.includes(MARK_INNER), `${f}: its mark is the drawing`); }
  }
  assert.ok(marks > 10, `${marks} pages carry the mark`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSegments, coverageNote, condenseCaptions, soleVideo, SEGMENT_CAP, GAP_MARK } from '../extension/lib/captions.js';
import { mergeVttSegments, captionsToText } from '../extension/lib/vtt.js';

const pad = (n) => String(n).padStart(2, '0');
const at = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}.000`;

test('readSegments reads every piece of a long lecture, in order, a few at a time', async () => {
  // Three hours of six-second caption pieces: 1800 of them (the old limit stopped at 600, the first hour).
  const urls = Array.from({ length: 1800 }, (_, i) => `https://cdn.example/subs/${i}.vtt`);
  let running = 0;
  let most = 0;
  const fetchOne = async (url) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 0));
    running--;
    const i = Number(/(\d+)\.vtt$/.exec(url)[1]);
    return `WEBVTT\n\n${at(i * 6)} --> ${at(i * 6 + 6)}\nPart ${i}.\n`;
  };
  const got = await readSegments(urls, fetchOne, { limit: 6 });
  assert.deepEqual([got.total, got.read, got.missed], [1800, 1800, 0]);
  assert.equal(got.texts.length, 1800);
  assert.match(got.texts[0], /Part 0\./);
  assert.match(got.texts[1799], /Part 1799\./);
  assert.ok(most > 1 && most <= 6, `at most six at once (saw ${most})`);
  assert.equal(coverageNote(got), '');
  // The transcript made from them reaches the end of the lecture.
  const text = captionsToText(mergeVttSegments(got.texts));
  assert.match(text, /Part 1799\./);
  assert.match(text.split('\n').at(-1), /^\[2:59:30\]/);
  assert.ok(SEGMENT_CAP >= 20000, 'the safety cap is far above any lecture');
});

test('readSegments: a piece that fails once is tried again; one that keeps failing is counted, not hidden', async () => {
  const tries = new Map();
  const fetchOne = async (url) => {
    tries.set(url, (tries.get(url) || 0) + 1);
    if (url === 'flaky' && tries.get(url) === 1) throw new Error('reset');
    if (url === 'dead') throw new Error('HTTP 404');
    return `text of ${url}`;
  };
  const got = await readSegments(['a', 'flaky', 'dead', 'b'], fetchOne, { limit: 2 });
  assert.deepEqual(got.texts, ['text of a', 'text of flaky', '', 'text of b']);
  assert.deepEqual([got.total, got.read, got.missed], [4, 4, 1]);
  assert.deepEqual([tries.get('flaky'), tries.get('dead'), tries.get('a')], [2, 2, 1]);
  assert.equal(coverageNote(got), '1 of 4 caption parts could not be read, so some lines are missing.');
  // No second try when asked for none.
  tries.clear();
  const strict = await readSegments(['flaky'], fetchOne, { retries: 0 });
  assert.deepEqual([strict.texts, strict.missed], [[''], 1]);
});

test('readSegments: the safety cap is reported, never passed over in silence', async () => {
  const urls = Array.from({ length: 25 }, (_, i) => `u${i}`);
  const asked = [];
  const got = await readSegments(urls, async (u) => { asked.push(u); return u; }, { cap: 10 });
  assert.deepEqual([got.total, got.read, got.missed, got.texts.length], [25, 10, 0, 10]);
  assert.deepEqual(asked.sort(), urls.slice(0, 10).sort(), 'nothing past the cap is fetched');
  assert.equal(coverageNote(got), 'These captions are very long: only the first 10 of 25 parts were read, so the end is missing.');
  assert.equal(coverageNote({ total: 25, read: 10, missed: 2 }),
    'These captions are very long: only the first 10 of 25 parts were read, so the end is missing. 2 of 10 caption parts could not be read, so some lines are missing.');
  // Exactly at the cap: everything was read.
  const exact = await readSegments(urls.slice(0, 10), async (u) => u, { cap: 10 });
  assert.equal(coverageNote(exact), '');
  assert.deepEqual(await readSegments([], async () => 'x'), { texts: [], total: 0, read: 0, missed: 0 });
  assert.deepEqual(await readSegments(null, async () => 'x'), { texts: [], total: 0, read: 0, missed: 0 });
  assert.equal(coverageNote(), '');
});

const lecture = (n, width = 440) => Array.from({ length: n }, (_, i) => {
  const s = i * 30;
  const stamp = s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  return `[${stamp}] line ${i} ${'x'.repeat(width)}`;
});

test('condenseCaptions leaves a transcript that fits exactly as it is', () => {
  const text = lecture(20).join('\n');
  assert.deepEqual(condenseCaptions(text, text.length), { text, condensed: false, kept: 1 });
  assert.deepEqual(condenseCaptions(text, 1e9), { text, condensed: false, kept: 1 });
  assert.deepEqual(condenseCaptions('', 100), { text: '', condensed: false, kept: 1 });
  assert.deepEqual(condenseCaptions(null, 100), { text: '', condensed: false, kept: 1 });
});

test('condenseCaptions: one character too many is condensed, and the result always fits', () => {
  const text = lecture(100).join('\n');
  const out = condenseCaptions(text, text.length - 1);
  assert.equal(out.condensed, true);
  assert.ok(out.text.length <= text.length - 1);
  for (const max of [500, 2000, 10000, 30000]) {
    const c = condenseCaptions(text, max);
    assert.ok(c.text.length <= max, `${c.text.length} > ${max}`);
    assert.ok(c.kept > 0 && c.kept < 1);
  }
});

test('condenseCaptions samples a three-hour lecture evenly from its first minute to its last', () => {
  const lines = lecture(360); // three hours, a line every thirty seconds, about 165 000 characters
  const text = lines.join('\n');
  const max = 120000;
  const out = condenseCaptions(text, max);
  assert.equal(out.condensed, true);
  assert.ok(out.text.length <= max);
  assert.ok(Math.abs(out.kept - out.text.length / text.length) < 1e-9);
  const kept = out.text.split('\n').filter((l) => l !== GAP_MARK);
  // Whole lines only, each with its timestamp, in their order.
  assert.ok(kept.every((l) => lines.includes(l)), 'no line is cut or changed');
  const index = kept.map((l) => lines.indexOf(l));
  assert.deepEqual(index, [...index].sort((a, b) => a - b));
  assert.equal(index[0], 0, 'it starts at the beginning');
  assert.equal(index.at(-1), 359, 'and ends with the last line');
  // Cutting off the end (the old way) left nothing after 2:06. Now every half hour has lines in it.
  for (let h = 0; h < 6; h++) {
    const n = index.filter((i) => i >= h * 60 && i < (h + 1) * 60).length;
    assert.ok(n >= 30, `half hour ${h} kept ${n} lines`);
  }
  // No stretch of more than four minutes is missing (a line is thirty seconds).
  const gaps = index.slice(1).map((i, k) => i - index[k]);
  assert.ok(Math.max(...gaps) <= 8, `longest gap ${Math.max(...gaps)} lines`);
  assert.ok(out.text.includes(`\n${GAP_MARK}\n`), 'what was left out is marked');
  assert.ok(!out.text.includes(`${GAP_MARK}\n${GAP_MARK}`), 'one mark per gap');
});

test('condenseCaptions: text without line breaks is still cut to size, and marked', () => {
  const blob = 'word '.repeat(60000);
  const out = condenseCaptions(blob, 120000);
  assert.equal(out.condensed, true);
  assert.ok(out.text.length <= 120000 && out.text.length > 100000);
  assert.ok(out.text.startsWith('word word'));
  assert.ok(out.text.endsWith(GAP_MARK));
  // A few very long lines: the start of each stretch is kept, with its timestamp.
  const long = lecture(4, 5000).join('\n');
  const c = condenseCaptions(long, 4000);
  assert.ok(c.text.length <= 4000);
  assert.match(c.text, /^\[0:00\] line 0 x+\n\[…\]\n\[0:30\] line 1 x+/);
});

test('soleVideo: is this the page\'s only video (so a separate caption file is its own)?', () => {
  const video = { id: 'v', kind: 'direct' };
  const sub = { id: 's', kind: 'subtitle' };
  assert.equal(soleVideo([video, sub], 'v'), true);
  assert.equal(soleVideo([video], 'v'), true);
  assert.equal(soleVideo([video, sub], 's'), false, 'the caption file itself is not a video');
  assert.equal(soleVideo([video, { id: 'w', kind: 'hls' }, sub], 'v'), false, 'two videos: nobody can say whose captions they are');
  assert.equal(soleVideo([video, { id: 'p', kind: 'embed', playlist: true }, sub], 'v'), true, 'a playlist card is not a video');
  assert.equal(soleVideo([video], 'other'), false);
  assert.equal(soleVideo([], 'v'), false);
  assert.equal(soleVideo(undefined, 'v'), false);
});

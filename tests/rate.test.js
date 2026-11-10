import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRate, feedRate, readRate, resetRate, formatEta, formatRate, rateText } from '../extension/lib/rate.js';

const MB = 1024 * 1024;
const NONE = { bytesPerSec: null, etaSeconds: null };
const near = (got, want, tolerance = 0.02) => assert.ok(got != null && Math.abs(got - want) <= want * tolerance, `${got} is not about ${want}`);

/** Feed a byte download running at `perSec` from `fromMs` to `toMs`, one sample every `stepMs`. */
function run(meter, { fromMs, toMs, stepMs = 500, perSec, startBytes = 0, total = 0 }) {
  let bytes = startBytes;
  for (let at = fromMs; at <= toMs; at += stepMs) {
    bytes = startBytes + perSec * ((at - fromMs) / 1000);
    feedRate(meter, { at, done: bytes, total, bytes });
  }
  return bytes;
}

test('rate: a steady download reports its speed and the time left', () => {
  const m = newRate();
  const got = run(m, { fromMs: 1000, toMs: 31000, perSec: 2 * MB, total: 200 * MB });
  assert.equal(got, 60 * MB);
  const r = readRate(m, 31000);
  near(r.bytesPerSec, 2 * MB);
  near(r.etaSeconds, 70); // 140 MB left at 2 MB/s
  // A change of speed shows within the 10 s window, not averaged over the whole download.
  run(m, { fromMs: 31500, toMs: 51500, perSec: 0.5 * MB, startBytes: got + 0.25 * MB, total: 200 * MB });
  near(readRate(m, 51500).bytesPerSec, 0.5 * MB);
  // Old samples are dropped: the meter stays small however long the download runs.
  assert.ok(m.samples.length <= 25, `${m.samples.length} samples kept`);
});

test('rate: nothing is reported in the first two seconds, or from fewer than two samples', () => {
  const m = newRate();
  assert.deepEqual(readRate(m, 5000), NONE, 'no samples');
  feedRate(m, { at: 1000, done: 0, total: 100 * MB, bytes: 0 });
  assert.deepEqual(readRate(m, 1000), NONE, 'one sample');
  assert.deepEqual(readRate(m, 60000), NONE, 'one sample, however long ago');
  feedRate(m, { at: 1500, done: 5 * MB, total: 100 * MB, bytes: 5 * MB });
  feedRate(m, { at: 2900, done: 19 * MB, total: 100 * MB, bytes: 19 * MB });
  assert.deepEqual(readRate(m, 2900), NONE, '1.9 s in: too early');
  feedRate(m, { at: 3000, done: 20 * MB, total: 100 * MB, bytes: 20 * MB });
  const r = readRate(m, 3000);
  near(r.bytesPerSec, 10 * MB);
  near(r.etaSeconds, 8);
  assert.deepEqual(readRate(undefined, 1000), NONE);
  assert.deepEqual(readRate(null, 1000), NONE);
});

test('rate: waiting for the first byte is not counted as a slow start', () => {
  const m = newRate();
  // Polled at zero for 6 s (the server hasn't answered), then 1 MB/s.
  for (let at = 0; at <= 6000; at += 700) feedRate(m, { at, done: 0, total: 50 * MB, bytes: 0 });
  assert.equal(m.samples.length, 1, 'only the last look at zero is kept');
  assert.deepEqual(readRate(m, 6000), NONE);
  run(m, { fromMs: 6300, toMs: 7500, perSec: MB, total: 50 * MB });
  assert.equal(m.startedAt, 6300);
  assert.deepEqual(readRate(m, 7500), NONE, 'the two seconds count from the last look at zero, not from the first');
  run(m, { fromMs: 8000, toMs: 9300, perSec: MB, startBytes: 1.7 * MB, total: 50 * MB });
  const r = readRate(m, 9300);
  assert.ok(r.bytesPerSec > 0.75 * MB && r.bytesPerSec <= MB, `${r.bytesPerSec / MB} MB/s (2.7 MB in the 3 s since data began, not in 9.3 s)`);
  // A stream reports nothing until its first segment is in: its clock starts with the track.
  const seg = newRate();
  feedRate(seg, { at: 0, done: 0, total: 10, bytes: 0 });
  feedRate(seg, { at: 4000, done: 1, total: 10, bytes: 2 * MB });
  near(readRate(seg, 4000).bytesPerSec, 0.5 * MB);
  near(readRate(seg, 4000).etaSeconds, 36);
});

test('rate: a stall slows the speed down to zero and takes the time left away', () => {
  const m = newRate();
  const got = run(m, { fromMs: 0, toMs: 20000, perSec: MB, total: 100 * MB });
  near(readRate(m, 20000).bytesPerSec, MB);
  // Nothing arrives any more (a segment download reports nothing while it waits).
  near(readRate(m, 25000).bytesPerSec, 0.5 * MB, 0.06);
  assert.ok(readRate(m, 25000).etaSeconds > 80 * 1.5, 'the time left grows while it waits');
  assert.deepEqual(readRate(m, 30000), { bytesPerSec: 0, etaSeconds: null });
  assert.deepEqual(readRate(m, 500000), { bytesPerSec: 0, etaSeconds: null });
  // The same when the same numbers keep being reported (Chrome's own downloads are polled).
  for (let at = 20700; at <= 40000; at += 700) feedRate(m, { at, done: got, total: 100 * MB, bytes: got });
  assert.deepEqual(readRate(m, 40000), { bytesPerSec: 0, etaSeconds: null });
});

test('rate: a burst after a stall is spread over the wait, not reported as a huge speed', () => {
  // Silent stall: no samples for 30 s, then 40 MB arrive at once.
  const silent = newRate();
  const before = run(silent, { fromMs: 0, toMs: 10000, perSec: MB, total: 500 * MB });
  feedRate(silent, { at: 40400, done: before + 40 * MB, total: 500 * MB, bytes: before + 40 * MB });
  const a = readRate(silent, 40400);
  near(a.bytesPerSec, (40 * MB) / 30.4);
  assert.ok(a.etaSeconds > 300 && a.etaSeconds < 400, `eta ${a.etaSeconds}`);
  // Polled stall: the same numbers every 0.7 s for 30 s, then the burst 0.4 s after the last poll.
  const polled = newRate();
  const start = run(polled, { fromMs: 0, toMs: 10000, perSec: MB, total: 500 * MB });
  for (let at = 10700; at <= 40000; at += 700) feedRate(polled, { at, done: start, total: 500 * MB, bytes: start });
  feedRate(polled, { at: 40500, done: start + 40 * MB, total: 500 * MB, bytes: start + 40 * MB });
  const b = readRate(polled, 40500);
  assert.ok(b.bytesPerSec <= (40 * MB) / 10 && b.bytesPerSec >= (40 * MB) / 11, `${b.bytesPerSec / MB} MB/s`);
  assert.ok(b.bytesPerSec < 5 * MB, 'nowhere near 40 MB in 0.4 s');
  // Once the burst is old news the speed is what really arrives again.
  run(polled, { fromMs: 41000, toMs: 61000, perSec: MB, startBytes: start + 40.5 * MB, total: 500 * MB });
  near(readRate(polled, 61000).bytesPerSec, MB);
});

test('rate: a stream counted in segments gets its time left from segments, and its speed from bytes', () => {
  const m = newRate();
  // 200 segments, one finishing every half second, 300 KB each.
  for (let i = 0; i <= 60; i++) feedRate(m, { at: i * 500, done: i, total: 200, bytes: i * 300 * 1024 });
  const r = readRate(m, 30000);
  near(r.bytesPerSec, 600 * 1024);
  near(r.etaSeconds, 70); // 140 segments left at 2 a second
  // Percent only (yt-dlp): time left, no speed.
  const p = newRate();
  for (let i = 0; i <= 20; i++) feedRate(p, { at: i * 1000, done: i * 2, total: 100, bytes: null });
  const q = readRate(p, 20000);
  assert.equal(q.bytesPerSec, null);
  near(q.etaSeconds, 30);
  // No total (a live recording): a speed, but no time left.
  const live = newRate();
  for (let i = 0; i <= 20; i++) feedRate(live, { at: i * 1000, done: i, total: 0, bytes: i * MB });
  assert.deepEqual(readRate(live, 20000), { bytesPerSec: MB, etaSeconds: null });
});

test('rate: reset, a retry or the next file starts measuring afresh', () => {
  const m = newRate();
  run(m, { fromMs: 0, toMs: 20000, perSec: 4 * MB, total: 400 * MB });
  near(readRate(m, 20000).bytesPerSec, 4 * MB);
  resetRate(m);
  assert.equal(m.samples.length, 0);
  assert.deepEqual(readRate(m, 20000), NONE);
  // After a reset the warm-up applies again, and the old speed is not mixed in.
  run(m, { fromMs: 20000, toMs: 21500, perSec: MB, total: 50 * MB });
  assert.deepEqual(readRate(m, 21500), NONE);
  run(m, { fromMs: 22000, toMs: 26000, perSec: MB, startBytes: 2 * MB, total: 50 * MB });
  near(readRate(m, 26000).bytesPerSec, MB);
  // Progress that runs backwards (a retry from the start, a new track) resets on its own.
  const auto = newRate();
  run(auto, { fromMs: 0, toMs: 20000, perSec: 4 * MB, total: 400 * MB });
  feedRate(auto, { at: 20500, done: 0, total: 30 * MB, bytes: 0 });
  assert.equal(auto.samples.length, 1);
  assert.deepEqual(readRate(auto, 20500), NONE);
  assert.deepEqual(readRate(auto, 26000), NONE, 'one sample is not a speed');
  run(auto, { fromMs: 21000, toMs: 25000, perSec: MB, startBytes: 0.5 * MB, total: 30 * MB });
  const r = readRate(auto, 25000);
  near(r.bytesPerSec, MB, 0.03);
  assert.ok(r.bytesPerSec < 1.1 * MB, 'the 80 MB of the first attempt are forgotten');
  // A clock that jumps back does the same instead of dividing by a negative time.
  const clock = newRate();
  run(clock, { fromMs: 50000, toMs: 60000, perSec: MB });
  feedRate(clock, { at: 1000, done: 11 * MB, bytes: 11 * MB });
  assert.deepEqual(readRate(clock, 1000), NONE);
});

test('rate: never negative, NaN or absurd, whatever it is fed', () => {
  const m = newRate();
  const junk = [
    null, undefined, {}, { at: NaN, done: 1 }, { at: 1000, done: NaN }, { at: 1000, done: -5 }, { at: Infinity, done: 5 },
    { at: 1000, done: Infinity }, { at: 'soon', done: 'lots' },
  ];
  for (const s of junk) feedRate(m, s);
  assert.equal(m.samples.length, 0, 'senseless samples are ignored');
  feedRate(m, { at: 0, done: 0, total: -10, bytes: -1 });
  feedRate(m, { at: 5000, done: 50, total: NaN, bytes: NaN });
  feedRate(m, { at: 10000, done: 100, total: 'x', bytes: '12' });
  assert.deepEqual(readRate(m, 10000), NONE, 'no usable total or byte count: nothing to say');
  assert.deepEqual(readRate(m, NaN), NONE);
  // Done beyond the total, an impossible speed, a time left of years: all unknown rather than shown.
  const over = newRate();
  feedRate(over, { at: 0, done: 0, total: 100, bytes: 0 });
  feedRate(over, { at: 4000, done: 150, total: 100, bytes: 4e15 });
  assert.deepEqual(readRate(over, 4000), NONE);
  const slow = newRate();
  feedRate(slow, { at: 0, done: 0, total: 1e12, bytes: 0 });
  feedRate(slow, { at: 5000, done: 1, total: 1e12, bytes: 1 });
  assert.deepEqual(readRate(slow, 5000), { bytesPerSec: 0.2, etaSeconds: null });
  // A reading taken "before" the last sample is treated as taken at it.
  const early = newRate();
  run(early, { fromMs: 0, toMs: 10000, perSec: MB, total: 100 * MB });
  near(readRate(early, 3).bytesPerSec, MB);
  // Property: random walks of plausible and implausible input never give a bad number.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const wild = newRate();
  let at = 0;
  let done = 0;
  for (let i = 0; i < 3000; i++) {
    at += rnd() < 0.05 ? -rnd() * 5000 : rnd() * 3000;
    done += rnd() < 0.05 ? -rnd() * 1e7 : rnd() * 1e7;
    feedRate(wild, { at, done: Math.max(0, done), total: rnd() < 0.5 ? 1e9 : 0, bytes: rnd() < 0.8 ? Math.max(0, done) : null });
    const r = readRate(wild, at + rnd() * 20000);
    for (const v of [r.bytesPerSec, r.etaSeconds]) assert.ok(v === null || (Number.isFinite(v) && v >= 0), `bad value ${v} at step ${i}`);
    assert.ok(r.bytesPerSec === null || r.bytesPerSec <= 1e10);
    assert.ok(r.etaSeconds === null || r.etaSeconds <= 99 * 3600);
    assert.ok(wild.samples.length < 100);
  }
});

test('rate: samples that arrive in a burst replace each other instead of piling up', () => {
  const m = newRate();
  for (let i = 0; i <= 2000; i++) feedRate(m, { at: i * 10, done: i * 1000, total: 1e7, bytes: i * 1000 });
  assert.ok(m.samples.length <= 45, `${m.samples.length} samples for 20 s`);
  near(readRate(m, 20000).bytesPerSec, 100000);
});

test('formatEta: seconds, minutes and hours, with their boundaries', () => {
  assert.equal(formatEta(40), 'about 40 s left');
  assert.equal(formatEta(120), 'about 2 min left');
  assert.equal(formatEta(3900), 'about 1 h 5 min left');
  // Under a minute: steps of five seconds, never "60 s".
  assert.equal(formatEta(0), 'a few seconds left');
  assert.equal(formatEta(4.9), 'a few seconds left');
  assert.equal(formatEta(5), 'about 5 s left');
  assert.equal(formatEta(7.4), 'about 5 s left');
  assert.equal(formatEta(7.5), 'about 10 s left');
  assert.equal(formatEta(43), 'about 45 s left');
  assert.equal(formatEta(57), 'about 55 s left');
  assert.equal(formatEta(59), 'about 1 min left');
  assert.equal(formatEta(60), 'about 1 min left');
  assert.equal(formatEta(61), 'about 1 min left');
  assert.equal(formatEta(89), 'about 1 min left');
  assert.equal(formatEta(90), 'about 2 min left');
  // Under an hour: whole minutes, never "60 min".
  assert.equal(formatEta(59 * 60), 'about 59 min left');
  assert.equal(formatEta(59 * 60 + 29), 'about 59 min left');
  assert.equal(formatEta(59 * 60 + 30), 'about 1 h left');
  assert.equal(formatEta(60 * 60), 'about 1 h left');
  assert.equal(formatEta(60 * 60 + 29), 'about 1 h left');
  assert.equal(formatEta(61 * 60), 'about 1 h 1 min left');
  assert.equal(formatEta(2 * 3600 - 20), 'about 2 h left');
  assert.equal(formatEta(26 * 3600 + 59 * 60), 'about 26 h 59 min left');
  for (let s = 0; s < 4 * 3600; s += 7) assert.doesNotMatch(formatEta(s), /\b60 (s|min)\b|\b0 (s|min|h)\b/, `${s} s`);
});

test('formatEta: no text when there is no believable estimate', () => {
  for (const bad of [Infinity, -Infinity, NaN, -1, -0.001, null, undefined, '90', {}, 99 * 3600 + 1, 1e12]) assert.equal(formatEta(bad), '', String(bad));
  assert.equal(formatEta(99 * 3600), 'about 99 h left');
});

test('formatRate and rateText: the words shown next to the percentage', () => {
  assert.equal(formatRate(3.1 * MB), '3.1 MB/s');
  assert.equal(formatRate(640 * 1024), '640 KB/s');
  assert.equal(formatRate(512), '512 B/s');
  for (const bad of [0, -5, NaN, Infinity, null, undefined, '5']) assert.equal(formatRate(bad), '', String(bad));
  assert.equal(rateText({ bytesPerSec: 3.1 * MB, etaSeconds: 120 }), '3.1 MB/s · about 2 min left');
  assert.equal(rateText({ bytesPerSec: null, etaSeconds: 40 }), 'about 40 s left');
  assert.equal(rateText({ bytesPerSec: 2 * MB, etaSeconds: null }), '2.0 MB/s');
  assert.equal(rateText({ bytesPerSec: 0, etaSeconds: null }), '', 'stalled: nothing to say');
  assert.equal(rateText({ bytesPerSec: null, etaSeconds: null }), '');
  assert.equal(rateText(null), '');
  assert.equal(rateText(undefined), '');
});

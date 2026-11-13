// The helper's "convert" request, driven through the real native-messaging protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMessage, createDecoder } from '../native-host/protocol.js';
import { findTool, convertPartName, listMediaFiles } from '../native-host/host.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = findTool('ffmpeg');
const skip = !ffmpeg && 'ffmpeg not installed';

/** Send one request to a fresh helper; resolves with every message it sent back (progress, then result/error). */
function ask(msg, { closeAfterMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'native-host', 'host.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const got = [];
    const t = setTimeout(() => { child.kill(); reject(new Error('helper did not answer')); }, 60000);
    child.stdout.on('data', createDecoder((m) => {
      got.push(m);
      if (m.type === 'result' || m.type === 'error') child.stdin.end();
    }));
    child.on('close', () => { clearTimeout(t); resolve(got); });
    child.stdin.write(encodeMessage({ id: 7, ...msg }));
    if (closeAfterMs) setTimeout(() => child.stdin.end(), closeAfterMs);
  });
}

function clip(dir, name, seconds) {
  const f = path.join(dir, name);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=10:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', f], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return f;
}

test('helper convert: makes an MP3 next to the video, reports progress, and never overwrites', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-convh-'));
  const src = clip(dir, 'Lecture 9.mp4', 6);
  const first = await ask({ type: 'convert', input: src, mode: 'audio' });
  const res = first.at(-1);
  assert.equal(res.type, 'result', JSON.stringify(res));
  assert.equal(res.id, 7);
  assert.equal(res.output, path.join(dir, 'Lecture 9.mp3'));
  assert.ok(fs.statSync(res.output).size > 1000);
  const progress = first.filter((m) => m.type === 'progress').map((m) => m.percent);
  assert.ok(progress.length > 0, 'at least one progress message');
  assert.ok(progress.every((p) => Number.isInteger(p) && p >= 0 && p <= 99), `percentages ${progress}`);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b), 'progress never goes backwards');

  // Asked again, the first MP3 is kept and the new one gets its own name.
  const before = fs.readFileSync(res.output);
  const second = (await ask({ type: 'convert', input: src, mode: 'audio' })).at(-1);
  assert.equal(second.output, path.join(dir, 'Lecture 9 (1).mp3'));
  assert.ok(before.equals(fs.readFileSync(res.output)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('helper convert: refuses anything that is not an existing media file or a known conversion', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-convh-'));
  const src = clip(dir, 'ok.mp4', 1);
  const notes = path.join(dir, 'notes.txt');
  fs.writeFileSync(notes, 'not a video');
  const cases = [
    [{ input: notes, mode: 'audio' }, /not a video or audio file/i],
    [{ input: path.join(dir, 'missing.mp4'), mode: 'audio' }, /not found/i],
    [{ input: 'relative.mp4', mode: 'audio' }, /not found/i],
    [{ input: src, mode: 'gif' }, /Unknown conversion/],
    [{ input: src }, /Unknown conversion/],
    [{ mode: 'audio' }, /not found/i],
  ];
  for (const [msg, why] of cases) {
    const res = (await ask({ type: 'convert', ...msg })).at(-1);
    assert.equal(res.type, 'error', JSON.stringify(msg));
    assert.match(res.error, why, JSON.stringify(msg));
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'ok.mp4'], 'no output file is left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('helper convert: closing the connection stops ffmpeg and the helper', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-convh-'));
  const src = clip(dir, 'long.mp4', 120);
  const started = Date.now();
  // A 720p re-encode of two minutes takes a while; hang up after half a second.
  const got = await ask({ type: 'convert', input: src, mode: 'small' }, { closeAfterMs: 500 });
  assert.ok(Date.now() - started < 8000, `helper exited promptly (${Date.now() - started} ms)`);
  assert.equal(got.some((m) => m.type === 'result'), false, 'no result after a cancel');
  // ffmpeg was stopped too, and the half-made copy went with it: only the original is in the folder.
  // (It used to stay behind as "long (720p).mp4", looking like a finished video.)
  assert.deepEqual(fs.readdirSync(dir), ['long.mp4']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('helper convert: the copy is written under a ".part" name and only gets its real name when it is whole', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-convh-'));
  const src = clip(dir, 'talk.mp4', 240);
  assert.equal(convertPartName(src, 'small'), path.join(dir, 'talk (720p).mp4.part'));
  assert.equal(convertPartName(src, 'audio'), path.join(dir, 'talk.mp3.part'));
  assert.throws(() => convertPartName(src, 'gif'), /Unknown conversion/);
  // What a run that crashed (the computer went to sleep, the helper was killed) left behind.
  fs.writeFileSync(convertPartName(src, 'small'), 'half a video from last week');
  const seen = [];
  const watch = setInterval(() => { try { seen.push(fs.readdirSync(dir).sort().join('|')); } catch { /* being renamed */ } }, 20);
  const res = (await ask({ type: 'convert', input: src, mode: 'small' })).at(-1);
  clearInterval(watch);
  assert.equal(res.type, 'result', JSON.stringify(res));
  assert.equal(res.output, path.join(dir, 'talk (720p).mp4'));
  // While it ran, the folder never held a "talk (720p).mp4" that was not finished.
  assert.ok(seen.includes('talk (720p).mp4.part|talk.mp4'), `seen: ${[...new Set(seen)].join(' / ')}`);
  const early = seen.slice(0, seen.indexOf('talk (720p).mp4|talk.mp4') < 0 ? seen.length : seen.indexOf('talk (720p).mp4|talk.mp4'));
  assert.ok(early.every((s) => s === 'talk (720p).mp4.part|talk.mp4' || s === 'talk.mp4'), `seen: ${[...new Set(seen)].join(' / ')}`);
  // Afterwards: the original and the finished copy, a real video, and no ".part" (the stale one was replaced, not kept).
  assert.deepEqual(fs.readdirSync(dir).sort(), ['talk (720p).mp4', 'talk.mp4']);
  assert.ok(fs.statSync(res.output).size > 5000);
  assert.notEqual(fs.readFileSync(res.output).subarray(0, 27).toString(), 'half a video from last week');
  // The folder check lists media files by their ending: a ".part" is never one of them.
  fs.writeFileSync(path.join(dir, 'other (720p).mp4.part'), 'x'.repeat(100));
  assert.deepEqual(listMediaFiles([dir]).map((f) => f.name).sort(), ['talk (720p).mp4', 'talk.mp4']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('helper convert: a conversion that fails leaves no ".part" and no copy', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-convh-'));
  // Named like a video, but not one: ffmpeg cannot read it.
  const bad = path.join(dir, 'broken.mp4');
  fs.writeFileSync(bad, 'this is not a video file at all');
  const res = (await ask({ type: 'convert', input: bad, mode: 'audio' })).at(-1);
  assert.equal(res.type, 'error', JSON.stringify(res));
  assert.match(res.error, /^ffmpeg failed: /);
  assert.deepEqual(fs.readdirSync(dir), ['broken.mp4']);
  fs.rmSync(dir, { recursive: true, force: true });
});

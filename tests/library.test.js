import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInLibrary, sameItem, nameKey, serviceId, savedPathsOf } from '../extension/lib/match.js';
import { listMediaFiles, findTool } from '../native-host/host.js';
import { encodeMessage, createDecoder } from '../native-host/protocol.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = 'C:\\Videos';

test('a renamed download is still recognised by its recorded size', () => {
  const m = { id: 'a', kind: 'hls', key: 'k1', url: 'https://x/master.m3u8', info: { duration: 300.5 } };
  const history = [{ mediaKeys: ['k1'], outputs: [{ path: `${dir}\\Lecture 2.mp4`, size: 123456789 }] }];
  const files = [{ path: `${dir}\\My renamed lecture.mp4`, size: 123456789 }, { path: `${dir}\\other.mp4`, size: 5 }];
  assert.deepEqual(findInLibrary(m, history, files, [dir]), { path: `${dir}\\My renamed lecture.mp4`, how: 'renamed' });
  // Same name and size: plain "history" match.
  assert.equal(findInLibrary(m, history, [{ path: `${dir}\\Lecture 2.mp4`, size: 123456789 }], [dir]).how, 'history');
});

test('a deleted download is reported as missing only if its folder was scanned', () => {
  const m = { id: 'a', kind: 'hls', key: 'k1', info: {} };
  const history = [{ mediaKeys: ['k1'], outputs: [{ path: `${dir}\\Lecture 2.mp4`, size: 999 }] }];
  assert.deepEqual(findInLibrary(m, history, [], [dir]), { missing: true, path: `${dir}\\Lecture 2.mp4` });
  assert.equal(findInLibrary(m, history, [], ['D:\\Elsewhere']), null);
  // A sibling folder that merely starts with the same letters does not count as scanned.
  assert.equal(findInLibrary(m, history, [], ['C:\\Vid']), null);
  // Saved after the scan started: not "missing", the scan just hasn't seen it yet.
  const fresh = [{ ...history[0], at: 2000 }];
  assert.equal(findInLibrary(m, fresh, [], [dir], 1000), null);
  assert.equal(findInLibrary(m, fresh, [], [dir], 3000).missing, true);
});

test('a never-downloaded file is recognised by exact size; small or different sizes are not', () => {
  const m = { id: 'b', kind: 'direct', key: 'k2', size: 50_000_000 };
  assert.equal(findInLibrary(m, [], [{ path: 'C:\\V\\x.mp4', size: 50_000_000 }], []).how, 'size');
  assert.equal(findInLibrary(m, [], [{ path: 'C:\\V\\x.mp4', size: 50_000_001 }], []), null);
  assert.equal(findInLibrary({ ...m, size: 1000 }, [], [{ path: 'C:\\V\\x.mp4', size: 1000 }], []), null);
});

test('streams match by length only when exactly one file has that length', () => {
  const m = { id: 'c', kind: 'hls', key: 'k3', info: { duration: 612.48 } };
  let n = 0;
  const f = (name, d, size = 1000 + n++) => ({ path: `C:\\V\\${name}.mp4`, size, duration: d });
  assert.equal(findInLibrary(m, [], [f('a', 612.3), f('b', 100)], []).path, 'C:\\V\\a.mp4');
  // A merged MP4 is often a few frames off the playlist: about a second is still the same video.
  assert.equal(findInLibrary(m, [], [f('a', 611.5)], []).path, 'C:\\V\\a.mp4');
  assert.equal(findInLibrary(m, [], [f('a', 611.3)], []), null); // 1.18 s off: different video
  assert.equal(findInLibrary(m, [], [f('a', 612.3), f('b', 612.6)], []), null); // ambiguous
  // The same file saved twice (identical size) is one video, not a tie.
  assert.equal(findInLibrary(m, [], [f('a', 612.3, 5000), f('a (1)', 612.3, 5000)], []).path, 'C:\\V\\a.mp4');
  // Whole-second durations (Vimeo config) get a wider window.
  assert.equal(findInLibrary({ ...m, info: { duration: 62 } }, [], [f('a', 60.5)], []).path, 'C:\\V\\a.mp4');
  assert.equal(findInLibrary({ ...m, info: { duration: 62 } }, [], [f('a', 60.3)], []), null);
  // Short clips and live streams are never matched by length.
  assert.equal(findInLibrary({ ...m, info: { duration: 12 } }, [], [f('a', 12)], []), null);
  assert.equal(findInLibrary({ ...m, info: { duration: 612.48, live: true } }, [], [f('a', 612.48)], []), null);
});

test('nameKey reduces file and video names to their words', () => {
  assert.equal(nameKey('C:\\V\\003 - Day 2 – Keynote [123456789] - 1080p (1).mp4'), 'day 2 keynote');
  assert.equal(nameKey('Day 2: Keynote'), 'day 2 keynote');
  assert.equal(nameKey('Café & Crème.mkv'), 'cafe and creme');
});

test('a file saved by another tool is found by the video id in its name', () => {
  const m = { id: 'v', kind: 'hls', key: 'kv', url: 'https://vod.vimeocdn.com/x/playlist.m3u8', embedId: '123456789', info: {} };
  const files = [{ path: 'C:\\V\\Some other name [123456789].mp4', size: 10 }, { path: 'C:\\V\\x [12345678].mp4', size: 11 }];
  assert.deepEqual(findInLibrary(m, [], files, []), { path: 'C:\\V\\Some other name [123456789].mp4', how: 'id' });
  // The id can also come from the item's own URL (a YouTube/Vimeo embed card).
  assert.equal(findInLibrary({ id: 'e', kind: 'embed', url: 'https://player.vimeo.com/video/12345678?h=ab' }, [], files, []).how, 'id');
  // Playlists are folders of many videos: never matched to one file.
  assert.equal(findInLibrary({ ...m, playlist: true }, [], files, []), null);
});

test('a file is found by the video name, unless the name is generic, shared or contradicted by its length', () => {
  const m = { id: 'n', kind: 'hls', key: 'kn', title: 'Day 2 - Keynote', nameSource: 'player', info: { duration: 1800 } };
  const files = [{ path: 'C:\\V\\Day 2 - Keynote - 720p.mp4', size: 10 }, { path: 'C:\\V\\Day 3 - Keynote - 720p.mp4', size: 20 }];
  assert.deepEqual(findInLibrary(m, [], files, []), { path: 'C:\\V\\Day 2 - Keynote - 720p.mp4', how: 'name' });
  // "{course} - {title}" templates.
  const long = { ...m, title: 'Managing Heart Failure in Clinic' };
  assert.equal(findInLibrary(long, [], [{ path: 'C:\\V\\Study Hall - Managing Heart Failure in Clinic - 1080p.mp4', size: 1 }], []).how, 'name');
  // Only the tab title (the same for every lecture on the site) proves nothing.
  assert.equal(findInLibrary({ ...m, nameSource: 'title' }, [], files, []), null);
  // Your own rename counts.
  assert.equal(findInLibrary({ ...m, nameSource: 'title', customName: 'Day 3 - Keynote' }, [], files, []).path, 'C:\\V\\Day 3 - Keynote - 720p.mp4');
  // Several videos on the page share this name.
  assert.equal(findInLibrary(m, [], files, [], Infinity, { nameIsUnique: false }), null);
  // The file's measured length says it is a different video.
  assert.equal(findInLibrary(m, [], [{ ...files[0], duration: 600 }], []), null);
  assert.equal(findInLibrary(m, [], [{ ...files[0], duration: 1801.5 }], []).how, 'length');
  // Two different files with the name: can't tell which.
  assert.equal(findInLibrary(m, [], [files[0], { path: 'C:\\W\\Day 2 - Keynote.mkv', size: 99 }], []), null);
  // Too short to mean anything.
  assert.equal(findInLibrary({ ...m, title: 'Intro' }, [], [{ path: 'C:\\V\\Intro.mp4', size: 1 }], []), null);
});

test('a showcase or event link has no single video id (marking one must not mark them all)', () => {
  assert.equal(serviceId({ url: 'https://vimeo.com/showcase/12471493' }), '');
  assert.equal(serviceId({ url: 'https://vimeo.com/event/4455667' }), '');
  assert.equal(serviceId({ url: 'https://player.vimeo.com/video/76979871?h=8272103f6e' }), '76979871');
  assert.equal(serviceId({ url: 'https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0' }), 'dQw4w9WgXcQ');
  assert.equal(serviceId({ url: 'https://fast.wistia.net/embed/iframe/abc123defg' }), 'abc123defg');
});

test('length ties are settled by the name', () => {
  const m = { id: 't', kind: 'hls', key: 'kt', title: 'Session One Opening', nameSource: 'list', info: { duration: 900.2 } };
  const files = [{ path: 'C:\\V\\Session One Opening.mp4', size: 1, duration: 900 }, { path: 'C:\\V\\Other talk.mp4', size: 2, duration: 900.4 }];
  assert.deepEqual(findInLibrary(m, [], files, []), { path: 'C:\\V\\Session One Opening.mp4', how: 'length' });
});

test('sameItem matches across changed signed links', () => {
  const m = { id: 'x', key: 'new', aliases: ['old'], url: 'u2', kind: 'direct', size: 1 };
  assert.equal(sameItem(m, { mediaKeys: ['old'] }), true);
  assert.equal(sameItem(m, { mediaKeys: ['zzz'], mediaUrl: 'u1' }), false);
});

test('listMediaFiles walks subfolders, skips hidden ones and non-media files', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-lib-'));
  fs.mkdirSync(path.join(work, 'Course', 'Week 1'), { recursive: true });
  fs.mkdirSync(path.join(work, '.hidden'));
  fs.writeFileSync(path.join(work, 'Course', 'Week 1', 'a.mp4'), 'x'.repeat(10));
  fs.writeFileSync(path.join(work, 'Course', 'notes.txt'), 'x');
  fs.writeFileSync(path.join(work, '.hidden', 'b.mp4'), 'x');
  fs.writeFileSync(path.join(work, 'empty.mp4'), '');
  const files = listMediaFiles([work, path.join(work, 'Course')]);
  assert.deepEqual(files.map((f) => f.name), ['a.mp4']);
  assert.equal(files[0].size, 10);
  fs.rmSync(work, { recursive: true, force: true });
});

const ffmpeg = findTool('ffmpeg');
test('helper scan measures real video lengths and keeps them after a rename', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-scan-'));
  const clip = path.join(work, 'Lecture 7.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=5:duration=3.4',
    '-c:v', 'libx264', clip], { stdio: 'ignore', windowsHide: true });
  const ask = (msg) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'native-host', 'host.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const t = setTimeout(() => reject(new Error('no reply')), 30000);
    child.stdout.on('data', createDecoder((m) => { clearTimeout(t); child.stdin.end(); resolve(m); }));
    child.stdin.write(encodeMessage({ id: 1, ...msg }));
  });
  const first = await ask({ type: 'scanFolder', dirs: [work], durations: true });
  assert.equal(first.type, 'result', first.error);
  assert.equal(first.files.length, 1);
  assert.ok(Math.abs(first.files[0].duration - 3.4) < 0.3, `duration ${first.files[0].duration}`);
  const renamed = path.join(work, 'Renamed by me.mp4');
  fs.renameSync(clip, renamed);
  const second = await ask({ type: 'scanFolder', dirs: [work], durations: true });
  assert.equal(second.files[0].path, renamed);
  assert.equal(second.files[0].duration, first.files[0].duration); // from the cache: same size + modified time
  fs.rmSync(work, { recursive: true, force: true });
});

test('savedPathsOf: the files a page\'s videos are shown as downloaded from, to check they are still there', () => {
  const history = [
    { mediaId: 'a', outputs: [{ path: 'C:\V\A.mp4', size: 10 }] },
    { mediaUrl: 'https://x/b.m3u8', outputs: [{ path: 'C:\V\B.mp4' }, { path: 'C:\V\B.vtt' }] },
    { mediaId: 'zzz', outputs: [{ path: 'C:\V\Other.mp4' }] },
  ];
  const media = [
    { id: 'a', url: 'https://x/a.mp4', kind: 'direct' }, // saved, no scan match yet: its recorded file
    { id: 'b', url: 'https://x/b.m3u8', kind: 'hls' }, // every file recorded for it
    { id: 'c', url: 'https://x/c.mp4', kind: 'direct', library: { path: 'D:\Lib\C renamed.mp4', how: 'renamed' } }, // the scan's file, not the record's
    { id: 'd', url: 'https://x/d.mp4', kind: 'direct', library: { missing: true, path: 'C:\V\D.mp4' } }, // already known gone
    { id: 'e', url: 'https://x/e.mp4', kind: 'direct', mark: 'done', library: { path: '', how: 'manual' } }, // your own mark
    { id: 'f', url: 'https://x/f.mp4', kind: 'direct' }, // never saved
    { id: 'g', url: 'https://x/g.vtt', kind: 'subtitle', library: { path: 'C:\V\g.vtt' } },
  ];
  assert.deepEqual(savedPathsOf(media, history), ['C:\V\A.mp4', 'C:\V\B.mp4', 'C:\V\B.vtt', 'D:\Lib\C renamed.mp4']);
  // At most `max`, and nothing from nothing.
  assert.deepEqual(savedPathsOf(media, history, 2), ['C:\V\A.mp4', 'C:\V\B.mp4']);
  assert.deepEqual(savedPathsOf([], history), []);
  assert.deepEqual(savedPathsOf(media, []), ['D:\Lib\C renamed.mp4']);
});

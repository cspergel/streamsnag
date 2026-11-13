import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, downloadName, mergedExt, plannedFile, saveRoot, mapLimit } from '../extension/lib/plan.js';
import { DEFAULT_SETTINGS } from '../extension/lib/settings.js';

const settings = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over });
const page = { pageUrl: 'https://learn.example.com/course/cardio/9', pageTitle: 'Cardio | Example', kind: 'hls', date: '2026-11-10' };

test('cleanName: a typed name is tidied the way Rename tidies it', () => {
  assert.equal(cleanName('  Valves   made\tsimple \n'), 'Valves made simple');
  assert.equal(cleanName(''), '');
  assert.equal(cleanName(null), '');
  assert.equal(cleanName(undefined), '');
  assert.equal(cleanName('x'.repeat(200)).length, 150);
  assert.equal(cleanName(42), '42');
});

test('downloadName: the default template is "<title> - <quality>" in the StreamSnag folder', () => {
  assert.deepEqual(downloadName({ settings: settings(), title: '009: Atrial fibrillation', quality: '720p', ...page }),
    { base: '009 Atrial fibrillation - 720p', folder: 'StreamSnag' });
  // No quality (a plain file): the separator goes with it.
  assert.deepEqual(downloadName({ settings: settings(), title: 'Gallery clip two', ...page, kind: 'direct' }),
    { base: 'Gallery clip two', folder: 'StreamSnag' });
  // A name from a page is made safe for a file, and can never leave the folder.
  assert.equal(downloadName({ settings: settings(), title: '../../evil<>:"|?*name', quality: '', ...page }).base, 'evil name');
});

test('downloadName: folder tokens ({site}, {course}, {date}, {kind}) and name tokens ({number}, {name}, {host}…)', () => {
  const s = settings({ subfolder: 'Videos/{site}/{course}/{date}/{kind}', filenameTemplate: '{number} - {name} [{host}] {quality}' });
  assert.deepEqual(downloadName({ settings: s, title: 'Lecture 9: Atrial fibrillation', quality: '1080p', course: 'Cardio/2026', ...page }), {
    base: '9 - Atrial fibrillation [learn.example.com] 1080p',
    folder: 'Videos/learn.example.com/Cardio 2026/2026-11-10/hls',
  });
  // Without a page address the video's own address says which site it is.
  assert.equal(downloadName({ settings: settings({ subfolder: '{site}' }), title: 'A', url: 'https://www.cdn.example.net/v/1.mp4', kind: 'direct' }).folder, 'cdn.example.net');
});

test('downloadName: a rule for the site (or its parent domain) beats the general settings', () => {
  const s = settings({ siteRules: { 'example.com': { subfolder: 'Courses/{course}', filenameTemplate: '{title}' } } });
  assert.deepEqual(downloadName({ settings: s, title: '009: AF', quality: '720p', course: 'Cardio', ...page }), { base: '009 AF', folder: 'Courses/Cardio' });
  // Another site keeps the general ones.
  assert.deepEqual(downloadName({ settings: s, title: '009: AF', quality: '720p', course: 'Cardio', ...page, pageUrl: 'https://other.org/x' }),
    { base: '009 AF - 720p', folder: 'StreamSnag' });
});

test('downloadName: a numbered name from the review sheet fills {number} and {name} like any other', () => {
  const s = settings({ filenameTemplate: '{number}. {name}' });
  assert.equal(downloadName({ settings: s, title: '01 - Welcome back', quality: '720p', ...page }).base, '01. Welcome back');
  assert.equal(downloadName({ settings: settings(), title: '01 - Welcome back', quality: '720p', ...page }).base, '01 - Welcome back - 720p');
});

test('mergedExt: what ffmpeg makes of a download\'s files, and when it leaves them alone', () => {
  const v = (ext) => ({ role: 'video', ext });
  const a = (ext) => ({ role: 'audio', ext });
  assert.equal(mergedExt([v('ts')]), 'mp4', 'a transport stream is turned into an MP4');
  assert.equal(mergedExt([v('mp4')]), '', 'one MP4 is already what it should be');
  assert.equal(mergedExt([v('mp4'), a('m4a')]), 'mp4', 'video + audio are joined');
  assert.equal(mergedExt([v('webm'), a('webm')]), 'mkv');
  assert.equal(mergedExt([a('aac'), a('aac')]), 'm4a', 'sound only');
  assert.equal(mergedExt([a('ts')]), 'm4a');
  assert.equal(mergedExt([v('mp4')], 1), 'mp4', 'subtitles to put inside are a reason to merge');
  assert.equal(mergedExt([a('m4a')], 0), '');
  assert.equal(mergedExt([], 2), '', 'nothing to merge into');
  assert.equal(mergedExt([]), '');
});

test('plannedFile: the file a download ends up as, with and without ffmpeg', () => {
  const s = settings();
  const tracks = (list) => list.map(([role, ext, name]) => ({ role, ext, filename: `StreamSnag/${name}` }));
  // A plain file: exactly its own name.
  assert.deepEqual(plannedFile(tracks([['file', 'mp4', 'Clip.mp4']]), 'Clip', s, true), { filename: 'Clip.mp4', extra: 0 });
  // A .ts stream: merged to MP4 with the helper, left as .ts without it (or with merging turned off).
  const ts = tracks([['video', 'ts', 'L9 - 720p.ts']]);
  assert.deepEqual(plannedFile(ts, 'L9 - 720p', s, true), { filename: 'L9 - 720p.mp4', extra: 0 });
  assert.deepEqual(plannedFile(ts, 'L9 - 720p', s, false), { filename: 'L9 - 720p.ts', extra: 0 });
  assert.deepEqual(plannedFile(ts, 'L9 - 720p', settings({ useFfmpeg: false }), true), { filename: 'L9 - 720p.ts', extra: 0 });
  // Video + audio + a subtitle file: one MP4 with the subtitles inside; without ffmpeg three files.
  const av = tracks([['video', 'mp4', 'L9 - 720p.video.mp4'], ['audio', 'm4a', 'L9 - 720p.audio.m4a'], ['subtitle', 'vtt', 'L9 - 720p.en.vtt']]);
  assert.deepEqual(plannedFile(av, 'L9 - 720p', s, true), { filename: 'L9 - 720p.mp4', extra: 0 });
  assert.deepEqual(plannedFile(av, 'L9 - 720p', s, false), { filename: 'L9 - 720p.video.mp4', extra: 2 });
  // Settings that keep the subtitle file next to the video.
  assert.deepEqual(plannedFile(av, 'L9 - 720p', settings({ keepSubtitleFiles: true }), true), { filename: 'L9 - 720p.mp4', extra: 1 });
  assert.deepEqual(plannedFile(av, 'L9 - 720p', settings({ embedSubtitles: false }), true), { filename: 'L9 - 720p.mp4', extra: 1 });
  // One MP4 stream with a subtitle file: merged only to put the subtitles inside.
  const one = tracks([['video', 'mp4', 'L9 - 720p.mp4'], ['subtitle', 'vtt', 'L9 - 720p.en.vtt']]);
  assert.deepEqual(plannedFile(one, 'L9 - 720p', s, true), { filename: 'L9 - 720p.mp4', extra: 0 });
  assert.deepEqual(plannedFile(one, 'L9 - 720p', settings({ embedSubtitles: false }), true), { filename: 'L9 - 720p.mp4', extra: 1 });
  // WebM video and audio become an MKV.
  const webm = tracks([['video', 'webm', 'X.video.webm'], ['audio', 'webm', 'X.audio.webm']]);
  assert.deepEqual(plannedFile(webm, 'X', s, true), { filename: 'X.mkv', extra: 0 });
});

test('saveRoot: your own folder when the helper can move files there, else Downloads (and it says why)', () => {
  assert.deepEqual(saveRoot(settings(), false), { label: 'Downloads', path: '', note: '' });
  assert.deepEqual(saveRoot(settings(), true), { label: 'Downloads', path: '', note: '' });
  assert.deepEqual(saveRoot(settings({ saveFolder: 'D:\\Media\\Videos' }), true), { label: 'Videos', path: 'D:\\Media\\Videos', note: '' });
  assert.deepEqual(saveRoot(settings({ saveFolder: '/home/ada/Videos/' }), true), { label: 'Videos', path: '/home/ada/Videos/', note: '' });
  assert.deepEqual(saveRoot(settings({ saveFolder: 'D:\\' }), true), { label: 'D:', path: 'D:\\', note: '' });
  const noHelper = saveRoot(settings({ saveFolder: 'D:\\Media\\Videos' }), false);
  assert.equal(noHelper.label, 'Downloads');
  assert.equal(noHelper.path, '');
  assert.match(noHelper.note, /local helper/);
  assert.deepEqual(saveRoot(null, true), { label: 'Downloads', path: '', note: '' });
});

test('mapLimit: never more than the limit at once, results in the order asked, every item once', async () => {
  let running = 0;
  let most = 0;
  const seen = [];
  const out = await mapLimit([5, 1, 4, 2, 3, 0, 6, 2, 1], 4, async (n, i) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, n * 5));
    seen.push(i);
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60, 20, 10]);
  assert.equal(most, 4);
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  assert.deepEqual(await mapLimit([1, 2], 10, async (n) => n + 1), [2, 3], 'fewer items than the limit');
  // A limit of nothing still runs them, one at a time.
  let at = 0;
  let peak = 0;
  await mapLimit([1, 2, 3], 0, async () => { at++; peak = Math.max(peak, at); await new Promise((r) => setTimeout(r, 2)); at--; });
  assert.equal(peak, 1);
});

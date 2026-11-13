import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFolder } from '../extension/lib/util.js';
import { safeFolder, joinInside } from '../native-host/host.js';
import { encodeMessage, createDecoder } from '../native-host/protocol.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('resolveFolder fills tokens, allows nesting, and cannot climb out', () => {
  assert.equal(resolveFolder('StreamSnag/{site}', { site: 'example.com' }), 'StreamSnag/example.com');
  assert.equal(resolveFolder('Vids\\{date}\\{kind}', { date: '2026-11-09', kind: 'hls' }), 'Vids/2026-11-09/hls');
  assert.equal(resolveFolder('../../Windows/System32'), 'Windows/System32');
  assert.equal(resolveFolder('a/./b//c'), 'a/b/c');
  assert.equal(resolveFolder('Bad:Name?/x*y'), 'Bad Name/x y');
  assert.equal(resolveFolder('{site}', { site: '' }), '');
  assert.equal(resolveFolder(''), '');
});

test('safeFolder accepts absolute paths and rejects relative/odd ones', () => {
  const abs = path.resolve(os.tmpdir(), 'ss videos');
  assert.equal(safeFolder(`  ${abs}  `), abs);
  assert.throws(() => safeFolder('Videos'), /full folder path/);
  assert.throws(() => safeFolder(''), /full folder path/);
  assert.throws(() => safeFolder(path.join(os.tmpdir(), 'a"b')), /not allow/);
});

test('joinInside keeps subfolders inside the base', () => {
  const base = path.resolve(os.tmpdir(), 'base');
  assert.equal(joinInside(base, 'Vids/site.com'), path.join(base, 'Vids', 'site.com'));
  assert.equal(joinInside(base, '../../etc'), path.join(base, 'etc'));
  assert.equal(joinInside(base, ''), base);
});

function helper(msg) {
  const child = spawn(process.execPath, [path.join(root, 'native-host', 'host.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no reply')), 15000);
    child.stdout.on('data', createDecoder((m) => { clearTimeout(t); child.stdin.end(); resolve(m); }));
    child.stdin.write(encodeMessage({ id: 1, ...msg }));
  });
}

test('helper moves finished files into the chosen folder + subfolder without overwriting', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-move-'));
  const dl = path.join(work, 'Downloads');
  fs.mkdirSync(dl);
  const a = path.join(dl, 'Clip.mp4');
  fs.writeFileSync(a, 'video-bytes');
  const dest = path.join(work, 'My Videos');
  fs.mkdirSync(path.join(dest, 'Vids', 'site.com'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'Vids', 'site.com', 'Clip.mp4'), 'older file');

  const r = await helper({ type: 'move', files: [a, path.join(dl, 'missing.mp4')], dest, subfolder: 'Vids/site.com' });
  assert.equal(r.type, 'result', r.error);
  assert.equal(r.dir, path.join(dest, 'Vids', 'site.com'));
  assert.equal(r.moved[0], path.join(dest, 'Vids', 'site.com', 'Clip (1).mp4'));
  assert.equal(r.moved[1], null);
  assert.equal(fs.readFileSync(r.moved[0], 'utf8'), 'video-bytes');
  assert.equal(fs.readFileSync(path.join(dest, 'Vids', 'site.com', 'Clip.mp4'), 'utf8'), 'older file');
  assert.ok(!fs.existsSync(a));

  const bad = await helper({ type: 'move', files: [], dest: 'relative\\dir' });
  assert.equal(bad.type, 'error');

  // Only the kinds of file StreamSnag saves are moved (security review, 2026-11-12): a video, a document from the
  // page, a subtitle file, a page or note it made. Anything else is left where it is.
  const kinds = ['Notes.pdf', 'Deck.pptx', 'Lecture.transcript.md', 'Lecture.guide.html', 'Lecture.vtt', 'Course.zip', 'tool.exe', 'lib.dll', 'run.bat', 'setup.ps1', 'noext'];
  for (const n of kinds) fs.writeFileSync(path.join(dl, n), 'x');
  const mixed = await helper({ type: 'move', files: kinds.map((n) => path.join(dl, n)), dest, subfolder: 'Kinds' });
  assert.equal(mixed.type, 'result', mixed.error);
  assert.deepEqual(mixed.moved.map((m) => (m ? path.basename(m) : null)), ['Notes.pdf', 'Deck.pptx', 'Lecture.transcript.md', 'Lecture.guide.html', 'Lecture.vtt', 'Course.zip', null, null, null, null, null]);
  for (const n of ['tool.exe', 'lib.dll', 'run.bat', 'setup.ps1', 'noext']) assert.ok(fs.existsSync(path.join(dl, n)), `${n} stays where it was`);

  // Merging takes video and audio files only, and so can only ever delete those after merging.
  const notMedia = path.join(dl, 'tool.exe');
  const mux = await helper({ type: 'mux', inputs: [notMedia], outputName: 'out.mp4', deleteInputs: true });
  assert.equal(mux.type, 'error');
  assert.match(mux.error, /not a video or audio file/);
  assert.ok(fs.existsSync(notMedia), 'nothing was deleted');

  const ok = await helper({ type: 'checkFolder', path: path.join(work, 'new', 'deeper') });
  assert.equal(ok.writable, true);
  assert.ok(fs.existsSync(path.join(work, 'new', 'deeper')));
  fs.rmSync(work, { recursive: true, force: true });
});

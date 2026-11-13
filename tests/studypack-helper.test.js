// What the local helper does for study packs: a pack made again takes the place of its own files (and of
// nothing else), and a study page can be opened at a minute and a slide. Driven through the real
// native-messaging protocol; no browser is started (STREAMSNAG_TEST_NO_OPEN: the helper's test mode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeMessage, createDecoder } from '../native-host/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** One request to a fresh helper; resolves with its answer. */
function ask(msg, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'native-host', 'host.js')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
    let answer = null;
    const t = setTimeout(() => { child.kill(); reject(new Error('helper did not answer')); }, 30000);
    child.stdout.on('data', createDecoder((m) => {
      if (m.type !== 'result' && m.type !== 'error') return;
      answer = m;
      child.stdin.end();
    }));
    child.on('close', () => { clearTimeout(t); resolve(answer); });
    child.stdin.write(encodeMessage({ id: 7, ...msg }));
  });
}

function folders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-pack-helper-'));
  const from = path.join(dir, 'Downloads');
  const dest = path.join(dir, 'Lectures');
  fs.mkdirSync(from);
  fs.mkdirSync(dest);
  return { dir, from, dest, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('move with replace: a study pack made again takes the place of its own files', async () => {
  const f = folders();
  try {
    const names = ['L06.guide.html', 'L06.guide.md', 'L06.study.html', 'L06.flashcards.txt', 'L06.transcript.md', 'L06.slides.md'];
    for (const n of names) {
      fs.writeFileSync(path.join(f.dest, n), `old ${n}`);
      fs.writeFileSync(path.join(f.from, n), `new ${n}`);
    }
    const res = await ask({ type: 'move', files: names.map((n) => path.join(f.from, n)), dest: f.dest, subfolder: '', replace: true });
    assert.equal(res.type, 'result', res.error);
    assert.deepEqual(res.moved, names.map((n) => path.join(f.dest, n)), 'each lands under its own name, not "name (1)"');
    assert.deepEqual(fs.readdirSync(f.dest).sort(), [...names].sort());
    for (const n of names) assert.equal(fs.readFileSync(path.join(f.dest, n), 'utf8'), `new ${n}`);
    assert.deepEqual(fs.readdirSync(f.from), []);
  } finally {
    f.done();
  }
});

test('move with replace never replaces anything that is not a study pack file', async () => {
  const f = folders();
  try {
    const names = ['L06.mp4', 'L06.slides.pdf', 'L06.transcript.txt', 'notes.html'];
    for (const n of names) {
      fs.writeFileSync(path.join(f.dest, n), `old ${n}`);
      fs.writeFileSync(path.join(f.from, n), `new ${n}`);
    }
    const res = await ask({ type: 'move', files: names.map((n) => path.join(f.from, n)), dest: f.dest, subfolder: '', replace: true });
    assert.equal(res.type, 'result', res.error);
    assert.deepEqual(res.moved.map((p) => path.basename(p)), ['L06 (1).mp4', 'L06.slides (1).pdf', 'L06.transcript (1).txt', 'notes (1).html']);
    for (const n of names) assert.equal(fs.readFileSync(path.join(f.dest, n), 'utf8'), `old ${n}`, 'what was there is untouched');
  } finally {
    f.done();
  }
});

test('move without replace keeps both files, as it always did (also for study pack files)', async () => {
  const f = folders();
  try {
    fs.writeFileSync(path.join(f.dest, 'L06.guide.html'), 'old');
    fs.writeFileSync(path.join(f.from, 'L06.guide.html'), 'new');
    for (const replace of [undefined, false, 'true', 1]) {
      if (!fs.existsSync(path.join(f.from, 'L06.guide.html'))) fs.writeFileSync(path.join(f.from, 'L06.guide.html'), 'new');
      const res = await ask({ type: 'move', files: [path.join(f.from, 'L06.guide.html')], dest: f.dest, subfolder: '', replace });
      assert.equal(res.type, 'result', res.error);
      assert.match(path.basename(res.moved[0]), /^L06\.guide \(\d\)\.html$/, String(replace));
      assert.equal(fs.readFileSync(path.join(f.dest, 'L06.guide.html'), 'utf8'), 'old');
    }
  } finally {
    f.done();
  }
});

test('openPage opens a saved study page at the card\'s minute and slide, and nothing else', async () => {
  const f = folders();
  const env = { STREAMSNAG_TEST_NO_OPEN: '1' };
  try {
    const page = path.join(f.dest, 'L06 a&b #1.study.html');
    fs.writeFileSync(page, '<!doctype html><title>study</title>');
    const res = await ask({ type: 'openPage', path: page, t: 754, slide: 5 }, env);
    assert.equal(res.type, 'result', res.error);
    assert.equal(res.opened, `${pathToFileURL(page).href}#t=754&slide=5`);
    const go = fs.readFileSync(res.via, 'utf8');
    assert.ok(path.dirname(res.via).startsWith(os.tmpdir()), 'the small page that sends the browser on is a temporary file');
    assert.ok(go.includes(`url=${res.opened.replace(/&/g, '&#38;')}"`));
    fs.rmSync(res.via, { force: true });
    // Not a study page, not there, not a full path: refused, and nothing is written or opened.
    const other = path.join(f.dest, 'notes.html');
    fs.writeFileSync(other, 'x');
    for (const bad of [other, path.join(f.dest, 'missing.study.html'), 'L06.study.html', path.join(f.dest, 'x.study.html.exe')]) {
      const no = await ask({ type: 'openPage', path: bad, t: 1, slide: 1 }, env);
      assert.equal(no.type, 'error', bad);
      assert.match(no.error, /not a study page|File not found/, bad);
    }
  } finally {
    f.done();
  }
});

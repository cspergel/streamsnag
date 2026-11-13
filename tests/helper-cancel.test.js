// Cancel really stops what the helper started (and what that started), and yt-dlp is told the quality.
// Driven through the real native-messaging protocol where it matters; yt-dlp itself is never run
// (STREAMSNAG_FAKE_YTDLP: the helper's test mode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMessage, createDecoder } from '../native-host/protocol.js';
import { findTool, killTree, ytdlpFormatArgs, installHint } from '../native-host/host.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noYtdlp = !findTool('yt-dlp') && 'yt-dlp not installed (the helper checks for it before its test mode answers)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function until(fn, ms = 8000) {
  for (let i = 0; i < ms / 50; i++) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  return fn();
}

/** One request to a fresh helper. `onMessage(m, hangUp)` sees each answer; resolves with all of them once the helper has exited. */
function ask(msg, { env = {}, onMessage } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'native-host', 'host.js')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
    const got = [];
    const t = setTimeout(() => { child.kill(); reject(new Error('helper did not answer')); }, 60000);
    const hangUp = () => child.stdin.end();
    child.stdout.on('data', createDecoder((m) => {
      got.push(m);
      if (m.type === 'result' || m.type === 'error') hangUp();
      onMessage?.(m, hangUp);
    }));
    child.on('close', () => { clearTimeout(t); resolve(got); });
    child.stdin.write(encodeMessage({ id: 3, ...msg }));
  });
}

test('ytdlpFormatArgs: the "Quality to pick first" setting as yt-dlp format sorting', () => {
  assert.deepEqual(ytdlpFormatArgs('best'), []);
  assert.deepEqual(ytdlpFormatArgs('1080'), ['-S', 'res:1080']);
  assert.deepEqual(ytdlpFormatArgs('720'), ['-S', 'res:720']);
  assert.deepEqual(ytdlpFormatArgs(480), ['-S', 'res:480']);
  assert.deepEqual(ytdlpFormatArgs('smallest'), ['-S', '+size,+br']);
  // Anything else is yt-dlp's own choice; nothing from a message ever becomes an argument as written.
  for (const odd of [undefined, null, '', '2160', '720p', 'res:720', '--exec calc', '720 --exec calc', { a: 1 }]) assert.deepEqual(ytdlpFormatArgs(odd), [], String(odd));
});

test('installHint (helper): winget on Windows, Homebrew on a Mac, the package manager elsewhere', () => {
  assert.equal(installHint('ffmpeg', 'win32'), '"winget install Gyan.FFmpeg"');
  assert.equal(installHint('ffmpeg', 'darwin'), '"brew install ffmpeg"');
  assert.equal(installHint('ffmpeg', 'linux'), 'your package manager (for example "sudo apt install ffmpeg")');
  assert.equal(installHint('yt-dlp', 'win32', 'upgrade'), '"winget upgrade yt-dlp.yt-dlp"');
  assert.equal(installHint('yt-dlp', 'darwin', 'upgrade'), '"brew upgrade yt-dlp"');
  assert.equal(installHint('yt-dlp', 'linux', 'upgrade'), 'your package manager');
  assert.equal(installHint('something else', 'win32'), 'your package manager');
  for (const p of ['darwin', 'linux', 'freebsd']) assert.doesNotMatch(installHint('ffmpeg', p), /winget/, p);
});

test('killTree stops a program and the program it started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-kill-'));
  const pidFile = path.join(dir, 'inner.pid');
  const script = path.join(dir, 'inner.cjs');
  fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)");
  // The outer program is a shell that runs the real one, like the .cmd shim of an installed tool: stopping
  // only the shell leaves the real program running. Started the way the helper starts its programs.
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${process.execPath}" "${script}" "${pidFile}""`], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    : spawn('sh', ['-c', '"$0" "$1" "$2" & wait', process.execPath, script, pidFile], { stdio: 'ignore', detached: true });
  const innerPid = Number(await until(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '')));
  assert.ok(innerPid > 0 && innerPid !== child.pid && alive(innerPid) && alive(child.pid), 'both are running');
  try {
    killTree(child);
    assert.equal(await until(() => !alive(child.pid) && !alive(innerPid)), true, `outer ${alive(child.pid) ? 'still runs' : 'stopped'}, inner ${alive(innerPid) ? 'still runs' : 'stopped'}`);
    // Stopping what has already stopped (or was never started) is harmless.
    killTree(child);
    killTree(null);
    killTree({});
  } finally {
    try { process.kill(innerPid); } catch { /* stopped, as it should be */ } // a failing run must not leave it behind
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('helper yt-dlp: the quality from Settings reaches the command line', { skip: noYtdlp }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ytq-'));
  const env = { STREAMSNAG_FAKE_YTDLP: '1' };
  const capped = await ask({ type: 'ytdlp', url: 'https://example.com/watch/1', dir, name: 'Clip', quality: '720' }, { env });
  const res = capped.at(-1);
  assert.equal(res.type, 'result', JSON.stringify(res));
  const i = res.args.indexOf('-S');
  assert.ok(i > 0 && res.args[i + 1] === 'res:720', res.args.join(' '));
  assert.ok(capped.some((m) => m.type === 'progress' && m.line === 'fake yt-dlp 30% (-S res:720)'), 'the test mode says what it was asked for');
  const small = (await ask({ type: 'ytdlp', url: 'https://example.com/watch/1', dir, name: 'Clip2', quality: 'smallest' }, { env })).at(-1);
  assert.equal(small.args[small.args.indexOf('-S') + 1], '+size,+br');
  for (const [i, quality] of ['best', undefined, '720 --exec calc'].entries()) {
    const plain = await ask({ type: 'ytdlp', url: 'https://example.com/watch/1', dir, name: `Clip3 ${i}`, quality }, { env });
    assert.equal(plain.at(-1).type, 'result');
    assert.equal(plain.at(-1).args.includes('-S'), false, `no sorting for ${quality}`);
    assert.ok(!plain.at(-1).args.some((a) => /exec/.test(a)));
    assert.ok(plain.some((m) => m.line === 'fake yt-dlp 30%'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('helper yt-dlp: closing the connection stops the download, and what the download had started', { skip: noYtdlp }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ytc-'));
  const out = path.join(dir, 'Slow clip.mp4');
  let workerPid = 0;
  const started = Date.now();
  const got = await ask({ type: 'ytdlp', url: 'https://example.com/watch/slow-cancel-me', dir, name: 'Slow clip' }, {
    env: { STREAMSNAG_FAKE_YTDLP: '1', STREAMSNAG_FAKE_YTDLP_SLOW: 'slow-cancel-me' },
    onMessage: async (m, hangUp) => {
      if (m.type !== 'progress') return;
      // The "download" is running in a program of its own, started by the one the helper started.
      workerPid = Number(await until(() => (fs.existsSync(`${out}.pid`) ? fs.readFileSync(`${out}.pid`, 'utf8') : ''), 15000));
      hangUp(); // what Cancel does: Chrome closes the connection
    },
  });
  assert.ok(workerPid > 0, 'the slow download had started');
  assert.ok(Date.now() - started < 9000, `the helper exited promptly (${Date.now() - started} ms), well before the 10 s the download takes`);
  assert.equal(got.some((m) => m.type === 'result'), false, 'no result after a cancel');
  assert.equal(await until(() => !alive(workerPid), 5000), true, 'the program doing the download was stopped too');
  assert.equal(fs.existsSync(out), false, 'nothing was saved');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

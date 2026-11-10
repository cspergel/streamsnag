import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeFilename, buildFilename, formatBytes, extFromUrl, siteKey, ytdlpCommand } from '../extension/lib/util.js';
import { mergeVttSegments, srtToVtt, captionsToText } from '../extension/lib/vtt.js';
import { encodeMessage, createDecoder } from '../native-host/protocol.js';
import { safeOutputName, parseYtdlpProgress, cmdShimCommandLine, VERSION } from '../native-host/host.js';
import { extensionIdFromKey } from '../native-host/install.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('sanitizeFilename strips illegal characters and reserved names', () => {
  assert.equal(sanitizeFilename('a<b>:c"d/e\\f|g?h*'), 'a b c d e f g h');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('...'), 'video');
  assert.equal(sanitizeFilename('x'.repeat(300)).length, 150);
});

test('buildFilename fills tokens and collapses empty ones', () => {
  assert.equal(buildFilename('{title} - {quality}', { title: 'My: Clip', quality: '1080p' }, 'mp4'), 'My Clip - 1080p.mp4');
  assert.equal(buildFilename('{title} - {quality}', { title: 'My Clip', quality: '' }, '.TS'), 'My Clip.ts');
  assert.equal(buildFilename('', { title: '' }, 'mp4'), 'video.mp4');
});

test('formatBytes boundaries', () => {
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(-1), '');
});

test('extFromUrl and siteKey', () => {
  assert.equal(extFromUrl('https://a.com/v/file.MP4?x=y.ts'), 'mp4');
  assert.equal(extFromUrl('https://a.com/v/'), '');
  assert.equal(siteKey('https://WWW.Example.com/x'), 'example.com');
});

test('ytdlpCommand quotes URLs safely', () => {
  // "$" is percent-encoded (same URL to a server), so no shell can expand it.
  assert.equal(ytdlpCommand('https://a.com/v?a=1&b=$x', { referer: 'https://a.com/' }), 'yt-dlp --referer "https://a.com/" "https://a.com/v?a=1&b=%24x"');
});

test('mergeVttSegments keeps one header and drops duplicate cues across segments', () => {
  const s1 = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:00:03.000 --> 00:00:04.000\nWorld';
  const s2 = 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nWorld\n\n00:00:05.000 --> 00:00:06.000\nAgain';
  const out = mergeVttSegments([s1, s2]);
  assert.equal(out.match(/WEBVTT/g).length, 1);
  assert.equal(out.match(/World/g).length, 1);
  assert.match(out, /Again/);
  assert.doesNotMatch(out, /X-TIMESTAMP-MAP/);
});

test('srtToVtt converts comma timestamps', () => {
  const v = srtToVtt('1\n00:00:01,500 --> 00:00:02,000\nHi');
  assert.match(v, /^WEBVTT/);
  assert.match(v, /00:00:01\.500 --> 00:00:02\.000/);
});

test('captionsToText buckets by time and removes rolling duplicates', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nalpha\n\n00:00:02.000 --> 00:00:03.000\nalpha\n\n00:00:40.000 --> 00:00:41.000\n<c>beta</c>';
  assert.equal(captionsToText(vtt, 30), '[0:01] alpha\n[0:40] beta');
});

test('native messaging framing round-trips, including split chunks', () => {
  const got = [];
  const push = createDecoder((m) => got.push(m));
  const a = encodeMessage({ id: 1, text: 'héllo' });
  const b = encodeMessage({ id: 2 });
  const all = Buffer.concat([a, b]);
  push(all.subarray(0, 3));
  push(all.subarray(3, a.length + 2));
  push(all.subarray(a.length + 2));
  assert.deepEqual(got, [{ id: 1, text: 'héllo' }, { id: 2 }]);
  assert.equal(a.readUInt32LE(0), Buffer.byteLength(JSON.stringify({ id: 1, text: 'héllo' })));
});

test('host refuses unsafe mux output names', () => {
  assert.equal(safeOutputName('My Video.mp4'), 'My Video.mp4');
  assert.equal(safeOutputName('../../evil/x.mkv'), 'x.mkv');
  assert.throws(() => safeOutputName('payload.bat'), /must be/);
});

test('yt-dlp progress parsing', () => {
  assert.equal(parseYtdlpProgress('[download]  42.3% of 10.00MiB at 1.00MiB/s ETA 00:05'), 42.3);
  assert.equal(parseYtdlpProgress('[info] Downloading webpage'), null);
});

test('extension id is derived from the manifest key the way Chrome does', async () => {
  const fs = await import('node:fs');
  const { key, id } = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'key.json'), 'utf8'));
  assert.equal(extensionIdFromKey(key), id);
  assert.match(id, /^[a-p]{32}$/);
});

test('helper process answers a framed ping with its tool list', async () => {
  const child = spawn(process.execPath, [path.join(root, 'native-host', 'host.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no reply')), 15000);
    child.stdout.on('data', createDecoder((m) => { clearTimeout(t); resolve(m); }));
    child.stdin.write(encodeMessage({ id: 'abc', type: 'ping' }));
  });
  child.stdin.end();
  assert.equal(reply.id, 'abc');
  assert.equal(reply.type, 'result');
  assert.equal(reply.version, VERSION);
  assert.ok('claude' in reply.tools && 'ffmpeg' in reply.tools && 'ytdlp' in reply.tools);
});

test('helper returns an error frame for unknown requests', async () => {
  const child = spawn(process.execPath, [path.join(root, 'native-host', 'host.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = await new Promise((resolve) => {
    child.stdout.on('data', createDecoder(resolve));
    child.stdin.write(encodeMessage({ id: 7, type: 'rm -rf' }));
  });
  child.stdin.end();
  assert.equal(reply.type, 'error');
  assert.match(reply.error, /Unknown request type/);
});

test('cmd shim command line quotes every arg (empty included) and rejects shell metacharacters', () => {
  assert.equal(cmdShimCommandLine(String.raw`C:\npm\claude.cmd`, ['-p', '--tools', '', '--system-prompt-file', String.raw`C:\Temp dir\s.txt`]),
    String.raw`""C:\npm\claude.cmd" "-p" "--tools" "" "--system-prompt-file" "C:\Temp dir\s.txt""`);
  assert.throws(() => cmdShimCommandLine('claude.cmd', ['line\nbreak']), /Unsafe/);
  for (const bad of ['a&calc', 'x|y', '"q"', '%PATH%', 'a^b', 'a>b', 'a!b']) {
    assert.throws(() => cmdShimCommandLine('claude.cmd', [bad]), /Unsafe/, bad);
  }
});

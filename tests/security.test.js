// Things a hostile page must not be able to do through StreamSnag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ytdlpCommand, ffmpegCommand, registrableDomain, isPrivateHost, importableFolder, cleanHistoryEntry, isNetworkPath } from '../extension/lib/util.js';
import { mediaExtFromUrl } from '../extension/lib/detect.js';
import { PRIVATE_URL_PATTERNS } from '../extension/lib/headers.js';
import { fetchAllowed, normalizeRecipe } from '../extension/lib/recipes.js';
import { scanPage } from '../native-host/host.js';

test('copied yt-dlp/ffmpeg commands are inert in PowerShell, bash and cmd', () => {
  const evil = 'https://evil.example/$(calc)`whoami`"; rm -rf ~; echo "!x\'.mp4?a=1&b=2';
  for (const cmd of [ytdlpCommand(evil, { referer: 'https://site.example/p?q="$(id)"', output: 'a"$(calc)`b`.mp4' }), ffmpegCommand(evil, { referer: 'https://r.example/$x' })]) {
    // Every argument is one double-quoted string with nothing inside that a shell expands or that ends it.
    const args = cmd.match(/"[^"]*"/g);
    const outside = cmd.replace(/"[^"]*"/g, '');
    assert.match(outside, /^(yt-dlp|ffmpeg)[ a-z-]*$/, cmd);
    for (const a of args) assert.doesNotMatch(a.slice(1, -1), /[$`"\\!']/, a);
  }
  // The URL still means the same thing to a server: the characters are percent-encoded, not removed.
  assert.match(ytdlpCommand('https://x.example/a$b c'), /"https:\/\/x\.example\/a%24b%20c"$/);
  assert.equal(ytdlpCommand('https://x.example/v.mp4?a=1&b=2'), 'yt-dlp "https://x.example/v.mp4?a=1&b=2"');
});

test('a site is its registrable domain: shared hosting neighbours and ccTLD second levels are separate', () => {
  assert.equal(registrableDomain('www.learn.example.com'), 'example.com');
  assert.equal(registrableDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
  assert.equal(registrableDomain('d123.cloudfront.net'), 'd123.cloudfront.net');
  assert.equal(registrableDomain('bucket.s3.amazonaws.com'), 'bucket.s3.amazonaws.com');
  assert.equal(registrableDomain('192.168.1.1'), '192.168.1.1');
  // Recipe fetches: same owner yes, a neighbour on shared hosting or another ".co.uk" site no.
  assert.equal(fetchAllowed('https://api.example.com/x', 'https://www.example.com/course'), true);
  assert.equal(fetchAllowed('https://bob.github.io/x', 'https://alice.github.io/'), false);
  assert.equal(fetchAllowed('https://bank.co.uk/x', 'https://shop.co.uk/'), false);
  assert.equal(fetchAllowed('https://shop.co.uk/api', 'https://www.shop.co.uk/'), true);
});

test('private-network hosts are recognised (no automatic fetches into them from public pages)', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.3.4', '172.31.255.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '[::1]', 'fd12:3456::1', 'router.local', 'nas.lan']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', 'local.example.com', '']) assert.equal(isPrivateHost(h), false, h);
});

test('recipes with catastrophic-backtracking patterns are refused', () => {
  const recipe = (pattern) => ({ site: 'example.com', rules: [{ type: 'regex', source: 'html', pattern }] });
  // Nested quantifiers are refused. (Overlapping alternatives like (a|aa)+ are not detected: a known limit.)
  for (const bad of ['(a+)+$', '(\\w*)*x', '(?:x+)+', '([a-z]+\\d*)+']) assert.throws(() => normalizeRecipe(recipe(bad)), /pattern/, bad);
  for (const ok of ['"(https?:[^"]+\\.m3u8[^"]*)"', 'file:\\s*"([^"]+)"', '(abc)+']) assert.doesNotThrow(() => normalizeRecipe(recipe(ok)), ok);
});

test('big folder scans are split into pages that each fit in one helper message', () => {
  const all = Array.from({ length: 12000 }, (_, i) => ({ path: `C:\\Users\\someone\\Videos\\Course ${i % 40}\\Lecture ${i} - ${'x'.repeat(80)}.mp4`, size: 1e8 + i, mtimeMs: 1.7e12 + i, duration: 1800 + i }));
  const seen = [];
  for (let offset = 0; offset < all.length;) {
    const page = scanPage(all, offset);
    assert.ok(page.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 900 * 1024);
    seen.push(...page);
    offset += page.length;
  }
  assert.equal(seen.length, all.length);
  assert.equal(seen.at(-1).path, all.at(-1).path);
});

test('a file saved from its address alone only ever gets an audio/video extension', () => {
  assert.equal(mediaExtFromUrl('https://cdn.example.com/a/clip.webm?x=1'), 'webm');
  assert.equal(mediaExtFromUrl('https://cdn.example.com/a/song.MP3'), 'mp3');
  for (const bad of ['clip.scr', 'movie.exe', 'open.lnk', 'run.bat', 'page.html', 'x.js', 'setup.msi', 'noext', 'a.constructor', 'a.toString']) {
    assert.equal(mediaExtFromUrl(`https://evil.example.com/${bad}`), 'mp4', bad);
  }
  assert.equal(mediaExtFromUrl('https://evil.example.com/track.scr', 'mp3'), 'mp3');
});

test('the browser-level local-network block covers the same hosts as isPrivateHost', () => {
  // Chrome matches rule patterns without regard to case; a request is blocked when any one of them matches.
  const res = PRIVATE_URL_PATTERNS.map((x) => new RegExp(x, 'i'));
  const re = { test: (u) => res.some((r) => r.test(u)) };
  const local = ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.9.9.9', '10.0.0.5', '0.0.0.0', '172.16.3.4', '172.31.255.1', '192.168.1.1',
    '169.254.1.1', '100.64.0.1', '100.127.255.254', '[::1]', '[fd12:3456::1]', '[fe80::1]', 'router.local', 'nas.lan', 'wiki.corp', 'printer.home',
    // IPv4 written as IPv6 (security review, 2026-11-12): mapped, the unspecified address, and NAT64 to a local address.
    '[::]', '[::ffff:7f00:1]', '[::ffff:c0a8:101]', '[::ffff:127.0.0.1]', '[::ffff:192.168.1.1]', '[::7f00:1]', '[64:ff9b::c0a8:101]'];
  for (const h of local) {
    assert.equal(isPrivateHost(h), true, `isPrivateHost ${h}`);
    for (const u of [`http://${h}/`, `https://${h}:8443/x.mp4?a=1`, `http://${h}`, `http://${h}?reboot=1`, `http://user:pw@${h}/x`]) assert.equal(re.test(u), true, u);
  }
  const open = ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.63.0.1', '100.128.0.1', '11.0.0.1', 'local.example.com',
    'localhost.example.com', '10.example.com', 'mylocal', '[2001:db8::1]'];
  for (const h of open) {
    assert.equal(isPrivateHost(h), false, `isPrivateHost ${h}`);
    for (const u of [`https://${h}/`, `http://${h}:8080/v.mp4`, `https://${h}/?next=http://192.168.1.1/`, `https://${h}/127.0.0.1/x`]) assert.equal(re.test(u), false, u);
  }
});

test('a backup file cannot point StreamSnag at a network share', () => {
  assert.equal(importableFolder('D:\\Videos\\Courses'), true);
  assert.equal(importableFolder('/home/me/Videos'), true);
  for (const bad of ['\\\\attacker.example\\share', '//attacker.example/share', '  \\\\10.0.0.9\\c$', '\\\\?\\C:\\x', '', 'C:\\a"b', 'C:\\a`whoami`', 42, null, 'x'.repeat(400)]) {
    assert.equal(importableFolder(bad), false, String(bad).slice(0, 40));
  }
  assert.equal(isNetworkPath('C:\\Videos'), false);
  assert.equal(isNetworkPath('/home/me'), false);
});

test('history from a backup keeps only web links and local file paths', () => {
  const good = {
    at: 1700000000000, title: '009 - Lipids', pageUrl: 'https://learn.example.com/c/9', mediaUrl: 'https://cdn.example.com/9.m3u8',
    files: ['D:\\Videos\\009 - Lipids.mp4'], outputs: [{ path: 'D:\\Videos\\009 - Lipids.mp4', size: 123, duration: 600.5, role: 'video' }],
    mediaKeys: ['cdn.example.com/9.m3u8'], mediaSize: 123, fingerprint: 'abc', bytes: 123, note: 'merged',
  };
  assert.deepEqual(cleanHistoryEntry(good), good);

  const bad = cleanHistoryEntry({
    at: 5, title: 'x', pageUrl: 'chrome://settings/', mediaUrl: 'file:///C:/Users/me/secret.txt',
    files: ['\\\\attacker.example\\share\\a.mp4', 'D:\\ok.mp4', 7],
    outputs: [{ path: '\\\\attacker.example\\share\\a.mp4' }, { path: '//attacker.example/s/b.mp4' }, { path: 'D:\\ok.mp4', size: 1, dir: '\\\\attacker.example\\x', deep: { a: 1 } }, null, 'str'],
    mediaKeys: ['k', 9, {}], evil: '<script>', __proto__: { polluted: true },
  });
  assert.equal(bad.pageUrl, undefined);
  assert.equal(bad.mediaUrl, undefined);
  assert.deepEqual(bad.files, ['D:\\ok.mp4']);
  assert.deepEqual(bad.outputs, [{ path: 'D:\\ok.mp4', size: 1 }]);
  assert.deepEqual(bad.mediaKeys, ['k']);
  assert.equal('evil' in bad, false);
  assert.equal('javascript:alert(1)'.startsWith('http'), false);
  assert.equal(cleanHistoryEntry({ at: 5, title: 'x', pageUrl: 'javascript:alert(1)' }).pageUrl, undefined);

  for (const junk of [null, 'str', 7, [], { title: 'no date' }, { at: 'yesterday', title: 'x' }]) assert.equal(cleanHistoryEntry(junk), null);
});


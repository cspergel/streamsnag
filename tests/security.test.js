// Things a hostile page must not be able to do through StreamSnag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ytdlpCommand, ffmpegCommand, registrableDomain, isPrivateHost } from '../extension/lib/util.js';
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

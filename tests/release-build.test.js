// The two release packages (scripts/build-release.mjs), built here into a folder of their own: the store
// edition has no word of what it must never contain, every one of its modules parses and imports what is
// there, and its modules behave as a page with no saveable video expects; the website edition is
// extension/ byte for byte. And the build's checks do catch what they are there to catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { buildStore, buildSite, buildHelper, checkScripts, searchForbidden, siteDrift, listFiles, makeZip, readZip, mergePatch, LEFT_OUT, HELPER_FILES, ID_SLOT } from '../scripts/build-release.mjs';
import { encodeMessage, createDecoder } from '../native-host/protocol.js';
import { FORBIDDEN } from '../scripts/edition-strip.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'extension');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'streamsnag-release-'));
// (So Node reads the built files as the ES modules they are, as it does under the repository's package.json.)
fs.writeFileSync(path.join(work, 'package.json'), '{"type":"module"}');
const STORE = path.join(work, 'store');
const SITE = path.join(work, 'site');
const built = buildStore(STORE);
buildSite(SITE);
test.after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 }));

const storeModule = (f) => import(pathToFileURL(path.join(STORE, f)).href);

test('the store edition: blocks were marked and taken out, and no file says any of the forbidden words', () => {
  const total = Object.values(built.blocks).reduce((a, b) => a + b, 0);
  assert.ok(total >= 50, `${total} blocks`);
  for (const f of ['background.js', 'popup.js', 'popup.html', 'options.js', 'options.html', 'lib/detect.js', 'content.js']) assert.ok(built.blocks[f] > 0, f);
  assert.deepEqual(searchForbidden(STORE), []);
  // The same search, written out once more without the build's own helper: every byte of every file.
  for (const f of listFiles(STORE)) {
    assert.ok(!FORBIDDEN.test(f), f);
    assert.ok(!FORBIDDEN.test(fs.readFileSync(path.join(STORE, f)).toString('latin1')), f);
  }
  // While the development extension does say them (the search is not blind).
  assert.ok(FORBIDDEN.test(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8')));
});

test('the store edition: every module parses, every import is there, no removed name is still used', () => {
  assert.deepEqual(checkScripts(STORE, built.removed), []);
  // Same files, same folders: only the contents of the marked files differ.
  assert.deepEqual(listFiles(STORE), listFiles(SRC).filter((f) => !LEFT_OUT.test(f)));
  for (const f of listFiles(SRC)) {
    if (built.blocks[f] || f === 'manifest.json') continue;
    assert.ok(fs.readFileSync(path.join(SRC, f)).equals(fs.readFileSync(path.join(STORE, f))), `${f} is copied as it is`);
  }
});

test('the store edition\'s manifest: the overlay\'s changes and nothing else', () => {
  const dev = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const store = JSON.parse(fs.readFileSync(path.join(STORE, 'manifest.json'), 'utf8'));
  assert.ok(dev.key && !('key' in store), 'the store gives the extension its own key');
  const { key, ...rest } = dev;
  assert.deepEqual(store, rest);
  assert.equal(store.version, dev.version);
  // No host pattern or permission names a site of its own: the same <all_urls> the development one asks for.
  assert.deepEqual(store.host_permissions, ['<all_urls>']);
  assert.ok(!FORBIDDEN.test(JSON.stringify(store)));
  // The merge patch itself.
  assert.deepEqual(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { a: null, b: { d: null, e: 4 }, '//': 'note' }), { b: { c: 2, e: 4 } });
});

test('the store edition\'s modules: the pieces of a player are still never listed, and nothing offers another downloader', async () => {
  const detect = await storeModule('lib/detect.js');
  assert.equal(typeof detect.playerPiece, 'function');
  for (const name of Object.keys(detect)) assert.ok(!FORBIDDEN.test(name), name);
  const piece = 'https://rr3---sn-abc.example.com/videoplayback?expire=1999999999&id=o-AAA&itag=137&mime=video%2Fmp4&clen=9000000&rn=1';
  assert.ok(detect.playerPiece(piece), 'a piece of such a player is set aside');
  assert.ok(detect.playerPiece(piece.replace('itag=137', 'itag=251').replace('video%2Fmp4', 'audio%2Fwebm')), 'its sound too');
  assert.ok(!detect.playerPiece('https://r1---sn-x.c.drive.google.com/videoplayback?source=webdrive&itag=18&id=1'), 'Google Drive\'s player sends whole videos');
  assert.ok(!detect.playerPiece('https://cdn.example.com/lecture.mp4?itag=1'));
  // Its HLS playlists and their pieces too, recognised by their paths alone (the build names no site):
  assert.ok(detect.playerPiece('https://manifest.example.com/api/manifest/hls_variant/expire/1/id/a29f/file/index.m3u8'), 'its playlist of qualities');
  assert.ok(detect.playerPiece('https://manifest.example.com/api/manifest/hls_playlist/expire/1/id/a29f/itag/312/file/index.m3u8'), 'one quality');
  assert.ok(detect.playerPiece('https://rr3---sn-x.example.com/videoplayback/id/a29f/itag/312/expire/1/file/seg.ts'), 'a piece named in its path');
  assert.ok(!detect.playerPiece('https://cdn.example.com/hls/lecture/index.m3u8'), 'an ordinary stream is not');
  const wording = await storeModule('lib/wording.js');
  assert.equal(wording.OTHER_WAY, undefined);
  assert.match(wording.LIVE_DASH, /live broadcast of a kind StreamSnag can't record\.$/);
  assert.ok(!/another way|helper/i.test(wording.LIVE_DASH));
  // What the popup says on a page with nothing to save (the same words as in the development extension).
  const dev = await import(pathToFileURL(path.join(SRC, 'lib/wording.js')).href);
  assert.deepEqual(wording.emptyState({}), dev.emptyState({}));
  assert.equal(wording.emptyState({}).title, 'No video on this page.');
  const jobs = await storeModule('lib/jobs.js');
  assert.equal(jobs.installHint('ffmpeg', 'win'), 'Install it with "winget install Gyan.FFmpeg"');
  assert.equal(jobs.installHint(['yt', 'dlp'].join('-'), 'win'), '');
  const util = await storeModule('lib/util.js');
  assert.ok(!Object.keys(util).some((k) => FORBIDDEN.test(k)));
  // The AI is never told of another site or another downloader.
  const ai = await storeModule('lib/ai.js');
  const find = ai.buildFindPrompt({ pageUrl: 'https://x.example/', pageTitle: 't', sniffed: [], network: [], dom: {}, snippets: [] });
  const why = ai.buildDiagnosePrompt({ job: {}, error: 'e', pageUrl: 'p', mediaUrl: 'm', status: 1, headers: {} });
  for (const p of [find, why]) assert.ok(!FORBIDDEN.test(p.system) && !FORBIDDEN.test(JSON.stringify(p.schema)));
  assert.match(find.system, /\(press play and ask again, open the lecture's own page\)\. No technical/);
  assert.match(why.system, /the stream is DRM\nprotected and cannot be saved\)\. Do not suggest/);
  // And the development extension's prompts are the ones it always had.
  const devAi = await import(pathToFileURL(path.join(SRC, 'lib/ai.js')).href);
  const devWhy = devAi.buildDiagnosePrompt({ job: {}, error: 'e', pageUrl: 'p', mediaUrl: 'm', status: 1, headers: {} });
  assert.match(devWhy.system, /protected and cannot be saved, try the yt-dlp helper\)\. Do not/);
  assert.ok('try_ytdlp' in devWhy.schema.properties && !('try_ytdlp' in why.schema.properties));
});

test('the store edition\'s popup and worker: no other downloader, and a page that plays only in pieces reads as one with no video', () => {
  const html = fs.readFileSync(path.join(STORE, 'popup.html'), 'utf8');
  assert.ok(!html.includes('btn-tools-adv') && !html.includes('tools-adv'), 'the Advanced item only held the other downloader');
  assert.ok(html.includes('id="btn-sidebar"') && html.includes('id="btn-ai"'));
  const bg = fs.readFileSync(path.join(STORE, 'background.js'), 'utf8');
  assert.ok(!/startOther|helperRequest\(\{ type: 'yt/.test(bg));
  assert.match(bg, /if \(playerPiece\(r\.url\)\) \{\n[^]*?t\.inPieces = true;\n\s*persistTab\(tabId\);\n\s*return;/);
  // …however it was found (the page's links, a site rule, your AI): every way in goes through addMedia.
  const add = bg.slice(bg.indexOf('async function addMedia(tabId, item) {'), bg.indexOf('async function addMedia(tabId, item) {') + 600);
  assert.match(add, /^async function addMedia\(tabId, item\) \{\n {2}if \(tabId < 0 \|\| !isHttpUrl\(item\.url\)\) return null;\n(?: {2}\/\/[^\n]*\n)* {2}if \(playerPiece\(item\.url\)\) return null;/);
  assert.match(bg, /if \(!EMBED_RESOLVERS\[provider\]\) return;/);
  assert.match(bg, /if \(waiting\) t\.media = t\.media\.filter\(\(x\) => x !== waiting\);/);
  assert.match(bg, /if \(m\.kind === 'embed'\) throw new Error\(PLAYER_PENDING\);/);
  const popup = fs.readFileSync(path.join(STORE, 'popup.js'), 'utf8');
  assert.match(popup, /players: inPieces \? 0 : page\.players, playing: inPieces \? 0 : page\.playing/);
  assert.ok(!/Try another way|other downloader/.test(popup + bg));
  // The development worker never sets the flag: the website edition says what it always said.
  assert.ok(!/^\s*t\.inPieces = true;/m.test(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8')));
});

test('the website edition is extension/ byte for byte, folder and zip', () => {
  assert.deepEqual(siteDrift(SRC, listFiles(SITE).map((name) => ({ name, data: fs.readFileSync(path.join(SITE, name)) }))), []);
  const entries = listFiles(SITE).map((name) => ({ name, data: fs.readFileSync(path.join(SITE, name)) }));
  const zip = makeZip(entries);
  assert.deepEqual(siteDrift(SRC, readZip(zip)), []);
  // The same files always make the same zip (a fixed date on every entry).
  assert.ok(makeZip(entries).equals(zip));
  // And a drift is caught: a changed byte, a missing file, an extra one.
  const changed = readZip(zip).map((e) => (e.name === 'popup.js' ? { ...e, data: Buffer.concat([e.data, Buffer.from(' ')]) } : e));
  assert.deepEqual(siteDrift(SRC, changed), ['popup.js: differs']);
  assert.deepEqual(siteDrift(SRC, [...readZip(zip).filter((e) => e.name !== 'theme.js'), { name: 'extra.txt', data: Buffer.from('x') }]), ['theme.js: missing', 'extra.txt: not in extension/']);
});

test('the build\'s checks catch a removed name still in use, an import of a name no longer exported, and a forbidden word left behind', () => {
  const src = path.join(work, 'mini-src');
  const out = path.join(work, 'mini-store');
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, key: 'k', content_scripts: [{ js: ['cs.js'] }] }));
  fs.writeFileSync(path.join(src, 'lib', 'a.js'), 'export const kept = 1;\n// @site-edition\nexport function gone() { return 2; }\n// @end-site-edition\n');
  fs.writeFileSync(path.join(src, 'b.js'), "import { kept, gone } from './lib/a.js';\nexport const both = kept + gone();\n");
  fs.writeFileSync(path.join(src, 'cs.js'), 'var old = 010;\n'); // a classic script (sloppy mode is allowed there)
  fs.writeFileSync(path.join(src, 'note.txt'), ['you', 'tube'].join(''));
  const overlay = path.join(work, 'overlay.json');
  fs.writeFileSync(overlay, '{"key":null}');
  const b = buildStore(out, src, overlay);
  assert.deepEqual(b.blocks, { 'lib/a.js': 1 });
  const problems = checkScripts(out, b.removed);
  assert.ok(problems.includes('b.js: imports "gone" from ./lib/a.js, which does not export it'), problems.join('\n'));
  assert.ok(problems.includes('b.js: still uses "gone", which only a removed block declared (in lib/a.js)'), problems.join('\n'));
  assert.ok(!problems.some((p) => p.startsWith('cs.js')), 'a classic script is parsed as one');
  assert.equal(searchForbidden(out).length, 1);
  assert.match(searchForbidden(out)[0], /^note\.txt:1: /);
  assert.ok(!('key' in JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))));
  // A bad marker stops the build.
  fs.writeFileSync(path.join(src, 'lib', 'a.js'), '// @site-edition\nexport const x = 1;\n');
  assert.throws(() => buildStore(out, src, overlay), /lib\/a\.js:1: @site-edition is never closed/);
});

// ---------------------------------------------------------------- the store edition's helper

/** Requests to a fresh helper started from `hostJs`; resolves with { id: answer } once each has its answer. */
function askHelper(hostJs, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostJs], { stdio: ['pipe', 'pipe', 'ignore'] });
    const got = {};
    const t = setTimeout(() => { child.kill(); reject(new Error(`the helper did not answer: ${JSON.stringify(got)}`)); }, 60000);
    child.stdout.on('data', createDecoder((m) => {
      if (m.type !== 'result' && m.type !== 'error') return;
      got[m.id] = m;
      if (Object.keys(got).length === requests.length) child.stdin.end();
    }));
    child.on('close', () => { clearTimeout(t); resolve(got); });
    requests.forEach((r, i) => child.stdin.write(encodeMessage({ id: i + 1, ...r })));
  });
}

const HELPER_ID = 'abcdefghijklmnopabcdefghijklmnop';
const helperConfig = (id) => {
  const file = path.join(work, `helper-${id.length}.json`);
  fs.writeFileSync(file, JSON.stringify({ extensionId: id }));
  return file;
};
const HELPER = path.join(work, 'store-helper');
const helperBuilt = buildHelper(HELPER, undefined, helperConfig(HELPER_ID));

test('the store helper: its files, no forbidden word, every module parses, and the installer carries the extension id', () => {
  assert.deepEqual(listFiles(HELPER), [...HELPER_FILES, 'package.json', 'README.txt'].sort());
  assert.ok(helperBuilt.blocks['host.js'] >= 8 && helperBuilt.blocks['install.js'] >= 3, JSON.stringify(helperBuilt.blocks));
  assert.deepEqual(searchForbidden(HELPER), []);
  assert.ok(FORBIDDEN.test(fs.readFileSync(path.join(ROOT, 'native-host', 'host.js'), 'utf8')), 'the development helper does say them');
  assert.deepEqual(checkScripts(HELPER, helperBuilt.removed), []);
  const install = fs.readFileSync(path.join(HELPER, 'install.js'), 'utf8');
  assert.ok(install.includes(`STORE_EXTENSION_ID = '${HELPER_ID}'`) && !install.includes(ID_SLOT));
  assert.equal(JSON.parse(fs.readFileSync(path.join(HELPER, 'package.json'), 'utf8')).type, 'module');
  // (Files with no marker are copied as they are.)
  for (const f of ['protocol.js', ]) assert.ok(fs.readFileSync(path.join(ROOT, 'native-host', f)).equals(fs.readFileSync(path.join(HELPER, f))), f);
});

test('the store helper, running: it answers as the helper does, has no other downloader, and refuses its requests', async () => {
  const asks = [{ type: 'ping' }, { type: 'ytdlp', url: 'https://example.com/v' }, { type: 'ytdlpList', url: 'https://example.com/p' }, { type: 'updateYtdlp' }];
  const store = await askHelper(path.join(HELPER, 'host.js'), asks);
  assert.equal(store[1].type, 'result');
  assert.equal(store[1].version, JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')).version);
  assert.deepEqual(Object.keys(store[1].tools).sort(), ['claude', 'codex', 'ffmpeg']);
  for (const id of [2, 3, 4]) assert.deepEqual([store[id].type, store[id].error], ['error', `Unknown request type: ${asks[id - 1].type}`], asks[id - 1].type);
  // The development helper, asked the same: it does have them (so the answers above are the build's doing).
  // (Asked with an address that is not one, so it refuses before running anything.)
  const dev = await askHelper(path.join(ROOT, 'native-host', 'host.js'), [asks[0], { type: 'ytdlpList', url: 'not an address' }]);
  assert.ok('ytdlp' in dev[1].tools);
  assert.deepEqual([dev[2].type, dev[2].error], ['error', 'Invalid URL']);
});

test('the store helper\'s installer: without an id it stops before writing anything, and the build refuses an id that is not one', () => {
  const bare = path.join(work, 'store-helper-bare');
  const b = buildHelper(bare, undefined, helperConfig(''));
  assert.equal(b.id, '');
  assert.ok(fs.readFileSync(path.join(bare, 'install.js'), 'utf8').includes(`'${ID_SLOT}'`));
  assert.match(fs.readFileSync(path.join(bare, 'README.txt'), 'utf8'), /node install\.js --id /);
  for (const extra of [[], ['--id', 'not-an-id'], ['--id', 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP']]) {
    const r = spawnSync(process.execPath, [path.join(bare, 'install.js'), ...extra], { encoding: 'utf8' });
    assert.equal(r.status, 1, extra.join(' '));
    assert.match(r.stderr, /No extension id/, extra.join(' '));
  }
  // Nothing was written next to it (no launcher, no host manifest).
  assert.deepEqual(listFiles(bare), [...HELPER_FILES, 'package.json', 'README.txt'].sort());
  assert.throws(() => buildHelper(path.join(work, 'store-helper-bad'), undefined, helperConfig('abc')), /is not an extension id/);
});

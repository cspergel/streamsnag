// End-to-end smoke test: loads the unpacked extension into an isolated Chrome profile, serves a test
// site with a progressive MP4 and an HLS stream (whose segments require the page as Referer), lets the
// extension detect both, downloads them through the real job pipeline and verifies the saved bytes.
//   node scripts/e2e.js            (uses installed Google Chrome; set CHROME_PATH to override)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { findTool } from '../native-host/host.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extDir = path.join(root, 'extension');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'streamsnag-e2e-'));
const downloadDir = path.join(work, 'downloads');
fs.mkdirSync(downloadDir);

// ---------------------------------------------------------------- test site
const MP4 = Buffer.alloc(1536 * 1024, 7);
const HIDDEN = Buffer.alloc(800 * 1024, 9);
// Distinct videos must differ in size: identical size + type is how StreamSnag spots the same file twice.
const VARIANT = (kb, fill) => Buffer.alloc(MP4.length + kb * 1024, fill);
const LONG_MP4 = VARIANT(7, 3);
const LECTURES = { lec2: VARIANT(2, 4), lec3: VARIANT(3, 5), ep5: VARIANT(5, 6) }; // 1.5 MB "video" (header-based detection doesn't care)
// With ffmpeg installed (and the helper registered) the HLS stream is a real H.264/AAC transport stream plus a
// WebVTT subtitle rendition, and we check that StreamSnag hands back ONE finished MP4 with everything inside.
// Set E2E_MUX=0 to test the browser-only path (synthetic segments, byte-exact .ts).
const ffmpeg = process.env.E2E_MUX === '0' ? null : findTool('ffmpeg');
const MUX = !!ffmpeg;
function realTsSegments() {
  const ts = path.join(work, 'src.ts');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-f', 'mpegts', ts], { stdio: 'ignore', windowsHide: true });
  const all = fs.readFileSync(ts);
  const n = Math.ceil(all.length / 188 / 5) * 188; // split on TS packet boundaries
  return Array.from({ length: 5 }, (_, i) => all.subarray(i * n, (i + 1) * n)).filter((b) => b.length);
}
// Two tiny real videos (20 s = the test stream's length, 33 s = "the next lecture") for the lagging-player check.
function lagClips() {
  if (!MUX) return null;
  const make = (sec) => {
    const f = path.join(work, `lag${sec}.mp4`);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=64x36:rate=5:duration=${sec}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f], { stdio: 'ignore', windowsHide: true });
    return fs.readFileSync(f);
  };
  return { 20: make(20), 33: make(33) };
}
const LAG = lagClips();
const SEGMENTS = MUX ? realTsSegments() :Array.from({ length: 5 }, (_, i) => Buffer.alloc(100 * 1024, i + 1)); // seg i filled with byte i+1
const SUBS_VTT = 'WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHello from the test stream\n';
const LONG_TITLE = 'An Extremely Long Video Title That Will Never Fit In The Popup Width Part 3 Of The Series (Full Episode, Directors Cut)';
let refererRejections = 0;
let base = '';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra });
    res.end(body);
  };
  if (url.pathname === '/watch/42') {
    return send(200, 'text/html', `<!doctype html><title>Test Clip 42</title>
      <h1>Test Clip 42</h1>
      <video src="/media/movie.mp4" preload="auto" muted></video>
      <script>fetch('/hls/master.m3u8').then(r => r.text()).then(() => fetch('/hls/v720.m3u8'));</script>`);
  }
  if (url.pathname === '/watch/77') {
    // The real file URL only exists inside a player config script; nothing requests it on load.
    return send(200, 'text/html', `<!doctype html><title>Hidden Clip 77</title>
      <div id="player" data-id="77"><img src="data:," alt="poster"><button>Play</button></div>
      <script>window.__PLAYER_CONFIG__ = {"id":77,"title":"Hidden Clip 77","sources":{"hd":"${base}\/hidden\/clip77.mp4","sd":null}};</script>`);
  }
  if (url.pathname === '/watch/long') {
    return send(200, 'text/html', `<!doctype html><title>${LONG_TITLE}</title><video src="/media/long.mp4" preload="auto" muted></video>`);
  }
  if (url.pathname === '/media/long.mp4') return send(200, 'video/mp4', LONG_MP4);
  if (url.pathname.startsWith('/course/')) {
    // Like an LMS: the tab title is the program; the lecture name only appears in the page, and the
    // next lecture loads without a page reload.
    return send(200, 'text/html', `<!doctype html><title>Physics 101 Complete Program | Academy</title>
      <meta property="og:site_name" content="Academy">
      <header><nav><ul class="menu"><li class="active"><a href="/">Courses</a></li><li><a href="/me">My account</a></li></ul></nav></header>
      <h1>Physics 101 Complete Program</h1>
      <main style="display:flex;gap:20px">
        <div id="player-wrap"><video id="v" src="/media/lec2.mp4" width="640" height="360" muted></video></div>
        <aside class="course-curriculum"><ol>
          <li class="lesson-item"><span class="lesson-title">Lecture 1: Units and Measurement</span> <span>10:02</span></li>
          <li class="lesson-item active"><span class="lesson-title">Lecture 2: Thermodynamics</span> <span>12:30</span> ✓</li>
          <li class="lesson-item" id="next"><span class="lesson-title">Lecture 3: Entropy</span> <span>15:10</span></li>
        </ol></aside>
      </main>
      <script>
        document.getElementById('next').addEventListener('click', () => {
          document.querySelector('.lesson-item.active').classList.remove('active');
          document.getElementById('next').classList.add('active');
          history.pushState({}, '', '/course/physics-101/lecture-3');
          document.getElementById('v').src = '/media/lec3.mp4';
        });
      </script>`);
  }
  if (url.pathname === '/show/finale') {
    return send(200, 'text/html', `<!doctype html><title>StreamFlix</title>
      <h2>Episode 5 - The Finale</h2><video src="/media/ep5.mp4" width="640" height="360" muted></video>`);
  }
  if (/^\/media\/(lec\d|ep\d)\.mp4$/.test(url.pathname)) return send(200, 'video/mp4', LECTURES[url.pathname.slice(7, -4)]);
  if (url.pathname === '/hidden/clip77.mp4') return send(200, 'video/mp4', HIDDEN, {});
  if (url.pathname === '/go/clip.mp4') {
    // The page links one URL, the server redirects to a signed CDN-style link.
    res.writeHead(302, { location: '/files/clip.mp4?token=aaa&Expires=1' });
    return res.end();
  }
  if (url.pathname === '/dup') {
    return send(200, 'text/html', `<!doctype html><title>Dup Lesson</title>
      <h1>Dup Lesson</h1><video src="/go/clip.mp4" preload="auto" muted width="640" height="360"></video>
      <script>
        setTimeout(() => fetch('/files/clip.mp4?token=bbb&Expires=2', { headers: { Range: 'bytes=0-1000' } }), 600);
        setTimeout(() => fetch('/mirror/clip-copy.mp4', { headers: { Range: 'bytes=0-1000' } }), 900);
      </script>`);
  }
  if (url.pathname === '/studyhall') {
    // Like the user's site: a Vimeo showcase (playlist) per day in tabs, a live-event recording, and a
    // same-origin player frame whose title names the clip it plays.
    return send(200, 'text/html', `<!doctype html><title>Study Hall | Example Academy</title><h1>Study Hall</h1>
      <div role="tablist"><button role="tab" id="d1" aria-controls="day1">Day 1</button><button role="tab" id="lv" aria-controls="live">Recorded Livestream</button></div>
      <div role="tabpanel" id="day1" aria-labelledby="d1"><iframe data-src="https://vimeo.com/showcase/12471493/embed" width="640" height="360" title="Day 1 sessions"></iframe></div>
      <div role="tabpanel" id="live" aria-labelledby="lv" style="display:none"><iframe data-src="https://vimeo.com/event/4455667/embed" width="640" height="360"></iframe></div>
      <iframe src="/frame/player" width="640" height="360"></iframe>
      <div id="late"></div>
      <video width="320" height="180" preload="none"><track kind="subtitles" srclang="en" label="English" src="/subs/day1.vtt"></video>`);
  }
  if (url.pathname === '/lagging') {
    return send(200, 'text/html', `<!doctype html><title>Showcase | Example Academy</title><h1>Recorded Livestream</h1>
      <iframe src="/frame/lag" width="640" height="360"></iframe>`);
  }
  if (url.pathname === '/frame/lag') {
    // Like a Vimeo showcase moving on to the next lecture: the stream starts, the title catches up a second later.
    // Then the user clicks the next lecture: the title changes (and the player loads a 33 s video) before
    // that lecture's stream is requested; the 009 card must keep its name.
    return send(200, 'text/html', `<!doctype html><title>008: Recent Advances in Heart Failure Management</title>
      <video id="v" src="/media/lag20.mp4" width="600" height="340" muted preload="auto"></video>
      <script>
        fetch('/hls/master.m3u8').then(() => setTimeout(() => { document.title = '009: Updates in the Diagnosis and Management of C. diff'; }, 1000));
        setTimeout(() => { document.getElementById('v').src = '/media/lag33.mp4'; document.title = '010: Bedside Procedures for the Hospitalist'; }, 9000);
      </script>`);
  }
  if (LAG && (url.pathname === '/media/lag20.mp4' || url.pathname === '/media/lag33.mp4')) {
    return send(200, 'video/mp4', LAG[url.pathname.includes('33') ? 33 : 20]);
  }
  if (url.pathname === '/frame/player') {
    return send(200, 'text/html', `<!doctype html><title>Day 2 - Keynote from CME Showcase on Vimeo</title>
      <video width="600" height="340" muted></video><script>fetch('/hls/master.m3u8')</script>`);
  }
  if (url.pathname === '/tabs') {
    return send(200, 'text/html', `<!doctype html><title>Two Videos Lesson</title>
      <div role="tablist"><button role="tab" id="t1" aria-controls="p1">Part 1 - Intro</button><button role="tab" id="t2" aria-controls="p2">Part 2 - Demo</button></div>
      <div role="tabpanel" id="p1" aria-labelledby="t1">
        <iframe data-src="https://www.youtube.com/embed/aqz-KE-bpKQ" width="640" height="360" title="YouTube video player"></iframe>
      </div>
      <div role="tabpanel" id="p2" aria-labelledby="t2" style="display:none">
        <iframe data-src="https://player.vimeo.com/video/76979871?h=0" width="640" height="360" title="vimeo-player"></iframe>
      </div>`);
  }
  if (url.pathname === '/media/movie.mp4' || url.pathname === '/files/clip.mp4' || url.pathname === '/mirror/clip-copy.mp4') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : MP4.length - 1;
      const chunk = MP4.subarray(start, end + 1);
      return send(206, 'video/mp4', chunk, { 'content-range': `bytes ${start}-${end}/${MP4.length}`, 'accept-ranges': 'bytes' });
    }
    return send(200, 'video/mp4', MP4, { 'accept-ranges': 'bytes' });
  }
  if (url.pathname === '/hls/master.m3u8') {
    return send(200, 'application/vnd.apple.mpegurl', MUX
      ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs_en.m3u8"\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,SUBTITLES="subs"\nv720.m3u8\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,SUBTITLES="subs"\nv360.m3u8\n'
      : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nv720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nv360.m3u8\n');
  }
  if (url.pathname === '/hls/subs_en.m3u8') {
    return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsub0.vtt\n#EXT-X-ENDLIST\n');
  }
  if (url.pathname === '/hls/sub0.vtt' || url.pathname === '/subs/day1.vtt') return send(200, 'text/vtt', SUBS_VTT);
  if (url.pathname === '/hls/v720.m3u8' || url.pathname === '/hls/v360.m3u8') {
    const body = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
      ...SEGMENTS.flatMap((_, i) => ['#EXTINF:4.0,', `seg${i}.ts`]), '#EXT-X-ENDLIST'].join('\n');
    return send(200, 'application/vnd.apple.mpegurl', body);
  }
  const seg = /^\/hls\/seg(\d)\.ts$/.exec(url.pathname);
  if (seg) {
    // Like many CDNs: refuse segment requests that don't come "from" the watch page.
    if (!String(req.headers.referer || '').includes('/watch/42')) {
      refererRejections++;
      return send(403, 'text/plain', 'forbidden');
    }
    return send(200, 'video/mp2t', SEGMENTS[Number(seg[1])]);
  }
  send(404, 'text/plain', 'not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- browser
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// Point the isolated profile's default download folder at our temp dir (like a real user setting).
fs.mkdirSync(path.join(work, 'profile', 'Default'), { recursive: true });
fs.writeFileSync(path.join(work, 'profile', 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
}));

// The helper (started by Chrome) inherits these: a saved playlist listing and a fake yt-dlp, so the playlist
// checks never touch a real site.
const playlistFile = path.join(work, 'playlist.json');
fs.writeFileSync(playlistFile, JSON.stringify({
  _type: 'playlist', id: '12471493', title: 'Day 1 sessions', extractor: 'vimeo:album',
  entries: [
    { _type: 'url', ie_key: 'Vimeo', id: '5550001', url: 'https://vimeo.com/5550001', title: '001: Opening Session', duration: 600 },
    { _type: 'url', ie_key: 'Vimeo', id: '5550002', url: 'https://vimeo.com/5550002', title: '002: Valve Disease Update' },
    { _type: 'url', ie_key: 'Vimeo', id: '5550003', url: 'https://vimeo.com/5550003', title: '003: Closing Remarks', duration: 1200 },
  ],
}));

const browser = await puppeteer.launch({
  env: { ...process.env, STREAMSNAG_TEST_PLAYLIST: playlistFile, STREAMSNAG_FAKE_YTDLP: '1' },
  executablePath: chromePath,
  headless: true,
  pipe: true,
  enableExtensions: true,
  userDataDir: path.join(work, 'profile'),
  args: ['--no-first-run', '--no-default-browser-check'],
});

try {
  const extId = await browser.installExtension(extDir);
  check('extension loads', /^[a-p]{32}$/.test(extId), extId);

  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId), { timeout: 15000 });
  check('service worker starts', !!swTarget);

  // Close the options tab that opens on install.
  await new Promise((r) => setTimeout(r, 800));
  for (const p of await browser.pages()) if (p.url().includes('options.html')) await p.close();

  const page = await browser.newPage();
  await page.goto(`${base}/watch/42`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1500));

  // Drive the extension through its real message API from an extension page.
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html`);
  const tabId = await ext.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(u)).id, `${base}/watch/42`);
  const call = (type, payload = {}) => ext.evaluate((t, p) => chrome.runtime.sendMessage({ type: t, ...p }), type, { tabId, ...payload });

  const state = (await call('getTabState')).data;
  const mp4 = state.media.find((m) => m.kind === 'direct');
  const hls = state.media.find((m) => m.kind === 'hls');
  check('detects progressive MP4 with real size from Content-Range', mp4 && mp4.size === MP4.length, mp4?.label);
  check('detects HLS master playlist', !!hls, hls?.label);
  check('hides the variant playlist under its master', !state.media.some((m) => m.url.endsWith('v720.m3u8')), state.media.map((m) => m.url.split('/').pop()).join(', '));
  check('page title captured', state.page.title === 'Test Clip 42', state.page.title);

  const inspect = (await call('inspect', { mediaId: hls.id })).data;
  check('lists HLS qualities best-first', inspect.options?.[0]?.label.startsWith('720p') && inspect.options.filter((o) => o.id.startsWith('v')).length === 2, inspect.options?.map((o) => o.label).join(' | '));

  await call('download', { mediaId: mp4.id, optionId: 'file' });
  const hlsStart = await call('download', { mediaId: hls.id, optionId: 'v0' });
  check('HLS download job starts', hlsStart.ok, hlsStart.error);

  // Wait for both jobs to finish.
  let jobs = [];
  for (let i = 0; i < 60; i++) {
    jobs = (await call('getTabState')).data.jobs;
    if (jobs.length >= 2 && jobs.every((j) => ['done', 'error', 'canceled'].includes(j.status))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const j of jobs) check(`job "${j.filename}" finished`, j.status === 'done', j.error || j.status);

  const files = fs.readdirSync(downloadDir, { recursive: true }).map(String);
  console.log('      saved files:', files.join(' | '));
  const findFile = (ext, not) => files.find((f) => f.endsWith(ext) && !f.endsWith('.crdownload') && !(not && f.includes(not)));
  const mp4File = findFile('.mp4', '720p');
  const tsFile = findFile('.ts');
  check('MP4 saved with exact bytes', mp4File && fs.readFileSync(path.join(downloadDir, mp4File)).equals(MP4), mp4File);
  if (MUX) {
    const hlsJob = jobs.find((j) => j.kind === 'hls');
    const out = files.find((f) => f.includes('Test Clip 42 - 720p') && f.endsWith('.mp4'));
    check('stream finished as ONE merged .mp4 (no .ts / .vtt left behind)', !!out && !tsFile && !findFile('.vtt'), `${files.join(' | ')}; note: ${hlsJob?.note}`);
    let streams = [];
    if (out) {
      const ffprobe = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
      streams = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(downloadDir, out)], { encoding: 'utf8', windowsHide: true })).streams;
    }
    const kinds = streams.map((x) => `${x.codec_type}:${x.codec_name}`).sort().join(', ');
    check('merged MP4 has video, audio and embedded English subtitles', kinds === 'audio:aac, subtitle:mov_text, video:h264'
      && streams.find((x) => x.codec_type === 'subtitle')?.tags?.language === 'eng', kinds);
    const v = streams.find((x) => x.codec_type === 'video');
    check('merged MP4 plays the full length', Number(v?.duration || 0) > 5, `${v?.duration}s`);
  } else {
    const ts = tsFile ? fs.readFileSync(path.join(downloadDir, tsFile)) : Buffer.alloc(0);
    check('HLS segments merged in order into one .ts', ts.equals(Buffer.concat(SEGMENTS)), `${tsFile} ${ts.length} bytes`);
    check('file named from page title + quality', !!tsFile && tsFile.includes('Test Clip 42 - 720p'), tsFile);
  }
  check('Referer rule made the CDN accept segments', refererRejections === 0, `${refererRejections} rejected`);

  // Render the real popup for this tab and capture it.
  const popup = await browser.newPage();
  const consoleErrors = [];
  popup.on('pageerror', (e) => consoleErrors.push(e.message));
  popup.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await popup.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  await new Promise((r) => setTimeout(r, 1200));
  const cards = await popup.$$eval('#media .card', (els) => els.length);
  check('popup renders detected media and jobs without errors', cards === 2 && !consoleErrors.length, `${cards} cards; ${consoleErrors.join('; ')}`);
  if (process.env.SHOT) await popup.screenshot({ path: process.env.SHOT, fullPage: true });

  // Downloaded / not-downloaded status and filters.
  const tags = await popup.$$eval('#media .card .st', (els) => els.map((e) => e.textContent));
  check('both items are marked as downloaded', tags.length === 2 && tags.every((t) => t.includes('Downloaded')), tags.join(', '));
  await popup.evaluate(() => [...document.querySelectorAll('#filters .chip')].find((c) => c.textContent.startsWith('Not downloaded')).click());
  await new Promise((r) => setTimeout(r, 200));
  const notDl = await popup.$$eval('#media .card', (els) => els.length);
  const emptyMsg = await popup.$eval('#empty', (e) => (e.hidden ? '' : e.textContent.trim()));
  check('"Not downloaded" filter hides saved items', notDl === 0 && /Everything on this page is downloaded/.test(emptyMsg), `${notDl} cards; ${emptyMsg}`);
  await popup.evaluate(() => document.querySelector('#filters .chip').click());

  // Long names scroll across on hover, and expand when clicked.
  const longPage = await browser.newPage();
  await longPage.goto(`${base}/watch/long`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1000));
  const longTab = await ext.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/watch/long`);
  const lp = await browser.newPage();
  await lp.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
  await lp.goto(`chrome-extension://${extId}/popup.html?tabId=${longTab}`);
  await new Promise((r) => setTimeout(r, 1000));
  const fit = await lp.$eval('#media .card .title', (e) => ({ overflow: e.classList.contains('overflow'), tip: e.title }));
  check('long name is detected as overflowing and has a full-name tooltip', fit.overflow && fit.tip === LONG_TITLE, JSON.stringify(fit).slice(0, 120));
  await lp.hover('#media .card');
  await new Promise((r) => setTimeout(r, 2600)); // past the 0.4s delay + 12% hold
  const shifted = await lp.$eval('#media .card .title > span', (e) => new DOMMatrix(getComputedStyle(e).transform).m41);
  check('long name scrolls across on hover', shifted < -20, `translateX ${shifted.toFixed(0)}px`);
  if (process.env.SHOT) await lp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-hover.png') });
  await new Promise((r) => setTimeout(r, 2500)); // survives a background refresh without resetting
  const stillSame = await lp.$eval('#media .card .title', (e) => e.parentElement.closest('li').dataset.sig !== undefined);
  await lp.click('#media .card .title');
  const h1 = await lp.$eval('#media .card .title', (e) => ({ h: e.getBoundingClientRect().height, x: e.classList.contains('expanded') }));
  check('clicking a long name shows it in full', h1.x && h1.h > 30 && stillSame, `${h1.h.toFixed(0)}px tall`);

  // Side panel layout: details, full URL, and the history of what was saved.
  const sp = await browser.newPage();
  const spErrors = [];
  sp.on('pageerror', (e) => spErrors.push(e.message));
  await sp.setViewport({ width: 460, height: 900, deviceScaleFactor: 2 });
  await sp.goto(`chrome-extension://${extId}/sidepanel.html`);
  await sp.waitForFunction(() => location.search.includes('view=panel'));
  await sp.goto(`chrome-extension://${extId}/popup.html?view=panel&tabId=${tabId}`);
  await new Promise((r) => setTimeout(r, 1200));
  const panel = await sp.evaluate(() => ({
    panel: document.body.classList.contains('sidebar'),
    details: document.querySelectorAll('#media .details').length,
    urls: [...document.querySelectorAll('#media .details dd.url')].map((d) => d.textContent),
    saved: [...document.querySelectorAll('#media .details dt')].filter((d) => d.textContent === 'Saved').length,
    history: document.querySelectorAll('#history .card').length,
    sidebarBtnHidden: document.querySelector('#btn-sidebar').hidden,
  }));
  check('side panel shows details + full URLs for each item', panel.panel && panel.details === 2 && panel.urls.every((u) => u.startsWith(base)) && panel.sidebarBtnHidden, JSON.stringify(panel).slice(0, 160));
  check('side panel shows when each item was saved and the download history', panel.saved === 2 && panel.history >= 2 && !spErrors.length, `${panel.saved} saved, ${panel.history} history; ${spErrors.join('; ')}`);
  if (process.env.SHOT) await sp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-panel.png'), fullPage: true });

  // Custom save folder anywhere on disk + a per-site subfolder (moved there by the local helper).
  const custom = path.join(work, 'My Videos');
  await ext.evaluate(async (dir) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, saveFolder: dir, subfolder: 'Vids/{site}' } });
  }, custom);
  const folderOk = await call('checkFolder', { path: custom });
  check('custom folder validated by the helper', folderOk.ok && folderOk.data.writable, folderOk.error || folderOk.data?.path);
  const longMedia = (await ext.evaluate((t) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: t }), longTab)).data.media[0];
  await ext.evaluate((t, id) => chrome.runtime.sendMessage({ type: 'download', tabId: t, mediaId: id, optionId: 'file' }), longTab, longMedia.id);
  let longJob;
  for (let i = 0; i < 40; i++) {
    longJob = (await ext.evaluate((t) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: t }), longTab)).data.jobs.find((j) => j.mediaUrl === longMedia.url);
    if (longJob && ['done', 'error'].includes(longJob.status)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const customFiles = fs.existsSync(custom) ? fs.readdirSync(custom, { recursive: true }).map(String) : [];
  const moved = customFiles.find((f) => f.endsWith('.mp4'));
  check('download lands in the custom folder under Vids/<site>/', !!moved && /^Vids[\\/][^\\/]+[\\/]An Extremely Long/.test(moved)
    && fs.readFileSync(path.join(custom, moved)).equals(LONG_MP4) && longJob?.outputs?.[0]?.path === path.join(custom, moved),
  `${moved}; out=${longJob?.outputs?.[0]?.path}; bytes=${moved && fs.statSync(path.join(custom, moved)).size}`);
  const leftInDownloads = fs.readdirSync(downloadDir, { recursive: true }).map(String).some((f) => f.includes('An Extremely Long'));
  check('nothing left behind in Downloads', !leftInDownloads);

  // Lecture names: read from the page (highlighted lesson / heading), not the program-wide tab title.
  const tabOf = (u) => ext.evaluate(async (x) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(x))?.id, u);
  const stateOf = async (id) => (await ext.evaluate((t) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: t }), id)).data;
  const waitFor = async (fn, ms = 6000) => {
    for (let i = 0; i < ms / 200; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };
  const course = await browser.newPage();
  await course.goto(`${base}/course/physics-101/lecture-2`, { waitUntil: 'networkidle0' });
  const courseTab = await tabOf(`${base}/course/`);
  const lec2 = await waitFor(async () => (await stateOf(courseTab)).media.find((m) => m.url.endsWith('lec2.mp4') && m.title));
  check('names a lecture from the highlighted lesson, not the tab title', lec2?.title === 'Lecture 2: Thermodynamics' && lec2?.nameSource === 'list',
    `${lec2?.title} (${lec2?.nameSource}); course: ${lec2?.course}`);
  check('works out the course name from the tab title', lec2?.course === 'Physics 101 Complete Program', lec2?.course);
  await course.click('#next');
  const lec3 = await waitFor(async () => (await stateOf(courseTab)).media.find((m) => m.url.endsWith('lec3.mp4') && m.title));
  check('the next lecture (loaded without a page reload) gets its own name', lec3?.title === 'Lecture 3: Entropy', lec3?.title);
  if (lec3) {
    await ext.evaluate((t, id) => chrome.runtime.sendMessage({ type: 'download', tabId: t, mediaId: id, optionId: 'file' }), courseTab, lec3.id);
    const j3 = await waitFor(async () => (await stateOf(courseTab)).jobs.find((j) => j.mediaUrl === lec3.url && j.status === 'done'));
    check('the saved file is named after the lecture', !!j3 && path.basename(j3.outputs[0].path) === 'Lecture 3 Entropy.mp4', j3?.outputs?.[0]?.path);
    const rn = await ext.evaluate((t, id) => chrome.runtime.sendMessage({ type: 'renameMedia', tabId: t, mediaId: id, name: '03 - Entropy (my notes)' }), courseTab, lec3.id);
    await ext.evaluate((t, id) => chrome.runtime.sendMessage({ type: 'download', tabId: t, mediaId: id, optionId: 'file' }), courseTab, lec3.id);
    const j3b = await waitFor(async () => (await stateOf(courseTab)).jobs.find((j) => j.mediaUrl === lec3.url && j.status === 'done' && j.title.startsWith('03')));
    check('Rename changes the saved file name', rn.ok && !!j3b && path.basename(j3b.outputs[0].path) === '03 - Entropy (my notes).mp4', j3b?.outputs?.[0]?.path || rn.error);
  }
  const show = await browser.newPage();
  await show.goto(`${base}/show/finale`, { waitUntil: 'networkidle0' });
  const showTab = await tabOf(`${base}/show/`);
  const ep = await waitFor(async () => (await stateOf(showTab)).media.find((m) => m.title));
  check('names an episode from the heading next to the player', ep?.title === 'Episode 5 - The Finale' && ep?.nameSource === 'heading', `${ep?.title} (${ep?.nameSource})`);
  const popCourse = await browser.newPage();
  await popCourse.setViewport({ width: 460, height: 700, deviceScaleFactor: 2 });
  await popCourse.goto(`chrome-extension://${extId}/popup.html?view=panel&tabId=${courseTab}`);
  await new Promise((r) => setTimeout(r, 1000));
  const shownNames = await popCourse.$$eval('#media .card .title', (els) => els.map((e) => e.textContent));
  check('popup shows each lecture by its own name (and the rename)', shownNames.includes('03 - Entropy (my notes)') && !shownNames.some((n) => n.includes('Complete Program')), shownNames.join(' | '));
  if (process.env.SHOT) await popCourse.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-course.png'), fullPage: true });

  // Duplicates: one video seen via a redirect, a re-signed link and a mirror copy shows as ONE item.
  const dupPage = await browser.newPage();
  await dupPage.goto(`${base}/dup`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 2500));
  const dupTab = await tabOf(`${base}/dup`);
  const dupMedia = (await stateOf(dupTab)).media.filter((m) => m.kind !== 'subtitle');
  check('the same video under 3 different links is listed once', dupMedia.length === 1 && dupMedia[0].seen >= 3,
    `${dupMedia.length} items: ${dupMedia.map((m) => `${m.url.replace(base, '')} seen ${m.seen || 1}`).join(', ')}`);
  if (dupMedia.length) {
    await ext.evaluate((t, id) => chrome.runtime.sendMessage({ type: 'download', tabId: t, mediaId: id, optionId: 'file' }), dupTab, dupMedia[0].id);
    await waitFor(async () => (await stateOf(dupTab)).jobs.find((j) => j.status === 'done'));
    // The site hands out a fresh signed link later: still one item, and still marked as downloaded.
    await dupPage.evaluate(() => fetch('/files/clip.mp4?token=zzz&Expires=9', { headers: { Range: 'bytes=0-1000' } }));
    await new Promise((r) => setTimeout(r, 800));
    const dp = await browser.newPage();
    await dp.goto(`chrome-extension://${extId}/popup.html?tabId=${dupTab}`);
    await new Promise((r) => setTimeout(r, 1000));
    const dpTags = await dp.$$eval('#media .card .st', (els) => els.map((e) => e.textContent));
    check('a re-signed link of a downloaded video still shows as downloaded', dpTags.length === 1 && dpTags[0].includes('Downloaded'), dpTags.join(', '));
    await dp.evaluate(() => document.querySelector('#media .card .more').click());
    await dp.evaluate(() => [...document.querySelectorAll('#media .menu button')].find((b) => b.textContent === 'Remove from list').click());
    await new Promise((r) => setTimeout(r, 700));
    const afterRemove = await dp.evaluate(() => ({ cards: document.querySelectorAll('#media .card').length, note: document.querySelector('#removed').textContent }));
    await dp.evaluate(() => document.querySelector('#removed button').click());
    await new Promise((r) => setTimeout(r, 700));
    const afterUndo = await dp.$$eval('#media .card', (els) => els.length);
    check('Remove from list hides an item, and Show again brings it back', afterRemove.cards === 0 && /1 removed/.test(afterRemove.note) && afterUndo === 1,
      `${afterRemove.cards} cards, "${afterRemove.note}", ${afterUndo} after undo`);
  }

  // Players inside tabs that were never opened (lazy iframes, no network traffic at all).
  const tabsPage = await browser.newPage();
  await tabsPage.goto(`${base}/tabs`, { waitUntil: 'networkidle0' });
  const tabsTab = await tabOf(`${base}/tabs`);
  const embedsFound = await waitFor(async () => {
    const ms = (await stateOf(tabsTab)).media;
    const yt = ms.find((m) => m.provider === 'youtube');
    const vm = ms.find((m) => m.provider === 'vimeo');
    return yt && vm && (vm.kind !== 'hls' || vm.label.includes('qualities')) ? { yt, vm } : null;
  }, 15000);
  check('finds the embedded players in both tabs, including the hidden one', !!embedsFound,
    embedsFound ? `${embedsFound.yt.kind}/${embedsFound.vm.kind}` : JSON.stringify((await stateOf(tabsTab)).media.map((m) => [m.kind, m.provider, m.title])));
  if (embedsFound) {
    const { yt, vm } = embedsFound;
    check('YouTube embed is offered to yt-dlp, named after its tab', yt.kind === 'embed' && yt.title === 'Part 1 - Intro' && yt.section === 'Part 1 - Intro', `${yt.kind} "${yt.title}" [${yt.section}]`);
    // Needs internet: Vimeo's public player config gives the real stream and title.
    check('hidden Vimeo video resolved to its HLS stream with the real Vimeo title', vm.kind === 'hls' && /Vimeo Player/.test(vm.title) && vm.section === 'Part 2 - Demo',
      `${vm.kind} "${vm.title}" [${vm.section}] ${vm.label}`);
  }

  // Refresh checks the folder: a renamed download still counts, a deleted one is flagged.
  const libState = async (id) => (await stateOf(id));
  const renamedFrom = fs.readdirSync(path.join(downloadDir, 'StreamSnag')).find((f) => f.includes('720p'));
  if (renamedFrom) fs.renameSync(path.join(downloadDir, 'StreamSnag', renamedFrom), path.join(downloadDir, 'StreamSnag', `my own name${path.extname(renamedFrom)}`));
  const longFile = customFiles.find((f) => f.endsWith('.mp4'));
  if (longFile) fs.unlinkSync(path.join(custom, longFile));
  const t0 = Date.now();
  await page.reload({ waitUntil: 'networkidle0' }); // like the user pressing F5
  await longPage.reload({ waitUntil: 'networkidle0' });
  const scanned = await waitFor(async () => {
    const st = await libState(tabId);
    return st.library?.at > t0 && !st.library.scanning ? st : null;
  }, 20000);
  const hlsNow = scanned?.media.find((m) => m.kind === 'hls');
  check('after a refresh, a renamed download is still recognised', hlsNow?.library?.how === 'renamed' && /my own name/.test(hlsNow.library.path),
    JSON.stringify(hlsNow?.library || scanned?.library || 'no scan'));
  const longNow = await waitFor(async () => (await libState(longTab)).media.find((m) => m.library));
  check('a deleted download is flagged as not in the folder', longNow?.library?.missing === true, JSON.stringify(longNow?.library));
  const lp2 = await browser.newPage();
  await lp2.goto(`chrome-extension://${extId}/popup.html?tabId=${longTab}`);
  await new Promise((r) => setTimeout(r, 900));
  const lpInfo = await lp2.evaluate(() => ({ tag: document.querySelector('#media .card .st')?.textContent, lib: document.querySelector('#library')?.textContent }));
  check('popup says "File not in folder" and when the folder was checked', lpInfo.tag === 'File not in folder' && /Checked \d+ video file/.test(lpInfo.lib || ''), JSON.stringify(lpInfo));

  // Showcases (playlists) and live events, a player inside a frame, and a deep scan without reloading.
  const hall = await browser.newPage();
  await hall.goto(`${base}/studyhall`, { waitUntil: 'networkidle0' });
  const hallTab = await tabOf(`${base}/studyhall`);
  const hallMedia = await waitFor(async () => {
    const ms = (await stateOf(hallTab)).media;
    return ms.some((m) => m.provider === 'vimeo-showcase') && ms.some((m) => m.provider === 'vimeo-event') && ms.some((m) => m.kind === 'hls' && m.title) ? ms : null;
  }, 10000);
  const showcase = hallMedia?.find((m) => m.provider === 'vimeo-showcase');
  const event = hallMedia?.find((m) => m.provider === 'vimeo-event');
  check('a Vimeo showcase (playlist) is listed as one "download all" item', showcase?.playlist === true && showcase.url === 'https://vimeo.com/showcase/12471493' && showcase.title === 'Day 1 sessions',
    JSON.stringify(showcase && { url: showcase.url, title: showcase.title, playlist: showcase.playlist, section: showcase.section }));
  check('a Vimeo live event in a hidden tab is listed, named after its tab', event?.url === 'https://vimeo.com/event/4455667' && event.title === 'Recorded Livestream',
    JSON.stringify(event && { url: event.url, title: event.title }));
  const framed = hallMedia?.find((m) => m.kind === 'hls');
  check('a stream played inside a player frame is named from that player', framed?.title === 'Day 2 - Keynote' && framed.nameSource === 'player' && framed.course === 'Study Hall',
    JSON.stringify(framed && { title: framed.title, src: framed.nameSource, course: framed.course }));
  // A player mounted inside a web component's shadow DOM; "Scan again" picks it up at once.
  await hall.evaluate(() => {
    const root = document.getElementById('late').attachShadow({ mode: 'open' });
    root.innerHTML = '<video src="/media/ep5.mp4" preload="none" width="640" height="360"></video>';
  });
  const hiddenBefore = (await stateOf(hallTab)).media.some((m) => m.url.endsWith('/media/ep5.mp4'));
  const scan = await ext.evaluate((t) => chrome.runtime.sendMessage({ type: 'rescan', tabId: t }), hallTab);
  const hiddenAfter = (await stateOf(hallTab)).media.some((m) => m.url.endsWith('/media/ep5.mp4'));
  check('Scan again finds a video hidden in a web component, without reloading the page', !hiddenBefore && hiddenAfter && scan.ok && scan.data.added >= 1,
    `before ${hiddenBefore}, after ${hiddenAfter}; ${JSON.stringify(scan.data || scan.error)}`);
  const ep5 = (await stateOf(hallTab)).media.find((m) => m.url.endsWith('/media/ep5.mp4'));
  check("each video is named from its own player, not the page's biggest one", !!ep5 && ep5.title !== 'Day 1 sessions', `${ep5?.title} (${ep5?.nameSource})`);
  // ...and the page is re-checked on its own every few seconds, so a later player shows up without a click.
  await hall.evaluate(() => {
    const host = document.createElement('div');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<iframe src="https://player.vimeo.com/video/11112222?h=ab" width="640" height="360" title="Day 3 - Closing"></iframe>';
  });
  const autoFound = await waitFor(async () => (await stateOf(hallTab)).media.find((m) => m.embedUrl?.includes('11112222') || m.url.includes('11112222')), 8000);
  check('a player added later inside a web component is found without clicking anything', !!autoFound, autoFound ? autoFound.title : 'not found in 8 s');

  // Already have it? A file named after the video, in a folder you added, counts as downloaded.
  const shelf = path.join(work, 'Old downloads');
  fs.mkdirSync(path.join(shelf, 'Conference'), { recursive: true });
  fs.writeFileSync(path.join(shelf, 'Conference', 'Recorded Livestream - 1080p.mp4'), Buffer.alloc(4096, 7)); // not a real video: no length to compare
  const added = await call('addLibraryFolder', { path: shelf });
  const checked = await call('checkLibrary');
  const eventNow = (await stateOf(hallTab)).media.find((m) => m.provider === 'vimeo-event');
  check("a file with the video's name in an added folder counts as downloaded", added.ok && checked.ok && checked.data.dirs.includes(shelf)
    && eventNow?.library?.how === 'name' && /Recorded Livestream - 1080p\.mp4$/.test(eventNow.library.path),
  JSON.stringify({ added: added.data || added.error, dirs: checked.data?.dirs, lib: eventNow?.library }));
  // Mark as downloaded / undo, by hand, for anything the folder check can't see.
  const sc = (await stateOf(hallTab)).media.find((m) => m.provider === 'vimeo-showcase');
  await call('markMedia', { tabId: hallTab, mediaId: sc.id, as: 'done' });
  const marked = (await stateOf(hallTab)).media.find((m) => m.id === sc.id);
  const othersMarked = (await stateOf(hallTab)).media.filter((m) => m.mark && m.id !== sc.id).length;
  await call('markMedia', { tabId: hallTab, mediaId: sc.id, as: null });
  const unmarked = (await stateOf(hallTab)).media.find((m) => m.id === sc.id);
  check('Mark as downloaded sticks (to that item only), and Undo clears it', marked?.mark === 'done' && marked.library?.how === 'manual' && !othersMarked && !unmarked?.mark && !unmarked?.library,
    JSON.stringify({ marked: marked && [marked.mark, marked.library], othersMarked, unmarked: unmarked && [unmarked.mark, unmarked.library] }));

  const hp = await browser.newPage();
  const hpErrors = [];
  hp.on('pageerror', (e) => hpErrors.push(e.message));
  hp.on('console', (msg) => { if (msg.type() === 'error') hpErrors.push(msg.text()); });
  await hp.goto(`chrome-extension://${extId}/popup.html?tabId=${hallTab}`);
  await new Promise((r) => setTimeout(r, 900));
  const btn = await hp.evaluate(() => [...document.querySelectorAll('#media .card')].map((c) => c.querySelector('.primary')?.textContent));
  check('the showcase card offers "List videos" (Download all is in its menu)', btn.includes('List videos'), btn.join(', '));
  // Organising the list: subtitle files tucked away, search, sort/group.
  const org = await hp.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cards = () => [...document.querySelectorAll('#media > li.card')].map((c) => c.querySelector('.title')?.textContent.trim());
    const out = {
      subInMain: [...document.querySelectorAll('#media .thumb.subtitle')].length,
      subsBox: !document.querySelector('#subs-box').hidden, subsCount: document.querySelector('#subs-count').textContent,
      subsListHidden: document.querySelector('#subs').hidden, all: cards().length,
    };
    document.querySelector('#subs-toggle').click();
    await wait(50);
    out.subsOpen = document.querySelectorAll('#subs > li.card').length;
    out.listbar = !document.querySelector('#listbar').hidden;
    const search = document.querySelector('#search');
    search.value = 'keynote';
    search.dispatchEvent(new Event('input'));
    await wait(50);
    out.searched = cards();
    search.value = '';
    search.dispatchEvent(new Event('input'));
    const sort = document.querySelector('#sort');
    sort.value = 'section';
    sort.dispatchEvent(new Event('change'));
    await wait(50);
    out.groups = [...document.querySelectorAll('#media > li.group-h .gname')].map((g) => g.textContent);
    sort.value = 'name';
    sort.dispatchEvent(new Event('change'));
    await wait(50);
    out.byName = cards();
    sort.value = 'default';
    sort.dispatchEvent(new Event('change'));
    return out;
  });
  const sortedOk = JSON.stringify(org.byName) === JSON.stringify([...org.byName].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })));
  check('subtitle files are collapsed into their own group, out of the video list', org.subInMain === 0 && org.subsBox && org.subsCount === '1' && org.subsListHidden && org.subsOpen === 1,
    JSON.stringify(org));
  check('search narrows the list; sort by name and group by tab work', org.listbar && org.searched.length === 1 && /Keynote/.test(org.searched[0])
    && org.groups.includes('Day 1') && org.groups.includes('Recorded Livestream') && sortedOk && org.byName.length === org.all && !hpErrors.length,
  JSON.stringify({ searched: org.searched, groups: org.groups, byName: org.byName, errors: hpErrors }));
  // The sidebar lists what is in your folders.
  const fp = await browser.newPage();
  await fp.goto(`chrome-extension://${extId}/popup.html?view=panel&tabId=${hallTab}`);
  await new Promise((r) => setTimeout(r, 1200));
  const folderView = await fp.evaluate(async () => {
    const names = () => [...document.querySelectorAll('#folder-files .title')].map((t) => t.textContent.trim());
    const all = names();
    const s = document.querySelector('#folder-search');
    s.value = 'livestream';
    s.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 50));
    const here = [...document.querySelectorAll('#folder-files .card')].map((c) => c.querySelector('.st')?.textContent || '');
    return { shown: !document.querySelector('#folder-section').hidden, all: all.length, hit: names(), here, dirs: document.querySelectorAll('#library .dirs li').length };
  });
  check('the sidebar lists the files in your folders, searchable, marking ones on this page', folderView.shown && folderView.all >= 2
    && folderView.hit.length === 1 && folderView.here[0] === 'On this page' && folderView.dirs >= 2, JSON.stringify(folderView));
  if (process.env.SHOT) {
    await hp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-organize.png'), fullPage: true });
    await fp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-folders.png'), fullPage: true });
  }

  // A whole playlist: list every video (not only the ones played), then download just the missing ones,
  // two at most at once, named by a site rule. (yt-dlp is faked by the helper in this test: no network.)
  fs.writeFileSync(path.join(shelf, 'Conference', '002 - Valve Disease Update - 720p.mp4'), Buffer.alloc(5000, 3));
  await ext.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, maxParallel: 1, siteRules: { '127.0.0.1': { subfolder: 'Rules/{site}', filenameTemplate: '{number} - {name}' } } } });
  });
  await call('checkLibrary');
  const showcaseNow = (await stateOf(hallTab)).media.find((m) => m.provider === 'vimeo-showcase');
  const listed = await call('listPlaylist', { tabId: hallTab, mediaId: showcaseNow.id });
  const entries = (await stateOf(hallTab)).media.filter((m) => m.parentId === showcaseNow.id).sort((a, b) => a.playlistIndex - b.playlistIndex);
  check('List videos shows every video of a playlist, numbered, with "002" recognised as already downloaded',
    listed.ok && listed.data.count === 3 && entries.map((e) => e.title).join('|') === '001: Opening Session|002: Valve Disease Update|003: Closing Remarks'
    && entries[1]?.library?.how === 'name' && !entries[0].library && !entries[2].library,
  JSON.stringify(listed.ok ? entries.map((e) => [e.title, e.library?.how || '-']) : listed.error));
  const plp = await browser.newPage();
  await plp.goto(`chrome-extension://${extId}/popup.html?tabId=${hallTab}`);
  await new Promise((r) => setTimeout(r, 900));
  const missingBtn = await plp.evaluate(() => [...document.querySelectorAll('#media .card .primary')].map((b) => b.textContent).find((t) => /missing/i.test(t)) || '');
  check('the playlist card offers "Download missing (2)"', missingBtn === 'Download missing (2)', missingBtn);
  const dm = await call('downloadMissing', { tabId: hallTab, mediaId: showcaseNow.id });
  const jobsNow = (await stateOf(hallTab)).jobs.filter((j) => entries.some((e) => e.id === j.mediaId));
  check('Download missing queues only the 2 missing videos, one at a time (the queue)', dm.ok && dm.data.queued === 2 && dm.data.skipped === 1
    && jobsNow.filter((j) => j.status === 'running').length === 1 && jobsNow.filter((j) => j.status === 'queued').length === 1,
  JSON.stringify({ dm: dm.data || dm.error, jobs: jobsNow.map((j) => j.status) }));
  const allDone = await waitFor(async () => {
    const js = (await stateOf(hallTab)).jobs.filter((j) => entries.some((e) => e.id === j.mediaId));
    return js.length === 2 && js.every((j) => j.status === 'done') ? js : null;
  }, 15000);
  const ruled = fs.existsSync(path.join(custom, 'Rules', '127.0.0.1')) ? fs.readdirSync(path.join(custom, 'Rules', '127.0.0.1')).sort() : [];
  check('both finish, saved where the site rule says, named "{number} - {name}"', !!allDone && ruled.join('|') === '001 - Opening Session.mp4|003 - Closing Remarks.mp4',
    `${ruled.join(', ')}; ${allDone ? 'done' : 'not done'}`);
  await plp.reload();
  await new Promise((r) => setTimeout(r, 1200));
  const afterCard = await plp.evaluate(() => {
    const c = [...document.querySelectorAll('#media .card')].find((x) => /playlist ·/.test(x.textContent));
    return { button: c?.querySelector('.row > .st-done, .row > .primary')?.textContent || '', sub: c?.querySelector('.sub')?.textContent || '' };
  });
  check('then the playlist card says everything is downloaded (3 of 3)', /All downloaded/.test(afterCard.button) && /3 videos · 3 downloaded/.test(afterCard.sub),
    JSON.stringify(afterCard));
  // Downloading some videos of a playlist must not mark the playlist itself as saved before all of them are.
  const partial = await call('getTabState', { tabId: hallTab });
  const wholeSaved = partial.data.media.find((m) => m.provider === 'vimeo-showcase')?.library;
  check('a playlist is never recorded as one download just because its videos were fetched through it', !wholeSaved || wholeSaved.missing, JSON.stringify(wholeSaved));
  await ext.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, maxParallel: 2, siteRules: {} } });
  });

  // A player whose title lags behind the video it just started (009 shown under 008's name).
  if (LAG) {
    const lagPage = await browser.newPage();
    const lagAt = Date.now();
    await lagPage.goto(`${base}/lagging`, { waitUntil: 'networkidle0' });
    const lagTab = await tabOf(`${base}/lagging`);
    const lagged = await waitFor(async () => {
      const s = (await stateOf(lagTab)).media.find((m) => m.kind === 'hls');
      return s && /^009/.test(s.title || '') ? s : null;
    }, 8000);
    const lagNow = (await stateOf(lagTab)).media.find((m) => m.kind === 'hls');
    check("a player's late title update renames the stream (no more 009 listed as 008)", !!lagged, `${lagNow?.title} (${lagNow?.nameSource})`);
    await new Promise((r) => setTimeout(r, Math.max(0, lagAt + 14500 - Date.now()))); // past the 9 s switch and the 12 s re-check
    const afterSwitch = (await stateOf(lagTab)).media.find((m) => m.kind === 'hls');
    check('clicking the next lecture does not rename the one before it', /^009/.test(afterSwitch?.title || ''), `${afterSwitch?.title}`);
  }

  const errState = await call('aiFind');
  check('AI find reports a clear message when AI is off', !errState.ok && /AI is turned off/.test(errState.error), errState.error);

  // Optional: the AI flow through the user's Claude subscription (needs `npm run install-helper`).
  if (process.env.E2E_AI === 'subscription') {
    await ext.evaluate(async () => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, aiProvider: 'subscription' } });
    });
    const helper = await call('helperStatus', { force: true });
    check('local helper reachable from Chrome', helper.ok && helper.data.ok, JSON.stringify(helper.data || helper.error).slice(0, 200));
    const hidden = await browser.newPage();
    await hidden.goto(`${base}/watch/77`, { waitUntil: 'networkidle0' });
    const tab77 = await ext.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(u)).id, `${base}/watch/77`);
    const before = (await ext.evaluate((t) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: t }), tab77)).data.media.length;
    check('hidden video is NOT found by sniffing alone', before === 0, `${before} items`);
    const t0 = Date.now();
    const ai = await ext.evaluate((t) => chrome.runtime.sendMessage({ type: 'aiFind', tabId: t }), tab77);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    check('AI analysis completes', ai.ok, ai.ok ? `${secs}s, ${ai.data.via}: ${ai.data.summary.slice(0, 120)}` : ai.error);
    if (ai.ok) {
      const after = (await ext.evaluate((t) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: t }), tab77)).data.media;
      check('AI found the hidden MP4', after.some((m) => m.url.endsWith('/hidden/clip77.mp4')), after.map((m) => m.url).join(', '));
      check('AI wrote a working site recipe', !!ai.data.recipe && ai.data.recipeTest?.urls.some((u) => u.endsWith('/hidden/clip77.mp4')),
        JSON.stringify(ai.data.recipe?.rules || ai.data.recipeError).slice(0, 300));
    }
  }
} catch (e) {
  check('unexpected error', false, e.stack);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

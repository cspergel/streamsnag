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
const LONG_MP4_B = VARIANT(11, 8);
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
// The same real clips, padded past the "too small to be a video" limit, for the now-playing check.
const PLAY = LAG && { a: Buffer.concat([LAG[20], Buffer.alloc(700 * 1024)]), b: Buffer.concat([LAG[33], Buffer.alloc(900 * 1024)]) };
const SEGMENTS = MUX ? realTsSegments() :Array.from({ length: 5 }, (_, i) => Buffer.alloc(100 * 1024, i + 1)); // seg i filled with byte i+1
const SUBS_VTT = 'WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHello from the test stream\n';
const LONG_TITLE = 'An Extremely Long Video Title That Will Never Fit In The Popup Width Part 3 Of The Series (Full Episode, Directors Cut)';
// Course materials for the "Files on this page" checks: small fake documents, each with its own bytes, and
// two programs that must never be offered or fetched.
const DOCS = {
  '/files/week3-slides.pptx': Buffer.from('PK fake slides for week 3'),
  '/files/Reading list (week 3).pdf': Buffer.from('%PDF-1.4 fake reading list'),
  '/files/syllabus.pdf': Buffer.from('%PDF-1.4 fake syllabus'),
  '/files/worksheet.xlsx': Buffer.from('PK fake worksheet'),
  '/files/problem-set.docx': Buffer.from('PK fake problem set 3'),
  '/files/setup.exe': Buffer.from('MZ not a document'),
  '/files/notes.pdf.exe': Buffer.from('MZ not a document either'),
};
const docHits = []; // [path, who asked]: 'page' for the page's own <object>, 'extension' for a download
let refererRejections = 0;
let base = '';
const guardHits = []; // requests that reached the "local device" in the local-network guard check

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
  if (url.pathname === '/handouts') {
    // A lesson page with no video: slides, a "Download" link, the same PDF twice, two programs, a script link,
    // an embedded spreadsheet, and one more document inside a frame.
    return send(200, 'text/html', `<!doctype html><title>Week 3 handouts | Physics 101</title><h1>Week 3 handouts</h1>
      <ul>
        <li><a href="/files/week3-slides.pptx">  Week 3
            slides </a></li>
        <li><a href="/files/Reading%20list%20(week%203).pdf">Download</a></li>
        <li><a href="/files/syllabus.pdf">Course syllabus</a></li>
        <li><a href="/files/syllabus.pdf#page=2">Syllabus, page 2</a></li>
        <li><a href="/files/setup.exe">Lecture viewer</a></li>
        <li><a href="/files/notes.pdf.exe">Lecture notes</a></li>
        <li><a href="javascript:void('/files/secret.pdf')">Secret notes</a></li>
      </ul>
      <object data="/files/worksheet.xlsx" type="application/vnd.ms-excel" title="Worksheet" width="20" height="20"></object>
      <iframe src="/frame/handouts" width="400" height="120"></iframe>`);
  }
  if (url.pathname === '/frame/handouts') {
    return send(200, 'text/html', '<!doctype html><title>Homework</title><a href="/files/problem-set.docx">Problem set 3</a>');
  }
  if (url.pathname === '/watch/with-files') {
    // A lecture with its materials next to it: the video must look exactly as it would without them.
    return send(200, 'text/html', `<!doctype html><title>Lecture 4</title><h1>Lecture 4</h1>
      <video src="/media/long-b.mp4" preload="auto" muted></video>
      <p><a href="/files/syllabus.pdf">Course syllabus</a> · <a href="/files/problem-set.docx">Problem set 3</a></p>`);
  }
  const docFile = url.pathname.startsWith('/files/') ? DOCS[decodeURIComponent(url.pathname)] : null;
  if (docFile) {
    docHits.push([url.pathname, req.headers['sec-fetch-dest'] === 'object' ? 'page' : 'extension']);
    const type = url.pathname.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    // The slides are slow to arrive, so the downloads queued behind them can be seen waiting.
    if (url.pathname.endsWith('.pptx')) return setTimeout(() => send(200, type, docFile), 2500);
    return send(200, type, docFile);
  }
  if (url.pathname === '/guard/hit') { guardHits.push(req.headers.host); return send(200, 'text/plain', 'local'); }
  if (url.pathname === '/guard/redirect') { res.writeHead(302, { location: `http://localhost:${server.address().port}/guard/hit` }); return res.end(); }
  if (url.pathname === '/watch/two') {
    // You are watching the first video; a second one loads afterwards, so it is the newest on the page.
    return send(200, 'text/html', `<!doctype html><title>Two Players</title>
      <video id="a" src="/media/play-a.mp4" muted loop width="320" height="180"></video>
      <video id="b" muted width="320" height="180"></video>
      <script>
        document.getElementById('a').play();
        setTimeout(() => { const b = document.getElementById('b'); b.src = '/media/play-b.mp4'; b.load(); }, 900);
      </script>`);
  }
  if (PLAY && /^\/media\/play-[ab]\.mp4$/.test(url.pathname)) return send(200, 'video/mp4', PLAY[url.pathname.at(-5)]);
  if (url.pathname === '/watch/longlist') {
    // Two videos, so one of them is an ordinary row under the big card.
    return send(200, 'text/html', `<!doctype html><title>${LONG_TITLE}</title>
      <video src="/media/long.mp4" preload="auto" muted></video><video src="/media/long-b.mp4" preload="auto" muted></video>`);
  }
  if (url.pathname === '/media/long.mp4') return send(200, 'video/mp4', LONG_MP4);
  if (url.pathname === '/media/long-b.mp4') return send(200, 'video/mp4', LONG_MP4_B);
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

  // Installing opens the welcome page: three steps and a live check of the helper.
  const welcomeTarget = await browser.waitForTarget((t) => t.url() === `chrome-extension://${extId}/welcome.html`, { timeout: 8000 }).catch(() => null);
  const welcome = welcomeTarget ? await welcomeTarget.page() : null;
  check('installing opens the welcome page', !!welcome);
  if (welcome) {
    await welcome.waitForFunction(() => /Helper found|Not set up yet/.test(document.getElementById('helper').textContent), { timeout: 15000 }).catch(() => {});
    const w = await welcome.evaluate(() => ({
      steps: document.querySelectorAll('.guide > li').length,
      helper: document.getElementById('helper').textContent,
      cls: document.getElementById('helper').className,
    }));
    // Whichever way the check goes on this machine, it must end in a clear answer (not stay on "Checking…").
    check('the welcome page shows three steps and a clear helper answer',
      w.steps === 3 && ((/^Helper found/.test(w.helper) && /\bok\b/.test(w.cls)) || (/^Not set up yet/.test(w.helper) && /\bbad\b/.test(w.cls))), JSON.stringify(w));
    const opened = browser.waitForTarget((t) => t.url() === `chrome-extension://${extId}/options.html`, { timeout: 8000 }).catch(() => null);
    await welcome.click('#settings');
    check('"Open Settings" on the welcome page opens Settings', !!(await opened));
    if (process.env.SHOT) await welcome.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-welcome.png'), fullPage: true });
    await welcome.close();
  }
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
  const cards = await popup.$$eval('.items .card', (els) => els.length);
  check('popup renders detected media and jobs without errors', cards === 2 && !consoleErrors.length, `${cards} cards; ${consoleErrors.join('; ')}`);
  if (process.env.SHOT) await popup.screenshot({ path: process.env.SHOT, fullPage: true });

  // Downloaded / not-downloaded status and filters.
  const tags = await popup.$$eval('.items .card .st', (els) => els.map((e) => e.textContent));
  check('both items are marked as downloaded', tags.length === 2 && tags.every((t) => t.includes('Downloaded')), tags.join(', '));
  await popup.evaluate(() => [...document.querySelectorAll('#filters .chip')].find((c) => c.textContent.startsWith('Not downloaded')).click());
  await new Promise((r) => setTimeout(r, 200));
  const notDl = await popup.$$eval('.items .card', (els) => els.length);
  const emptyMsg = await popup.$eval('#empty', (e) => (e.hidden ? '' : e.textContent.trim()));
  check('"Not downloaded" filter hides saved items', notDl === 0 && /Everything on this page is downloaded/.test(emptyMsg), `${notDl} cards; ${emptyMsg}`);
  await popup.evaluate(() => document.querySelector('#filters .chip').click());

  // A long name on the big card wraps to two lines, and a click shows the rest.
  const longPage = await browser.newPage();
  await longPage.goto(`${base}/watch/long`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1000));
  const longTab = await ext.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/watch/long`);
  const lp = await browser.newPage();
  await lp.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
  await lp.goto(`chrome-extension://${extId}/popup.html?tabId=${longTab}`);
  await new Promise((r) => setTimeout(r, 1000));
  const heroName = await lp.$eval('#hero .card .title', (e) => ({
    overflow: e.classList.contains('overflow'), tip: e.title, h: e.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(e).lineHeight), cut: e.scrollHeight - e.clientHeight,
  }));
  check('long name on the big card is cut to two lines and has a full-name tooltip',
    heroName.overflow && heroName.tip === LONG_TITLE && heroName.cut > 2 && Math.abs(heroName.h - 2 * heroName.line) < 2,
    JSON.stringify(heroName).slice(0, 200));
  await new Promise((r) => setTimeout(r, 2500)); // survives a background refresh
  await lp.click('#hero .card .title');
  const heroOpen = await lp.$eval('#hero .card .title', (e) => ({
    x: e.classList.contains('expanded'), h: e.getBoundingClientRect().height, cut: e.scrollHeight - e.clientHeight,
    line: parseFloat(getComputedStyle(e).lineHeight),
  }));
  check('clicking the long name on the big card shows it in full',
    heroOpen.x && heroOpen.cut <= 2 && heroOpen.h >= 3 * heroOpen.line - 2, `${heroOpen.h.toFixed(0)}px tall, ${heroOpen.cut}px cut off`);
  await lp.click('#hero .card .title');
  const heroShut = await lp.$eval('#hero .card .title', (e) => ({ x: e.classList.contains('expanded'), h: e.getBoundingClientRect().height }));
  check('clicking it again folds it back to two lines', !heroShut.x && Math.abs(heroShut.h - heroName.h) < 2, `${heroShut.h.toFixed(0)}px tall`);

  // Long names in the list scroll across on hover, and expand when clicked.
  const listPage = await browser.newPage();
  await listPage.goto(`${base}/watch/longlist`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1000));
  const listTab = await ext.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/watch/longlist`);
  const rp = await browser.newPage();
  await rp.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
  await rp.goto(`chrome-extension://${extId}/popup.html?tabId=${listTab}`);
  await new Promise((r) => setTimeout(r, 1000));
  const ROW = '#media .card';
  const fit = await rp.$eval(`${ROW} .title`, (e) => ({ overflow: e.classList.contains('overflow'), tip: e.title, cut: e.firstElementChild.scrollWidth - e.clientWidth }));
  check('long name in the list is detected as overflowing and has a full-name tooltip', fit.overflow && fit.cut > 20 && fit.tip.length > 60, JSON.stringify(fit).slice(0, 160));
  await rp.hover(ROW);
  await new Promise((r) => setTimeout(r, 2600)); // past the 0.4s delay + 12% hold
  const shifted = await rp.$eval(`${ROW} .title > span`, (e) => new DOMMatrix(getComputedStyle(e).transform).m41);
  check('long name scrolls across on hover', shifted < -20, `translateX ${shifted.toFixed(0)}px`);
  if (process.env.SHOT) await rp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-hover.png') });
  await rp.$eval(`${ROW}`, (e) => { e.closest('li').dataset.mark = 'kept'; });
  await new Promise((r) => setTimeout(r, 2500)); // survives a background refresh without resetting
  const stillSame = await rp.$eval(`${ROW}`, (e) => e.closest('li').dataset.mark === 'kept');
  const stillShifted = await rp.$eval(`${ROW} .title > span`, (e) => new DOMMatrix(getComputedStyle(e).transform).m41);
  check('a background refresh does not rebuild the row or reset the scroll', stillSame && stillShifted < -20, `kept ${stillSame}, translateX ${stillShifted.toFixed(0)}px`);
  await rp.click(`${ROW} .title`);
  const h1 = await rp.$eval(`${ROW} .title`, (e) => ({ h: e.getBoundingClientRect().height, x: e.classList.contains('expanded') }));
  check('clicking a long name shows it in full', h1.x && h1.h > 30, `${h1.h.toFixed(0)}px tall`);
  await rp.close();
  await listPage.close();

  // The big card shows the video you are watching, not just the newest one found.
  if (PLAY) {
    const twoPage = await browser.newPage();
    await twoPage.goto(`${base}/watch/two`, { waitUntil: 'networkidle0' });
    const twoTab = await ext.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/watch/two`);
    const twoState = () => ext.evaluate((t) => chrome.runtime.sendMessage({ type: 'getTabState', tabId: t }), twoTab).then((r) => r.data);
    const until = async (fn, ms = 8000) => {
      for (let i = 0; i < ms / 200; i++) {
        const v = await fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    };
    const st2 = await until(async () => { const d = await twoState(); return d.media.length === 2 && d.playing ? d : null; }, 10000) || await twoState();
    const va = st2.media.find((m) => m.url.endsWith('play-a.mp4'));
    const vb = st2.media.find((m) => m.url.endsWith('play-b.mp4'));
    check('the worker knows which of two videos is playing (the older one)',
      !!va && !!vb && vb.detectedAt > va.detectedAt && st2.playing?.id === va.id && st2.playing.playing === true,
      JSON.stringify({ playing: st2.playing, a: va?.id, b: vb?.id, newer: vb?.detectedAt > va?.detectedAt }));
    const tp = await browser.newPage();
    await tp.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
    await tp.goto(`chrome-extension://${extId}/popup.html?tabId=${twoTab}`);
    // The real popup floats over the page; here it is a tab, and Chrome pauses videos in a hidden tab.
    // Put the page back in front so the video keeps playing while the popup refreshes behind it.
    await twoPage.bringToFront();
    const heroOf = () => tp.evaluate(() => ({
      key: document.querySelector('#hero > li')?.dataset.key, eyebrow: document.querySelector('#hero .eyebrow')?.textContent,
      rows: [...document.querySelectorAll('#media > li')].map((li) => li.dataset.key),
    }));
    const playingHero = await until(async () => { const x = await heroOf(); return x.eyebrow === 'Now playing' ? x : null; }) || await heroOf();
    check('the big card is the video that is playing, labelled "Now playing"; the newer one is a row',
      playingHero.key === va?.id && playingHero.eyebrow === 'Now playing' && playingHero.rows.join() === vb?.id, JSON.stringify(playingHero));
    if (process.env.SHOT) {
      await tp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-playing.png') });
      await twoPage.bringToFront();
    }
    // Pause it: it is still the one you were watching.
    await twoPage.evaluate(() => document.getElementById('a').pause());
    const pausedHero = await until(async () => { const x = await heroOf(); return x.eyebrow === 'Last played' ? x : null; }) || await heroOf();
    check('after pausing, the big card stays on that video, labelled "Last played"',
      pausedHero.key === va?.id && pausedHero.eyebrow === 'Last played', JSON.stringify(pausedHero));
    // Start the other one: the card follows.
    await twoPage.evaluate(() => document.getElementById('b').play());
    const movedHero = await until(async () => { const x = await heroOf(); return x.key === vb?.id ? x : null; }) || await heroOf();
    check('playing the other video moves the big card to it',
      movedHero.key === vb?.id && movedHero.eyebrow === 'Now playing' && movedHero.rows.join() === va?.id, JSON.stringify(movedHero));
    await tp.close();
    await twoPage.close();
  }

  // Local-network guard: StreamSnag's own requests can't reach a local address that no local page or click
  // has let through. The test site is 127.0.0.1 (let through, since its pages are local); "localhost" is
  // a different host that nothing has allowed, standing in for a router.
  {
    const port = new URL(base).port;
    const tryFetch = (u) => ext.evaluate(async (x) => {
      try { const r = await fetch(x, { cache: 'no-store' }); return `ok ${r.status} ${await r.text()}`; } catch (e) { return `blocked ${e.message}`; }
    }, u);
    const control = await tryFetch(`${base}/guard/hit`);
    check('guard control: the test site itself (a local page\'s host) is reachable', control === 'ok 200 local' && guardHits.length === 1, `${control} hits=${guardHits.length}`);
    const direct = await tryFetch(`http://localhost:${port}/guard/hit`);
    check('a local address nothing has allowed is blocked for the extension', direct.startsWith('blocked') && guardHits.length === 1, `${direct} hits=${guardHits.join()}`);
    const viaRedirect = await tryFetch(`${base}/guard/redirect`);
    check('a redirect into a local address is blocked before it gets there', viaRedirect.startsWith('blocked') && guardHits.length === 1, `${viaRedirect} hits=${guardHits.join()}`);
    const img = await ext.evaluate((x) => new Promise((done) => {
      const i = new Image();
      i.onload = () => done('loaded');
      i.onerror = () => done('blocked');
      i.src = x;
    }), `http://localhost:${port}/guard/hit?img`);
    check('a preview image from a local address is blocked in extension pages', img === 'blocked' && guardHits.length === 1, `${img} hits=${guardHits.join()}`);
  }

  // Theme: the choice in Settings wins over the system setting, and the popup follows it.
  {
    const op = await browser.newPage();
    await op.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await op.goto(`chrome-extension://${extId}/options.html`);
    await op.waitForSelector('#theme .chip.on');
    const look = (pg) => pg.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme,
      on: document.querySelector('#theme .chip.on')?.textContent || null,
    }));
    const LIGHT = 'rgb(245, 245, 245)';
    const DARK = 'rgb(21, 21, 21)';
    const sysLight = await look(op);
    check('theme starts on System and follows a light system', sysLight.on === 'System' && sysLight.bg === LIGHT, JSON.stringify(sysLight));
    await op.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    // The page hears about the system change on its next frame.
    await op.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 3000 }).catch(() => {});
    const sysDark = await look(op);
    check('on System, a dark system turns the page dark', sysDark.on === 'System' && sysDark.bg === DARK, JSON.stringify(sysDark));
    await op.click('#theme [data-theme-choice="light"]');
    const forcedLight = await look(op);
    check('choosing Light keeps the page light on a dark system', forcedLight.on === 'Light' && forcedLight.bg === LIGHT, JSON.stringify(forcedLight));
    await op.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await op.click('#theme [data-theme-choice="dark"]');
    const forcedDark = await look(op);
    check('choosing Dark turns the page dark on a light system', forcedDark.on === 'Dark' && forcedDark.bg === DARK, JSON.stringify(forcedDark));
    // The popup shares the choice: opened on a light system, it is dark, and it changes live with the setting.
    const pp = await browser.newPage();
    await pp.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await pp.goto(`chrome-extension://${extId}/popup.html`);
    const popDark = await look(pp);
    check('the popup opens dark when Dark is chosen, on a light system', popDark.bg === DARK, JSON.stringify(popDark));
    await op.bringToFront();
    await op.reload();
    await op.waitForSelector('#theme .chip.on');
    const kept = await look(op);
    check('the theme choice is remembered after reloading Settings', kept.on === 'Dark' && kept.bg === DARK, JSON.stringify(kept));
    await op.click('#theme [data-theme-choice="system"]');
    await new Promise((r) => setTimeout(r, 300));
    const popBack = await look(pp);
    const opBack = await look(op);
    check('back on System, Settings and the open popup both return to light',
      opBack.on === 'System' && opBack.bg === LIGHT && popBack.bg === LIGHT, JSON.stringify({ opBack, popBack }));
    await pp.close();
    await op.close();
  }

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
    details: document.querySelectorAll('.items .details').length,
    urls: [...document.querySelectorAll('.items .details dd.url')].map((d) => d.textContent),
    saved: [...document.querySelectorAll('.items .details dt')].filter((d) => d.textContent === 'Saved').length,
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
  const shownNames = await popCourse.$$eval('.items .card .title', (els) => els.map((e) => e.textContent));
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
    const dpTags = await dp.$$eval('.items .card .st', (els) => els.map((e) => e.textContent));
    check('a re-signed link of a downloaded video still shows as downloaded', dpTags.length === 1 && dpTags[0].includes('Downloaded'), dpTags.join(', '));
    await dp.evaluate(() => document.querySelector('.items .card .more').click());
    await dp.evaluate(() => [...document.querySelectorAll('.items .menu button')].find((b) => b.textContent === 'Remove from list').click());
    await new Promise((r) => setTimeout(r, 700));
    const afterRemove = await dp.evaluate(() => ({ cards: document.querySelectorAll('.items .card').length, note: document.querySelector('#removed').textContent }));
    await dp.evaluate(() => document.querySelector('#removed button').click());
    await new Promise((r) => setTimeout(r, 700));
    const afterUndo = await dp.$$eval('.items .card', (els) => els.length);
    check('Remove from list hides an item, and Show again brings it back', afterRemove.cards === 0 && /1 removed/.test(afterRemove.note) && afterUndo === 1,
      `${afterRemove.cards} cards, "${afterRemove.note}", ${afterUndo} after undo`);
  }

  // Files on this page: the documents a course page links to (slides, handouts), kept apart from its videos.
  {
    const SYLLABUS = `${base}/files/syllabus.pdf`;
    const hw = await browser.newPage();
    await hw.goto(`${base}/handouts`, { waitUntil: 'networkidle0' });
    const hwTab = await tabOf(`${base}/handouts`);
    const hwState = await waitFor(async () => { const s = await stateOf(hwTab); return s.docs?.length >= 5 ? s : null; }, 8000) || await stateOf(hwTab);
    const docs = hwState.docs || [];
    check('documents linked on a page (and in its frames) are listed once each, named from the link text or the file name',
      docs.map((d) => `${d.label} ${d.name}`).join(' | ') === 'PPT Week 3 slides | PDF Reading list (week 3) | PDF Course syllabus | XLS Worksheet | DOC Problem set 3',
      docs.map((d) => `${d.label} ${d.name}`).join(' | '));
    check('an .exe link and a javascript: link are never offered', docs.length > 0 && docs.every((d) => d.url.startsWith(`${base}/files/`) && /\.(pptx|pdf|xlsx|docx)$/.test(d.url)),
      docs.map((d) => d.url.replace(base, '')).join(', '));
    const hwBadge = await ext.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), hwTab);
    check('documents are not videos: nothing in the media list, nothing on the toolbar badge', hwState.media.length === 0 && hwBadge === '' && hwState.playing === null,
      `${hwState.media.length} media, badge "${hwBadge}"`);

    const dp = await browser.newPage();
    const dpErrors = [];
    dp.on('pageerror', (e) => dpErrors.push(e.message));
    dp.on('console', (m) => { if (m.type() === 'error') dpErrors.push(m.text()); });
    await dp.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
    await dp.goto(`chrome-extension://${extId}/popup.html?tabId=${hwTab}`);
    await dp.waitForFunction(() => !document.querySelector('#docs-box').hidden, { timeout: 5000 }).catch(() => {});
    const group = () => dp.evaluate(() => {
      const $ = (s) => document.querySelector(s);
      return {
        shown: !$('#docs-box').hidden, heading: $('#docs-toggle strong').textContent.replace(/\s+/g, ' ').trim(), note: $('#docs-note').textContent,
        open: $('#docs-toggle').getAttribute('aria-expanded'), listHidden: $('#docs').hidden,
        all: $('#docs-all').hidden ? '' : $('#docs-all').textContent,
        rows: [...document.querySelectorAll('#docs > li.card')].map((li) => ({
          tile: li.querySelector('.thumb').textContent, name: li.querySelector('.title').textContent, sub: li.querySelector('.sub').textContent,
          st: li.querySelector('.st')?.textContent || '', btn: li.querySelector('button.dl')?.title || '',
        })),
        empty: $('#empty').hidden ? '' : $('#empty').textContent.replace(/\s+/g, ' ').trim(),
        bigEmpty: !$('#empty').hidden && (getComputedStyle($('#empty .empty-icon')).display !== 'none' || !$('#empty-actions').hidden),
        videoCards: document.querySelectorAll('#hero > li, #media > li').length, filters: !$('#filters').hidden,
      };
    });
    const shut = await group();
    check('a page with only documents shows the collapsed "Files on this page" group, with "Download all"',
      shut.shown && shut.heading === 'Files on this page 5' && shut.open === 'false' && shut.listHidden && shut.rows.length === 0 && shut.all === 'Download all'
      && shut.videoCards === 0 && !dpErrors.length, JSON.stringify({ ...shut, errors: dpErrors }));
    check('…and not the "nothing found" screen', !/No media found/.test(shut.empty) && !shut.bigEmpty && /^No videos found yet\./.test(shut.empty), shut.empty);
    await dp.click('#docs-toggle');
    const opened = await group();
    check('opening the group lists each file with its type, name, site and a download button',
      opened.open === 'true' && !opened.listHidden && opened.rows.map((r) => `${r.tile} ${r.name}`).join(' | ') === 'PPT Week 3 slides | PDF Reading list (week 3) | PDF Course syllabus | XLS Worksheet | DOC Problem set 3'
      && opened.rows.every((r) => r.sub === '127.0.0.1' && r.btn === 'Download' && !r.st), JSON.stringify(opened.rows));

    // One file: saved as "<name>.<type>" where this site's videos go (the custom folder, under Vids/<site>/).
    const clickRow = (name) => dp.evaluate((n) => [...document.querySelectorAll('#docs > li.card')].find((li) => li.querySelector('.title').textContent === n).querySelector('button.dl').click(), name);
    await clickRow('Course syllabus');
    const docJobs = async () => (await stateOf(hwTab)).jobs.filter((j) => j.kind === 'doc');
    const sylJob = await waitFor(async () => (await docJobs()).find((j) => j.mediaUrl === SYLLABUS && j.status === 'done'), 10000);
    const docDir = path.join(custom, 'Vids', '127.0.0.1');
    const sylPath = sylJob?.outputs?.[0]?.path || '';
    check('downloading one saves it as "<name>.pdf" in the same folder as this site\'s videos',
      sylPath === path.join(docDir, 'Course syllabus.pdf') && fs.existsSync(sylPath) && fs.readFileSync(sylPath).equals(DOCS['/files/syllabus.pdf']),
      sylPath || JSON.stringify((await docJobs()).map((j) => [j.status, j.error, j.filename])));
    const ticked = await waitFor(async () => { const g = await group(); return g.rows.some((r) => r.st === 'Downloaded') ? g : null; }, 5000) || await group();
    check('that file is ticked as downloaded, and only that one',
      ticked.rows.filter((r) => r.st === 'Downloaded').map((r) => r.name).join() === 'Course syllabus' && ticked.rows.filter((r) => r.st).length === 1
      && ticked.note === '1 of 5 downloaded' && ticked.all === 'Download all' && ticked.rows.find((r) => r.name === 'Course syllabus').btn === 'Download again',
      JSON.stringify({ note: ticked.note, all: ticked.all, rows: ticked.rows.map((r) => [r.name, r.st, r.btn]) }));
    if (process.env.SHOT) {
      await dp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-files.png'), fullPage: true });
      await dp.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await new Promise((r) => setTimeout(r, 300));
      await dp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-files-dark.png'), fullPage: true });
      await dp.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    }

    // The rest in one click, through the queue: one at a time here, and the slides are slow to arrive.
    const before = await ext.evaluate(async () => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, maxParallel: 1 } });
      return settings;
    });
    await dp.click('#docs-all');
    const rest = await waitFor(async () => { const js = (await docJobs()).filter((j) => j.mediaUrl !== SYLLABUS); return js.length === 4 ? js : null; }, 2000) || [];
    check('"Download all" queues the files not yet downloaded (one running, three waiting)',
      rest.length === 4 && rest.filter((j) => j.status === 'running').map((j) => j.title).join() === 'Week 3 slides' && rest.filter((j) => j.status === 'queued').length === 3
      && (await docJobs()).filter((j) => j.mediaUrl === SYLLABUS).length === 1, JSON.stringify(rest.map((j) => [j.title, j.status])));
    const allDocs = await waitFor(async () => { const js = await docJobs(); return js.length === 5 && js.every((j) => j.status === 'done') ? js : null; }, 20000);
    await ext.evaluate((s) => chrome.storage.local.set({ settings: s }), before);
    const savedDocs = fs.existsSync(docDir) ? fs.readdirSync(docDir).filter((f) => !/\.(mp4|crdownload)$/.test(f)).sort() : [];
    const want = {
      'Course syllabus.pdf': '/files/syllabus.pdf', 'Problem set 3.docx': '/files/problem-set.docx', 'Reading list (week 3).pdf': '/files/Reading list (week 3).pdf',
      'Week 3 slides.pptx': '/files/week3-slides.pptx', 'Worksheet.xlsx': '/files/worksheet.xlsx',
    };
    check('every file is saved once, under its own name and type, with the right contents',
      !!allDocs && savedDocs.join('|') === Object.keys(want).sort().join('|') && savedDocs.every((f) => fs.readFileSync(path.join(docDir, f)).equals(DOCS[want[f]])),
      `${savedDocs.join(' | ')}; ${allDocs ? 'done' : JSON.stringify((await docJobs()).map((j) => [j.title, j.status, j.error]))}`);
    const fetched = docHits.filter(([, who]) => who === 'extension').map(([p]) => decodeURIComponent(p)).sort();
    check('each document was fetched exactly once, and the programs never', fetched.join('|') === Object.values(want).sort().join('|') && !docHits.some(([p]) => /exe/.test(p)),
      docHits.map(([p, who]) => `${who}:${p}`).join(', '));
    const finished = await waitFor(async () => { const g = await group(); return g.rows.length === 5 && g.rows.every((r) => r.st === 'Downloaded') ? g : null; }, 6000) || await group();
    check('afterwards every row is ticked and "Download all" is gone', finished.rows.length === 5 && finished.rows.every((r) => r.st === 'Downloaded')
      && finished.all === '' && finished.note === '5 of 5 downloaded' && !dpErrors.length, JSON.stringify({ note: finished.note, all: finished.all, rows: finished.rows.map((r) => r.st), errors: dpErrors }));

    // The list follows the page: a link added later shows up without a reload, and a frame that is closed takes its file along.
    await hw.evaluate(() => {
      document.querySelector('iframe').remove();
      document.body.insertAdjacentHTML('beforeend', '<p><a href="/files/late-notes.rtf" title="Late notes">here</a> <a href="/files/tool.msi">Tool</a></p>');
    });
    const follows = await waitFor(async () => {
      const names = (await stateOf(hwTab)).docs.map((d) => `${d.label} ${d.name}`);
      return names.includes('RTF Late notes') && !names.includes('DOC Problem set 3') ? names : null;
    }, 10000);
    check('a document linked later appears without reloading, and a closed frame\'s document goes', follows?.length === 5 && !follows.some((n) => /tool/i.test(n)),
      (follows || (await stateOf(hwTab)).docs.map((d) => `${d.label} ${d.name}`)).join(' | '));

    // Next to a video, the documents change nothing about it; ones saved from another page are already ticked.
    const wf = await browser.newPage();
    await wf.goto(`${base}/watch/with-files`, { waitUntil: 'networkidle0' });
    const wfTab = await tabOf(`${base}/watch/with-files`);
    const wfState = await waitFor(async () => { const s = await stateOf(wfTab); return s.media.length && s.docs?.length === 2 ? s : null; }, 8000) || await stateOf(wfTab);
    const wfBadge = await ext.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), wfTab);
    await dp.goto(`chrome-extension://${extId}/popup.html?tabId=${wfTab}`);
    await dp.waitForFunction(() => !document.querySelector('#docs-box').hidden && document.querySelector('#hero > li'), { timeout: 5000 }).catch(() => {});
    const beside = await group();
    const besideHero = await dp.evaluate(() => ({ eyebrow: document.querySelector('#hero .eyebrow')?.textContent, count: document.querySelector('#media-count').textContent }));
    if (process.env.SHOT) await dp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-files-video.png'), fullPage: true });
    check('a video with documents next to it looks as it does without them (badge 1, one big card, no filters)',
      wfState.media.length === 1 && wfState.media[0].kind === 'direct' && wfBadge === '1' && beside.videoCards === 1 && !beside.filters
      && besideHero.eyebrow === 'Latest video' && besideHero.count === '1' && beside.empty === '',
      JSON.stringify({ media: wfState.media.map((m) => m.kind), badge: wfBadge, cards: beside.videoCards, filters: beside.filters, ...besideHero, empty: beside.empty }));
    check('the same documents linked from another page are already ticked as downloaded', beside.shown && beside.heading === 'Files on this page 2'
      && beside.note === '2 of 2 downloaded' && beside.all === '' && beside.rows.map((r) => `${r.name}: ${r.st}`).join(', ') === 'Course syllabus: Downloaded, Problem set 3: Downloaded',
    JSON.stringify({ heading: beside.heading, note: beside.note, all: beside.all, rows: beside.rows.map((r) => [r.name, r.st]) }));

    // The setting (Settings → Downloads) turns the whole group off, and back on.
    const so = await browser.newPage();
    await so.goto(`chrome-extension://${extId}/options.html#downloads`);
    await so.waitForFunction(() => document.getElementById('subfolder').value === 'Vids/{site}', { timeout: 5000 }).catch(() => {});
    const box = await so.evaluate(() => { const el = document.getElementById('showDocuments'); return { on: el.checked, label: el.closest('label').textContent.trim(), visible: el.getBoundingClientRect().height > 0 }; });
    await so.click('#showDocuments');
    const stored = () => ext.evaluate(async () => (await chrome.storage.local.get('settings')).settings || {});
    const off = await waitFor(async () => { const s = await stored(); return s.showDocuments === false ? s : null; }, 3000);
    const offState = await stateOf(wfTab);
    await dp.waitForFunction(() => document.querySelector('#docs-box').hidden, { timeout: 5000 }).catch(() => {});
    const offGroup = await group();
    check('Settings has "Show documents linked on the page", on by default; turning it off hides the group',
      box.on && box.visible && box.label === 'Show documents linked on the page (PDF, slides, …)' && !!off && off.saveFolder === custom
      && offState.docs.length === 0 && offState.media.length === 1 && !offGroup.shown && offGroup.videoCards === 1,
      JSON.stringify({ box, saved: off?.showDocuments, docs: offState.docs.length, shown: offGroup.shown }));
    await so.click('#showDocuments');
    const on = await waitFor(async () => { const s = await stored(); return s.showDocuments === true ? s : null; }, 3000);
    check('…and turning it back on brings the files back', !!on && (await stateOf(wfTab)).docs.length === 2, `saved ${on?.showDocuments}`);
    await so.close();
    await dp.close();
    await wf.close();
    await hw.close();
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
  const lpInfo = await lp2.evaluate(() => ({ tag: document.querySelector('.items .card .st')?.textContent, lib: document.querySelector('#library')?.textContent }));
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
  await hp.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
  await hp.goto(`chrome-extension://${extId}/popup.html?tabId=${hallTab}`);
  await new Promise((r) => setTimeout(r, 900));
  if (process.env.SHOT) {
    // The README picture, in light and dark.
    await hp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-readme.png') });
    await hp.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await new Promise((r) => setTimeout(r, 300));
    await hp.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-dark.png') });
    await hp.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  }
  const btn = await hp.evaluate(() => [...document.querySelectorAll('.items .card')].map((c) => c.querySelector('.primary')?.textContent));
  check('the showcase card offers "List videos" (Download all is in its menu)', btn.includes('List videos'), btn.join(', '));
  // Organising the list: subtitle files tucked away, search, sort/group.
  const org = await hp.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cards = () => [...document.querySelectorAll('#hero > li.card, #media > li.card')].map((c) => c.querySelector('.title')?.textContent.trim());
    const out = {
      subInMain: [...document.querySelectorAll('.items .thumb.subtitle')].length,
      subsBox: !document.querySelector('#subs-box').hidden, subsCount: document.querySelector('#subs-count').textContent,
      subsListHidden: document.querySelector('#subs').hidden, all: cards().length,
    };
    document.querySelector('#subs-toggle').click();
    await wait(50);
    out.subsOpen = document.querySelectorAll('#subs > li.card').length;
    if (document.querySelector('#listbar').hidden) document.querySelector('#btn-search').click();
    await wait(50);
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
  const missingBtn = await plp.evaluate(() => [...document.querySelectorAll('.items .card .primary')].map((b) => b.textContent).find((t) => /missing/i.test(t)) || '');
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
    const c = [...document.querySelectorAll('.items .card')].find((x) => /playlist ·/.test(x.textContent));
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

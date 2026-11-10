#!/usr/bin/env node
// StreamSnag local helper (Chrome native messaging host).
// Chrome starts this on demand. It can:
//   ping   -> report which tools are installed (claude, ffmpeg, yt-dlp)
//   claude -> run a prompt through the Claude Code CLI on the user's Claude subscription
//   mux    -> merge video + audio / convert .ts to .mp4 with ffmpeg (stream copy, no re-encode)
//   ytdlp  -> download a page with yt-dlp, streaming progress back
// stdout is reserved for protocol frames; diagnostics go to a log file in the temp directory.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMessage, createDecoder } from './protocol.js';

export const VERSION = '1.4.0';
const IS_WIN = process.platform === 'win32';
const LOG = path.join(os.tmpdir(), 'streamsnag-helper.log');

function log(...args) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  } catch { /* ignore */ }
}

function reply(msg) {
  process.stdout.write(encodeMessage(msg));
}

// ------------------------------------------------------------------ tool discovery

const toolCache = new Map();

function whereTool(name, env) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // On Windows prefer real executables/shims over extension-less npm stubs.
    return (IS_WIN ? lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) : lines[0]) || lines[0] || null;
  } catch {
    return null;
  }
}

/** The PATH as currently saved in the registry (Chrome keeps the PATH it was started with). */
function freshWindowsPath() {
  const read = (key) => {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(out);
      return m ? m[1].trim().replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all) : '';
    } catch {
      return '';
    }
  };
  return [read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), read('HKCU\\Environment')].filter(Boolean).join(';');
}

/** winget installs portable packages under %LOCALAPPDATA%\Microsoft\WinGet\{Links,Packages}. */
function wingetTool(name) {
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet');
  const exe = `${name}.exe`;
  const link = path.join(base, 'Links', exe);
  if (fs.existsSync(link)) return link;
  const pkgs = path.join(base, 'Packages');
  let dirs = [];
  try { dirs = fs.readdirSync(pkgs); } catch { return null; }
  // Prefer the package named after the tool (Gyan.FFmpeg, yt-dlp.yt-dlp), then anything else.
  dirs.sort((a, b) => Number(!a.toLowerCase().includes(name)) - Number(!b.toLowerCase().includes(name)));
  for (const d of dirs) {
    for (const rel of [exe, path.join('bin', exe)]) {
      const p = path.join(pkgs, d, rel);
      if (fs.existsSync(p)) return p;
    }
    let subs = [];
    try { subs = fs.readdirSync(path.join(pkgs, d)); } catch { continue; }
    for (const s of subs) {
      const p = path.join(pkgs, d, s, 'bin', exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function findTool(name) {
  if (toolCache.has(name)) return toolCache.get(name);
  let found = whereTool(name);
  if (!found && IS_WIN) {
    const fresh = freshWindowsPath();
    if (fresh) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
      found = whereTool(name, { ...env, Path: fresh });
    }
    if (!found) found = wingetTool(name);
  }
  toolCache.set(name, found);
  return found;
}

function tools() {
  return { claude: findTool('claude'), ffmpeg: findTool('ffmpeg'), ytdlp: findTool('yt-dlp') };
}

// ------------------------------------------------------------------ process helper

function childEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE; // let the CLI run normally even if Chrome was started from a Claude Code shell
  return env;
}

/**
 * Build a cmd.exe command line for a .cmd/.bat shim. Each argument is double-quoted (so empty
 * strings and paths with spaces survive); anything cmd could interpret is rejected outright.
 */
export function cmdShimCommandLine(cmd, args) {
  const unsafe = /["%^&|<>!\r\n]/;
  for (const a of [cmd, ...args]) {
    if (unsafe.test(a)) throw new Error('Unsafe argument for shell execution');
  }
  return `"${[cmd, ...args].map((a) => `"${a}"`).join(' ')}"`;
}

function run(cmd, args, { input, onLine, timeoutMs = 10 * 60 * 1000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const isShim = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
    let child;
    try {
      child = isShim
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdShimCommandLine(cmd, args)], {
          cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(),
        })
        : spawn(cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(cmd)} timed out`));
    }, timeoutMs);
    const onData = (d, isErr) => {
      const s = d.toString('utf8');
      if (isErr) stderr += s;
      else stdout += s;
      if (onLine) {
        lineBuf += s;
        const parts = lineBuf.split(/\r?\n|\r/);
        lineBuf = parts.pop();
        parts.filter(Boolean).forEach((l) => onLine(l, isErr));
      }
    };
    child.stdout.on('data', (d) => onData(d, false));
    child.stderr.on('data', (d) => onData(d, true));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (lineBuf && onLine) onLine(lineBuf, false);
      resolve({ code, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// ------------------------------------------------------------------ handlers

async function handleClaude(msg) {
  const claude = findTool('claude');
  if (!claude) throw new Error('Claude Code CLI not found. Install it with "npm i -g @anthropic-ai/claude-code" and run "claude" once to sign in.');
  if (typeof msg.prompt !== 'string' || !msg.prompt) throw new Error('Missing prompt');
  const cwd = path.join(os.tmpdir(), 'streamsnag-claude');
  fs.mkdirSync(cwd, { recursive: true });
  // Our own short system prompt + no tools + no user settings/plugins/MCP: ~1k tokens of overhead
  // per call instead of ~24k, and nothing from the user's Claude Code setup leaks into the JSON.
  const systemFile = path.join(cwd, `system-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(systemFile, String(msg.system || 'You are a JSON-only engine inside a browser extension. Output only valid JSON.'));
  const args = [
    '-p', '--output-format', 'json', '--no-session-persistence',
    '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands',
    '--tools', '', '--system-prompt-file', systemFile,
  ];
  if (msg.model) {
    if (!/^[a-z0-9.\-[\]]+$/i.test(msg.model)) throw new Error('Invalid model name');
    args.push('--model', msg.model);
  }
  let res;
  try {
    res = await run(claude, args, { input: msg.prompt, timeoutMs: 230000, cwd });
  } finally {
    fs.rmSync(systemFile, { force: true });
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout.trim().split(/\r?\n/).filter(Boolean).pop());
  } catch {
    throw new Error(`Claude CLI returned unexpected output: ${(res.stderr || res.stdout).slice(0, 400)}`);
  }
  if (parsed.is_error) throw new Error(`Claude CLI error: ${String(parsed.result || parsed.error || 'unknown').slice(0, 400)}`);
  return { text: parsed.result, usage: parsed.usage || null, costUsd: parsed.total_cost_usd ?? null };
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; i < 1000; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
  throw new Error('Could not find a free output file name');
}

export function safeOutputName(name) {
  const base = path.basename(String(name || 'output.mp4'));
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim();
  if (!/\.(mp4|mkv|m4a|mov)$/i.test(cleaned)) throw new Error('Output must be .mp4, .mkv, .m4a or .mov');
  return cleaned;
}

/** ISO 639-1 → 639-2/T for the languages players most often label; MP4 needs 3-letter codes. */
const LANG3 = {
  en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'zho',
  ar: 'ara', hi: 'hin', nl: 'nld', sv: 'swe', no: 'nor', nb: 'nob', da: 'dan', fi: 'fin', pl: 'pol', tr: 'tur',
  el: 'ell', he: 'heb', cs: 'ces', hu: 'hun', ro: 'ron', uk: 'ukr', vi: 'vie', th: 'tha', id: 'ind', ms: 'msa',
};
export function lang3(lang) {
  const l = String(lang || '').toLowerCase().split(/[-_]/)[0];
  if (/^[a-z]{3}$/.test(l)) return l;
  return LANG3[l] || 'und';
}

/**
 * ffmpeg arguments for a stream-copy merge: every video/audio stream from the A/V inputs, plus
 * subtitle files embedded as soft subtitles (mov_text in MP4, SRT in MKV). Nothing is re-encoded.
 */
export function buildMuxArgs({ inputs, subtitles = [], output }) {
  const isMp4 = /\.(mp4|m4a|mov)$/i.test(output);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  inputs.forEach((p) => args.push('-i', p));
  subtitles.forEach((s) => args.push('-i', s.path));
  // Only A/V streams: .ts files often carry ID3/data streams that MP4 cannot hold.
  inputs.forEach((_, i) => args.push('-map', `${i}:v?`, '-map', `${i}:a?`));
  subtitles.forEach((_, j) => args.push('-map', `${inputs.length + j}:s?`));
  args.push('-c', 'copy');
  if (subtitles.length) {
    args.push('-c:s', isMp4 ? 'mov_text' : 'srt');
    subtitles.forEach((s, j) => args.push(`-metadata:s:s:${j}`, `language=${lang3(s.lang)}`));
  }
  if (inputs.some((p) => /\.(ts|aac)$/i.test(p))) args.push('-bsf:a', 'aac_adtstoasc');
  if (isMp4) args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}

function checkInput(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) throw new Error(`Input not found: ${p}`);
}

async function handleMux(msg) {
  const ffmpeg = findTool('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg not found');
  const inputs = Array.isArray(msg.inputs) ? msg.inputs : [];
  if (!inputs.length || inputs.length > 4) throw new Error('Expected 1-4 input files');
  inputs.forEach(checkInput);
  const subtitles = (Array.isArray(msg.subtitles) ? msg.subtitles : []).slice(0, 8)
    .filter((s) => /\.(vtt|srt)$/i.test(s?.path || ''));
  subtitles.forEach((s) => checkInput(s.path));
  const output = uniquePath(path.join(path.dirname(inputs[0]), safeOutputName(msg.outputName)));
  let res = await run(ffmpeg, buildMuxArgs({ inputs, subtitles, output }), { timeoutMs: 60 * 60 * 1000 });
  let subsEmbedded = subtitles.length > 0;
  if (res.code !== 0 && subtitles.length) {
    // A malformed subtitle file should never cost the user the merged video: retry without them.
    try { fs.unlinkSync(output); } catch { /* ignore */ }
    log('mux with subtitles failed, retrying without', res.stderr.slice(-300));
    res = await run(ffmpeg, buildMuxArgs({ inputs, output }), { timeoutMs: 60 * 60 * 1000 });
    subsEmbedded = false;
  }
  if (res.code !== 0) {
    try { fs.unlinkSync(output); } catch { /* ignore */ }
    throw new Error(`ffmpeg failed: ${res.stderr.trim().slice(-500)}`);
  }
  if (msg.deleteInputs) {
    const del = [...inputs, ...(subsEmbedded && msg.deleteSubtitles ? subtitles.map((s) => s.path) : [])];
    for (const p of del) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
  return { output, subsEmbedded };
}

export function parseYtdlpProgress(line) {
  const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  return m ? Number(m[1]) : null;
}

async function handleYtdlp(msg) {
  const ytdlp = findTool('yt-dlp');
  if (!ytdlp) throw new Error('yt-dlp not found on PATH');
  if (!/^https?:\/\//i.test(msg.url || '')) throw new Error('Invalid URL');
  const baseDir = msg.dir ? safeFolder(msg.dir) : path.join(os.homedir(), 'Downloads');
  const outDir = joinInside(baseDir, msg.subfolder);
  fs.mkdirSync(outDir, { recursive: true });
  // Some items of a playlist (e.g. the lectures of a showcase you don't have yet), named by the extension.
  const items = msg.items == null ? '' : String(msg.items);
  if (items && !/^\d{1,4}(,\d{1,4}){0,499}$/.test(items)) throw new Error('Invalid playlist items');
  const name = msg.name ? ytdlpSafeName(msg.name) : '';
  // A whole playlist gets its own folder, files numbered in playlist order.
  const template = name
    ? path.join(outDir, `${name}.%(ext)s`)
    : msg.playlist === true
      ? path.join(outDir, '%(playlist_title,playlist_id|Playlist).80B', '%(playlist_index)03d - %(title).140B [%(id)s].%(ext)s')
      : path.join(outDir, '%(title).150B [%(id)s].%(ext)s');
  const args = [
    msg.url, msg.playlist === true || items ? '--yes-playlist' : '--no-playlist', '--newline', '--progress', '--print', 'after_move:filepath',
    '-o', template,
  ];
  if (items) args.push('--playlist-items', items);
  // Tests: pretend to download (no network), writing a small file under the requested name.
  if (process.env.STREAMSNAG_FAKE_YTDLP === '1') {
    for (const percent of [30, 80]) {
      reply({ id: msg.id, type: 'progress', percent, line: `fake yt-dlp ${percent}%` });
      await new Promise((r) => setTimeout(r, 600));
    }
    const out = uniquePath(path.join(outDir, `${(name || 'video').replace(/%%/g, '%')}.mp4`));
    fs.writeFileSync(out, Buffer.alloc(300 * 1024 + out.length, 9));
    return { files: [out], warning: '' };
  }
  if (msg.playlist === true && !items) args.push('--ignore-errors'); // one private/removed video shouldn't stop the rest
  if (/^https?:\/\//i.test(msg.referer || '')) args.push('--referer', msg.referer);
  const ffmpeg = findTool('ffmpeg');
  // Pass ffmpeg explicitly: yt-dlp only searches PATH, which may predate the install.
  if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg), '--merge-output-format', 'mp4', '--embed-subs');
  const files = [];
  let playlistPos = null;
  const res = await run(ytdlp, args, {
    timeoutMs: 6 * 60 * 60 * 1000,
    onLine: (line) => {
      // Playlists: "[download] Downloading item 3 of 12" → overall progress across all items.
      const item = /Downloading (?:item|video) (\d+) of (\d+)/i.exec(line);
      if (item) {
        playlistPos = { i: Number(item[1]), n: Number(item[2]) };
        reply({ id: msg.id, type: 'progress', line: `Video ${item[1]} of ${item[2]}` });
        return;
      }
      const pct = parseYtdlpProgress(line);
      if (pct != null) {
        const overall = playlistPos ? ((playlistPos.i - 1) + pct / 100) / playlistPos.n * 100 : pct;
        reply({ id: msg.id, type: 'progress', percent: overall, line: playlistPos ? `Video ${playlistPos.i} of ${playlistPos.n} · ${pct.toFixed(0)}%` : line });
      } else if (path.isAbsolute(line.trim()) && fs.existsSync(line.trim())) files.push(line.trim());
      else reply({ id: msg.id, type: 'progress', line });
    },
  });
  const tail = res.stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500);
  // With --ignore-errors a playlist can partly succeed: keep what was saved and say what failed.
  if (res.code !== 0 && !(msg.playlist === true && files.length)) throw new Error(`yt-dlp failed: ${tail}`);
  return { files, warning: res.code !== 0 ? tail : '' };
}

/** A file name for a yt-dlp output template: no folders, no characters Windows refuses, "%" escaped. */
export function ytdlpSafeName(name) {
  const cleaned = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 150);
  if (!cleaned) throw new Error('Empty file name');
  return cleaned.replace(/%/g, '%%');
}

/** yt-dlp's --flat-playlist -J output → the playlist's title and its videos, in order. */
export function parseFlatPlaylist(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const raw = Array.isArray(data?.entries) ? data.entries : [];
  const entries = raw.filter((e) => e && (e.url || e.webpage_url || e.id)).slice(0, 1000).map((e, i) => {
    let url = e.url || e.webpage_url || '';
    if (!/^https?:\/\//i.test(url) && /vimeo/i.test(e.ie_key || data.extractor || '') && /^\d+$/.test(String(e.id))) url = `https://vimeo.com/${e.id}`;
    if (!/^https?:\/\//i.test(url) && /youtube/i.test(e.ie_key || data.extractor || '') && e.id) url = `https://www.youtube.com/watch?v=${e.id}`;
    return {
      index: Number(e.playlist_index) || i + 1,
      id: String(e.id || ''),
      title: String(e.title || '').slice(0, 300),
      url,
      duration: Number(e.duration) > 0 ? Number(e.duration) : 0,
    };
  }).filter((e) => /^https?:\/\//i.test(e.url));
  return { title: String(data?.title || '').slice(0, 300), playlistId: String(data?.id || ''), entries }; // not "id": that is the reply's request id
}

/** List a playlist's videos without downloading anything. */
async function handleYtdlpList(msg) {
  if (!/^https?:\/\//i.test(msg.url || '')) throw new Error('Invalid URL');
  // Tests point this at a saved listing instead of the network.
  if (process.env.STREAMSNAG_TEST_PLAYLIST) return parseFlatPlaylist(fs.readFileSync(process.env.STREAMSNAG_TEST_PLAYLIST, 'utf8'));
  const ytdlp = findTool('yt-dlp');
  if (!ytdlp) throw new Error('yt-dlp not found on PATH');
  const args = [msg.url, '--flat-playlist', '-J', '--no-warnings', '--yes-playlist'];
  if (/^https?:\/\//i.test(msg.referer || '')) args.push('--referer', msg.referer);
  const res = await run(ytdlp, args, { timeoutMs: 3 * 60 * 1000 });
  if (res.code !== 0) throw new Error(`yt-dlp could not list it: ${res.stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 400)}`);
  return parseFlatPlaylist(res.stdout);
}

/** Versions of the tools the helper uses (Settings → Local helper). */
async function handleToolVersions() {
  const first = async (tool, args) => {
    const p = findTool(tool);
    if (!p) return '';
    try {
      const r = await run(p, args, { timeoutMs: 15000 });
      return (r.stdout || r.stderr).trim().split(/\r?\n/)[0].slice(0, 120);
    } catch {
      return '?';
    }
  };
  const [ytdlp, ffmpeg, claude] = await Promise.all([first('yt-dlp', ['--version']), first('ffmpeg', ['-version']), first('claude', ['--version'])]);
  return { helper: VERSION, node: process.version, ytdlp, ffmpeg: ffmpeg.replace(/^ffmpeg version\s+/i, '').split(' ')[0], claude };
}

/** Sites change often and an old yt-dlp stops working: update it in place. */
async function handleUpdateYtdlp() {
  const ytdlp = findTool('yt-dlp');
  if (!ytdlp) throw new Error('yt-dlp not found on PATH');
  const res = await run(ytdlp, ['-U'], { timeoutMs: 5 * 60 * 1000 });
  const out = `${res.stdout}\n${res.stderr}`.trim();
  const last = out.split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 400);
  if (res.code !== 0) {
    const hint = /pip/i.test(out) ? 'It was installed with pip: run "pip install -U yt-dlp".'
      : /winget|package manager|not supported/i.test(out) ? 'Update it with your package manager, e.g. "winget upgrade yt-dlp.yt-dlp".' : '';
    throw new Error(`${last}${hint ? ` ${hint}` : ''}`);
  }
  toolCache.delete('yt-dlp');
  return { output: last, upToDate: /up to date/i.test(out) };
}

// ------------------------------------------------------------------ custom save folder

/** Validate a user-chosen absolute folder. Relative paths, UNC device paths and odd characters are refused. */
export function safeFolder(p) {
  const s = String(p || '').trim();
  if (!s || !path.isAbsolute(s)) throw new Error('Choose a full folder path, e.g. D:\\Videos');
  if (/["<>|?*\r\n\u0000]/.test(s) || /^\\\\[?.]\\/.test(s)) throw new Error('That folder path has characters Windows does not allow');
  return path.resolve(s);
}

/** Join a relative subfolder (already sanitized by the extension) without ever leaving `base`. */
export function joinInside(base, sub) {
  const segs = String(sub || '').split(/[\\/]+/)
    .map((x) => x.replace(/[<>:"|?*\u0000-\u001f]+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, ''))
    .filter(Boolean);
  const out = path.resolve(base, ...segs);
  const rel = path.relative(base, out);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Subfolder escapes the save folder');
  return out;
}

function moveFile(src, destDir) {
  const target = uniquePath(path.join(destDir, path.basename(src)));
  try {
    fs.renameSync(src, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, target); // different drive: copy, then remove the original
    fs.unlinkSync(src);
  }
  return target;
}

async function handleMove(msg) {
  const dir = joinInside(safeFolder(msg.dest), msg.subfolder);
  fs.mkdirSync(dir, { recursive: true });
  const files = (Array.isArray(msg.files) ? msg.files : []).slice(0, 12);
  const moved = files.map((f) => {
    if (typeof f !== 'string' || !path.isAbsolute(f) || !fs.statSync(f, { throwIfNoEntry: false })?.isFile()) return null;
    if (path.dirname(path.resolve(f)).toLowerCase() === dir.toLowerCase()) return f;
    return moveFile(f, dir);
  });
  return { dir, moved };
}

async function handleCheckFolder(msg) {
  const dir = safeFolder(msg.path);
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.streamsnag-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  return { path: dir, writable: true };
}

/** Native "choose folder" dialog (Windows), kept on top of Chrome. */
async function handlePickFolder(msg) {
  if (!IS_WIN) throw new Error('Folder picker is only available on Windows; type the path instead.');
  const start = msg.start && !/['\r\n]/.test(msg.start) ? String(msg.start) : '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Choose where StreamSnag saves videos'",
    '$d.ShowNewFolderButton = $true',
    start ? `$d.SelectedPath = '${start}'` : '',
    "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.SelectedPath }",
  ].filter(Boolean).join('; ');
  const res = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], { timeoutMs: 10 * 60 * 1000 });
  const picked = res.stdout.trim().split(/\r?\n/).pop() || '';
  return { path: picked ? safeFolder(picked) : '' };
}

// ------------------------------------------------------------------ library scan (what's already downloaded)

const MEDIA_EXT = /\.(mp4|m4v|mkv|webm|mov|ts|avi|flv|wmv|m4a|mp3|aac|flac|wav|ogg|opus)$/i;
const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'StreamSnag');
const DURATION_CACHE = path.join(DATA_DIR, 'durations.json');

/** Walk folders for media files (bounded: depth, count, no hidden/system folders). */
export function listMediaFiles(dirs, { maxDepth = 6, maxFiles = 20000 } = {}) {
  const out = new Map();
  const walk = (dir, depth) => {
    if (out.size >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.size >= maxFiles) return;
      if (e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && MEDIA_EXT.test(e.name) && !out.has(p.toLowerCase())) {
        try {
          const st = fs.statSync(p);
          if (st.size > 0) out.set(p.toLowerCase(), { path: p, name: e.name, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch { /* vanished */ }
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  return [...out.values()];
}

function loadDurationCache() {
  try { return JSON.parse(fs.readFileSync(DURATION_CACHE, 'utf8')); } catch { return {}; }
}

function ffprobeDuration(ffprobe, file) {
  return run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 20000 })
    .then((r) => Number(r.stdout.trim()) || 0)
    .catch(() => 0);
}

async function handleScanFolder(msg) {
  const dirs = [...new Set([
    ...(Array.isArray(msg.dirs) ? msg.dirs : []).map((d) => { try { return safeFolder(d); } catch { return null; } }),
    msg.includeDownloads ? path.join(os.homedir(), 'Downloads') : null,
  ].filter((d) => d && fs.existsSync(d)))]
    // Walking a folder already covers its subfolders.
    .sort((a, b) => a.length - b.length)
    .filter((d, i, all) => !all.slice(0, i).some((p) => d.toLowerCase().startsWith(`${p.toLowerCase().replace(/[\\/]$/, '')}${path.sep}`)));
  const files = listMediaFiles(dirs);
  // Lengths (for streams, whose saved size can't be known in advance). Cached by size + modified time,
  // which a rename doesn't change, so each file is only measured once.
  const ffmpeg = findTool('ffmpeg');
  const ffprobe = findTool('ffprobe') || (ffmpeg && path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe')));
  const cache = loadDurationCache();
  let pending = 0;
  if (msg.durations && ffprobe && fs.existsSync(ffprobe)) {
    const todo = files.filter((f) => cache[`${f.size}:${f.mtimeMs}`] == null && /\.(mp4|m4v|mkv|webm|mov|ts|m4a|mp3)$/i.test(f.name));
    const batch = todo.slice(0, Math.max(0, Math.min(Number(msg.maxProbe) || 150, 400)));
    pending = todo.length - batch.length;
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < batch.length) {
        const f = batch[i++];
        cache[`${f.size}:${f.mtimeMs}`] = Math.round((await ffprobeDuration(ffprobe, f.path)) * 1000) / 1000;
      }
    }));
    if (batch.length) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const keys = Object.keys(cache);
      for (const k of keys.slice(0, Math.max(0, keys.length - 50000))) delete cache[k];
      fs.writeFileSync(DURATION_CACHE, JSON.stringify(cache));
    }
  }
  for (const f of files) {
    const d = cache[`${f.size}:${f.mtimeMs}`];
    if (d) f.duration = d;
  }
  return { dirs, files, pending };
}

async function handleStat(msg) {
  const paths = (Array.isArray(msg.paths) ? msg.paths : []).slice(0, 20);
  return {
    stats: paths.map((p) => {
      try {
        const st = typeof p === 'string' && path.isAbsolute(p) ? fs.statSync(p) : null;
        return st?.isFile() ? { path: p, size: st.size, mtimeMs: Math.round(st.mtimeMs) } : null;
      } catch {
        return null;
      }
    }),
  };
}

/** Open the file manager with the file selected (for merged files Chrome's downloads list doesn't know). */
async function handleReveal(msg) {
  const p = String(msg.path || '');
  if (!path.isAbsolute(p) || /["\r\n]/.test(p) || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) throw new Error('File not found');
  if (IS_WIN) {
    spawn('explorer.exe', [`/select,"${p}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'darwin' ? ['-R', p] : [path.dirname(p)], { detached: true, stdio: 'ignore' }).unref();
  }
  return { shown: p };
}

const HANDLERS = {
  ping: async () => ({ version: VERSION, tools: tools(), platform: process.platform }),
  reveal: handleReveal,
  move: handleMove,
  scanFolder: handleScanFolder,
  stat: handleStat,
  checkFolder: handleCheckFolder,
  pickFolder: handlePickFolder,
  claude: handleClaude,
  mux: handleMux,
  ytdlp: handleYtdlp,
  ytdlpList: handleYtdlpList,
  toolVersions: handleToolVersions,
  updateYtdlp: handleUpdateYtdlp,
};

async function dispatch(msg) {
  const id = msg?.id;
  const handler = HANDLERS[msg?.type];
  if (!handler) {
    reply({ id, type: 'error', error: `Unknown request type: ${msg?.type}` });
    return;
  }
  try {
    const result = await handler(msg);
    reply({ ...result, id, type: 'result' }); // a handler's own "id" field must never replace the request id
  } catch (e) {
    log('error', msg.type, e.message);
    reply({ id, type: 'error', error: e.message });
  }
}

// Only start the stdin loop when run as the host (not when imported by tests).
const norm = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const isMain = !!process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
if (isMain) {
  log('started', process.argv.slice(2).join(' '), process.env.STREAMSNAG_FAKE_YTDLP === '1' ? '(test mode: fake yt-dlp)' : '');
  process.stdin.on('data', createDecoder((m) => { dispatch(m); }, (e) => log('decode error', e.message)));
  process.stdin.on('end', () => process.exit(0));
}

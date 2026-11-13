#!/usr/bin/env node
// StreamSnag local helper (Chrome native messaging host).
// Chrome starts this on demand. It can:
// @site-edition
//   ping   -> report which tools are installed (claude, ffmpeg, yt-dlp)
// @store-edition
// //   ping   -> report which tools are installed (claude, ffmpeg)
// @end-site-edition
//   claude -> run a prompt through the Claude Code CLI on the user's Claude subscription
//   mux    -> merge video + audio / convert .ts to .mp4 with ffmpeg (stream copy, no re-encode)
// @site-edition
//   ytdlp  -> download a page with yt-dlp, streaming progress back
// @end-site-edition
//   covers / coverPut -> the study desk's small picture of each lecture, kept in StreamSnag's own data folder (covers.js)
// stdout is reserved for protocol frames; diagnostics go to a log file in the temp directory.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeMessage, createDecoder } from './protocol.js';

export const VERSION = '1.6.0';
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
  // Prefer the package named after the tool (Gyan.FFmpeg for ffmpeg), then anything else.
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
  return { claude: findTool('claude'), codex: findTool('codex'), ffmpeg: findTool('ffmpeg'), /* @site-edition */ ytdlp: findTool('yt-dlp'), /* @end-site-edition */ };
}

const PACKAGES = { /* @site-edition */ 'yt-dlp': { win: 'yt-dlp.yt-dlp', other: 'yt-dlp' }, /* @end-site-edition */ ffmpeg: { win: 'Gyan.FFmpeg', other: 'ffmpeg' } };

/**
 * What to install (or, with `verb` 'upgrade', update) a tool with on this kind of computer, to finish a
 * sentence like "Install it with …": winget on Windows, Homebrew on a Mac, the package manager elsewhere.
 */
export function installHint(tool, platform = process.platform, verb = 'install') {
  const pkg = Object.hasOwn(PACKAGES, tool) ? PACKAGES[tool] : null;
  if (!pkg) return 'your package manager';
  if (platform === 'win32') return `"winget ${verb} ${pkg.win}"`;
  if (platform === 'darwin') return `"brew ${verb} ${pkg.other}"`;
  return verb === 'install' ? `your package manager (for example "sudo apt install ${pkg.other}")` : 'your package manager';
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

/** Programs this helper started that are still running. */
const children = new Set();

/**
 * Stop a program this helper started, and whatever that program started itself. Killing only the program
 * is not enough: a downloader runs ffmpeg, a .cmd shim runs the real tool, and a packaged .exe is often a
 * launcher around a second process, all of which would keep working after a Cancel. (On Windows
 * they do end when the helper itself exits; away from Windows, and when a program is stopped while the
 * helper lives on, such as on a timeout, nothing else ends them.)
 */
export function killTree(child) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  try {
    if (IS_WIN) {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
      return;
    }
    process.kill(-child.pid, 'SIGTERM'); // its whole process group (see `detached` in run)
    return;
  } catch { /* no such group, or taskkill is not there: stop at least the program itself */ }
  try { child.kill(); } catch { /* already gone */ }
}

export function run(cmd, args, { input, onLine, timeoutMs = 10 * 60 * 1000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const isShim = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
    // Away from Windows each program leads its own process group, so killTree can stop the group in one go.
    const detached = !IS_WIN;
    let child;
    try {
      child = isShim
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdShimCommandLine(cmd, args)], {
          cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...childEnv(), ...env },
        })
        : spawn(cmd, args, { cwd, windowsHide: true, detached, stdio: ['pipe', 'pipe', 'pipe'], env: { ...childEnv(), ...env } });
    } catch (e) {
      reject(e);
      return;
    }
    children.add(child);
    child.on('close', () => children.delete(child));
    child.on('error', () => children.delete(child));
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    const timer = setTimeout(() => {
      killTree(child);
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
    if (!/^[a-z0-9][a-z0-9.\-[\]]*$/i.test(msg.model)) throw new Error('Invalid model name');
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

/** Arguments for one locked-down, non-interactive Codex CLI run (the ChatGPT subscription route). */
export function buildCodexArgs({ model, outFile }) {
  const args = [
    'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--color', 'never',
    // The prompt contains text from a web page. Codex gets no shell, no browser, no apps: it can only answer.
    '-s', 'read-only',
    ...['shell_tool', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent', 'image_generation', 'hooks'].flatMap((f) => ['--disable', f]),
    '-o', outFile,
  ];
  if (model) {
    if (!/^[a-z0-9][a-z0-9.\-_]*$/i.test(model)) throw new Error('Invalid model name');
    args.push('-m', model);
  }
  args.push('-'); // the prompt comes on stdin
  return args;
}

/** A short, human reason from the Codex CLI's error output. */
export function codexError(output) {
  const text = String(output || '');
  const api = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]?.replace(/\\(.)/g, '$1');
  if (/requires a newer version of Codex|not supported when using Codex/i.test(text)) {
    return `${api || 'This model needs a newer Codex CLI.'} Update it with "npm i -g @openai/codex@latest", or set a model your plan includes in StreamSnag settings.`;
  }
  if (/not logged in|login required|unauthorized|401/i.test(text)) return 'The Codex CLI is not signed in. Run "codex login" once and choose "Sign in with ChatGPT".';
  return `Codex CLI error: ${(api || text.trim().split(/\r?\n/).filter(Boolean).pop() || 'unknown').slice(0, 300)}`;
}

async function handleCodex(msg) {
  const codex = findTool('codex');
  if (!codex) throw new Error('Codex CLI not found. Install it with "npm i -g @openai/codex" and run "codex login" once to sign in with ChatGPT.');
  if (typeof msg.prompt !== 'string' || !msg.prompt) throw new Error('Missing prompt');
  const cwd = path.join(os.tmpdir(), 'streamsnag-codex');
  fs.mkdirSync(cwd, { recursive: true });
  const outFile = path.join(cwd, `answer-${process.pid}-${Date.now()}.txt`);
  let res;
  let text = '';
  try {
    res = await run(codex, buildCodexArgs({ model: msg.model || '', outFile }), { input: msg.prompt, timeoutMs: 230000, cwd });
    text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  } finally {
    fs.rmSync(outFile, { force: true });
  }
  if (res.code !== 0 || !text.trim()) throw new Error(codexError(`${res.stderr}\n${res.stdout}`));
  return { text };
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
  const inputs = Array.isArray(msg.inputs) ? msg.inputs : [];
  if (!inputs.length || inputs.length > 4) throw new Error('Expected 1-4 input files');
  // Video and audio only: the inputs are deleted after merging (security review, 2026-11-12).
  if (inputs.some((p) => typeof p !== 'string' || !MEDIA_EXT.test(p))) throw new Error('That is not a video or audio file');
  inputs.forEach(checkInput);
  const ffmpeg = findTool('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg not found');
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

// ------------------------------------------------------------------ converted copies

const CONVERSIONS = {
  audio: { ext: 'mp3', suffix: '' }, // the sound track on its own, playable anywhere
  small: { ext: 'mp4', suffix: ' (720p)' }, // a smaller H.264 copy for a phone or tablet
};

/** Where a converted copy goes: next to the original, named after it. */
export function convertOutputName(input, mode) {
  const spec = Object.hasOwn(CONVERSIONS, mode) ? CONVERSIONS[mode] : null;
  if (!spec) throw new Error('Unknown conversion');
  const { dir, name } = path.parse(input);
  return path.join(dir, `${name}${spec.suffix}.${spec.ext}`);
}

/**
 * The file a conversion writes while it runs: "<final name>.part", next to the original. The copy only
 * gets its real name once it is whole, so a cancelled or crashed conversion never leaves something that
 * looks like a finished video (the ".part" ending also keeps it out of the folder check).
 */
export function convertPartName(input, mode) {
  return `${convertOutputName(input, mode)}.part`;
}

export function buildConvertArgs({ input, output, mode, subtitles = true }) {
  // -progress pipe:1 prints "out_time_us=..." lines we turn into a percentage.
  const head = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', input];
  // The format is named outright: ffmpeg can't tell it from a name that ends in ".part".
  const to = Object.hasOwn(CONVERSIONS, mode) ? ['-f', CONVERSIONS[mode].ext, output] : [];
  if (mode === 'audio') return [...head, '-vn', '-sn', '-dn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '2', ...to];
  if (mode === 'small') {
    return [...head, '-map', '0:v:0', '-map', '0:a:0?', ...(subtitles ? ['-map', '0:s?', '-c:s', 'mov_text'] : []),
      // Never upscale; keep the width even (H.264 needs it).
      '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', ...to];
  }
  throw new Error('Unknown conversion');
}

/** Half-written files of the conversions running in this helper; removed if it is told to stop. */
const partFiles = new Set();

function removePartFiles() {
  for (const p of [...partFiles]) {
    partFiles.delete(p);
    // The program that was writing it has just been stopped; Windows may hold the file a moment longer.
    try { fs.rmSync(p, { force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* the next run of this conversion removes it */ }
  }
}

/** Seconds of output written so far, from one line of ffmpeg's -progress output (or null). */
export function parseFfmpegProgress(line) {
  const m = /^out_time_(?:us|ms)=(\d+)\s*$/.exec(String(line || '').trim()); // both are microseconds
  return m ? Number(m[1]) / 1e6 : null;
}

async function handleConvert(msg) {
  const ffmpeg = findTool('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg not found');
  checkInput(msg.input);
  if (!MEDIA_EXT.test(msg.input)) throw new Error('That is not a video or audio file');
  // Written under a ".part" name and renamed when it is whole. One left by a run that crashed is removed first.
  const part = convertPartName(msg.input, msg.mode);
  fs.rmSync(part, { force: true });
  partFiles.add(part);
  const ffprobe = findTool('ffprobe') || path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
  const total = fs.existsSync(ffprobe) ? await ffprobeDuration(ffprobe, msg.input).catch(() => 0) : 0;
  let last = -1;
  const onLine = (line, isErr) => {
    const t = isErr ? null : parseFfmpegProgress(line);
    if (t == null || !(total > 0)) return;
    const percent = Math.max(0, Math.min(99, Math.floor((t / total) * 100)));
    if (percent !== last) reply({ id: msg.id, type: 'progress', percent });
    last = percent;
  };
  const attempt = (subtitles) => run(ffmpeg, buildConvertArgs({ input: msg.input, output: part, mode: msg.mode, subtitles }), { onLine, timeoutMs: 6 * 60 * 60 * 1000 });
  try {
    let res = await attempt(true);
    if (res.code !== 0 && msg.mode === 'small') {
      // Picture-based subtitles can't go into an MP4: the copy matters more than its subtitles.
      fs.rmSync(part, { force: true });
      res = await attempt(false);
    }
    if (res.code !== 0) {
      throw new Error(/Unknown encoder|Encoder .* not found/i.test(res.stderr)
        ? `This ffmpeg build cannot make that kind of file. Install a full ffmpeg build with ${installHint('ffmpeg')}.`
        : `ffmpeg failed: ${res.stderr.trim().slice(-400)}`);
    }
    // Never over a file that is already there: a second copy gets "(1)".
    const output = uniquePath(convertOutputName(msg.input, msg.mode));
    fs.renameSync(part, output);
    return { output };
  } finally {
    partFiles.delete(part);
    fs.rmSync(part, { force: true }); // gone already after a rename; this removes what a failed run wrote
  }
}

// @site-edition
export function parseYtdlpProgress(line) {
  const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * yt-dlp's format sorting (-S) for the "Quality to pick first" setting: a number is a cap ("res:720" is
 * the best quality not above 720p, or the lowest there is when all are above it), 'smallest' the smallest
 * file, and 'best' (or anything unknown) yt-dlp's own choice, which is the best. The same rule the
 * extension's own downloads follow (lib/quality.js).
 */
export function ytdlpFormatArgs(quality) {
  const q = String(quality ?? '');
  if (/^(1080|720|480)$/.test(q)) return ['-S', `res:${q}`];
  if (q === 'smallest') return ['-S', '+size,+br'];
  return [];
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
  const dirT = outDir.replace(/%/g, '%%');
  const template = name
    ? path.join(dirT, `${name}.%(ext)s`)
    : msg.playlist === true
      ? path.join(dirT, '%(playlist_title,playlist_id|Playlist).80B', '%(playlist_index)03d - %(title).140B [%(id)s].%(ext)s')
      : path.join(dirT, '%(title).150B [%(id)s].%(ext)s');
  const args = [
    // Each saved file is printed after our mark, in UTF-8 (a title that is not ASCII came out in the console's code page).
    msg.url, msg.playlist === true || items ? '--yes-playlist' : '--no-playlist', '--newline', '--progress', '--encoding', 'utf-8',
    '--print', `after_move:${YTDLP_FILE_MARK}%(filepath)s`,
    '-o', template,
  ];
  if (items) args.push('--playlist-items', items);
  // The quality set in Settings ("Quality to pick first").
  const format = ytdlpFormatArgs(msg.quality);
  args.push(...format);
  // Tests: pretend to download (no network), writing a small file under the requested name.
  if (process.env.STREAMSNAG_FAKE_YTDLP === '1') {
    const free = () => uniquePath(path.join(outDir, `${(name || 'video').replace(/%%/g, '%')}.mp4`));
    const asked = format.length ? ` (${format.join(' ')})` : '';
    // A slow one, for the Cancel test: a real program that starts another, which writes the file ten
    // seconds later (and its own process id next to it at once, so the test can see that it was stopped).
    const slow = process.env.STREAMSNAG_FAKE_YTDLP_SLOW;
    if (slow && msg.url.includes(slow)) {
      const out = free();
      reply({ id: msg.id, type: 'progress', percent: 10, line: `fake yt-dlp 10%${asked}` });
      const work = "const fs=require('fs');const out=process.argv[1];fs.writeFileSync(out+'.pid',String(process.pid));setTimeout(()=>fs.writeFileSync(out,Buffer.alloc(300*1024,9)),10000)";
      const launch = "const c=require('child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'});c.on('exit',(code)=>process.exit(code||0))";
      const res = await run(process.execPath, ['-e', launch, work, out], { timeoutMs: 60000 });
      if (res.code !== 0 || !fs.existsSync(out)) throw new Error('yt-dlp failed: the fake download was stopped');
      return { files: [out], warning: '', args };
    }
    for (const percent of [30, 80]) {
      reply({ id: msg.id, type: 'progress', percent, line: `fake yt-dlp ${percent}%${asked}` });
      await new Promise((r) => setTimeout(r, 600));
    }
    const out = free();
    fs.writeFileSync(out, Buffer.alloc(300 * 1024 + out.length, 9));
    return { files: [out], warning: '', args };
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
      } else if (line.trim().startsWith(YTDLP_FILE_MARK)) {
        const saved = ytdlpSavedFile(line, outDir);
        if (saved && fs.existsSync(saved)) files.push(saved);
      } else reply({ id: msg.id, type: 'progress', line });
    },
  });
  const tail = res.stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500);
  // With --ignore-errors a playlist can partly succeed: keep what was saved and say what failed.
  if (res.code !== 0 && !(msg.playlist === true && files.length)) throw new Error(`yt-dlp failed: ${tail}`);
  return { files, warning: res.code !== 0 ? tail : '' };
}

/** What yt-dlp is asked to print before the path of each file it saved (`--print after_move:…`). */
export const YTDLP_FILE_MARK = 'STREAMSNAG-FILE:';

/**
 * The file yt-dlp saved, from one line of its output: only a line with our mark, and only a full path inside the
 * folder it was told to save in (a playlist's own folder inside it is fine). '' for anything else. Any other line
 * that happens to be a path, whatever a page made yt-dlp print, is never taken for a saved file (security review,
 * 2026-11-12).
 */
export function ytdlpSavedFile(line, outDir) {
  const s = String(line ?? '').trim();
  if (!s.startsWith(YTDLP_FILE_MARK)) return '';
  const p = s.slice(YTDLP_FILE_MARK.length).trim();
  if (!p || !path.isAbsolute(p) || /^\\\\|^\/\//.test(p)) return '';
  const full = path.resolve(p);
  const base = path.resolve(String(outDir || ''));
  const norm = (x) => (IS_WIN ? x.toLowerCase() : x);
  return norm(full).startsWith(norm(base.endsWith(path.sep) ? base : base + path.sep)) ? full : '';
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
// @end-site-edition

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
  // @site-edition
  const [ytdlp, ffmpeg, claude] = await Promise.all([first('yt-dlp', ['--version']), first('ffmpeg', ['-version']), first('claude', ['--version'])]);
  return { helper: VERSION, node: process.version, ytdlp, ffmpeg: ffmpeg.replace(/^ffmpeg version\s+/i, '').split(' ')[0], claude };
  // @store-edition
  // const [ffmpeg, claude] = await Promise.all([first('ffmpeg', ['-version']), first('claude', ['--version'])]);
  // return { helper: VERSION, node: process.version, ffmpeg: ffmpeg.replace(/^ffmpeg version\s+/i, '').split(' ')[0], claude };
  // @end-site-edition
}

// @site-edition
/** Sites change often and an old yt-dlp stops working: update it in place. */
async function handleUpdateYtdlp() {
  const ytdlp = findTool('yt-dlp');
  if (!ytdlp) throw new Error('yt-dlp not found on PATH');
  const res = await run(ytdlp, ['-U'], { timeoutMs: 5 * 60 * 1000 });
  const out = `${res.stdout}\n${res.stderr}`.trim();
  const last = out.split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 400);
  if (res.code !== 0) {
    const hint = /pip/i.test(out) ? 'It was installed with pip: run "pip install -U yt-dlp".'
      : /winget|package manager|not supported/i.test(out) ? `Update it with ${installHint('yt-dlp', process.platform, 'upgrade')}.` : '';
    throw new Error(`${last}${hint ? ` ${hint}` : ''}`);
  }
  toolCache.delete('yt-dlp');
  return { output: last, upToDate: /up to date/i.test(out) };
}
// @end-site-edition

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

/** The files a study pack saves next to a video. Only these may replace a file of the same name when moved. */
export const PACK_FILE = /\.(?:guide\.html|guide\.md|study\.html|slides\.md|flashcards\.txt|transcript\.md)$/i;

function moveFile(src, destDir, { replace = false } = {}) {
  const wanted = path.join(destDir, path.basename(src));
  // A study pack made again takes the place of the one before it (its guide links to "<name>.study.html" by name).
  const over = replace && PACK_FILE.test(wanted) && fs.statSync(wanted, { throwIfNoEntry: false })?.isFile();
  if (over) fs.rmSync(wanted, { force: true });
  const target = over ? wanted : uniquePath(wanted);
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
    if (typeof f !== 'string' || !path.isAbsolute(f) || !MOVE_EXT.test(f) || !fs.statSync(f, { throwIfNoEntry: false })?.isFile()) return null;
    if (path.dirname(path.resolve(f)).toLowerCase() === dir.toLowerCase()) return f;
    return moveFile(f, dir, { replace: msg.replace === true });
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
  let start = '';
  try { start = msg.start ? safeFolder(msg.start) : ''; } catch { start = ''; }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Choose where StreamSnag saves videos'",
    '$d.ShowNewFolderButton = $true',
    'if ($env:SS_START) { $d.SelectedPath = $env:SS_START }',
    "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.SelectedPath }",
  ].filter(Boolean).join('; ');
  const res = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], { timeoutMs: 10 * 60 * 1000, env: { SS_START: start } });
  const picked = res.stdout.trim().split(/\r?\n/).pop() || '';
  return { path: picked ? safeFolder(picked) : '' };
}

// ------------------------------------------------------------------ library scan (what's already downloaded)

const MEDIA_EXT = /\.(mp4|m4v|mkv|webm|mov|ts|avi|flv|wmv|m4a|mp3|aac|flac|wav|ogg|opus)$/i;
/**
 * What "move" moves: only the kinds of file StreamSnag saves (a video or audio file, a document from the page as
 * lib/files.js lists them, a subtitle file, a page or note it made). Anything else is left where it is.
 */
const MOVE_EXT = /\.(mp4|m4v|mkv|webm|mov|ts|avi|flv|wmv|m4a|mp3|aac|flac|wav|ogg|opus|vtt|srt|pdf|ppt|pptx|pps|ppsx|key|odp|doc|docx|odt|rtf|pages|xls|xlsx|csv|ods|numbers|epub|zip|ipynb|html|md|txt)$/i;
const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'StreamSnag');
const DURATION_CACHE = path.join(DATA_DIR, 'durations.json');

/** Walk folders for media files (bounded: depth, count, no hidden/system folders). */
export function listMediaFiles(dirs, { maxDepth = 6, maxFiles = 20000 } = {}) {
  const out = new Map();
  const walk = (dir, depth) => {
    if (out.size >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    for (const e of entries) {
      if (out.size >= maxFiles) return;
      if (e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && MEDIA_EXT.test(e.name) && !out.has(p.toLowerCase())) {
        try {
          const st = fs.statSync(p);
          if (st.size > 0) {
            const file = { path: p, name: e.name, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
            // Captions saved beside it under the same name ("Lecture 3.vtt"), e.g. by "Transcribe on this computer".
            if (names.has(`${path.parse(e.name).name}.vtt`.toLowerCase())) file.vtt = true;
            out.set(p.toLowerCase(), file);
          }
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
  const compact = files.map((f) => {
    const d = cache[`${f.size}:${f.mtimeMs}`];
    const c = { path: f.path, size: f.size, mtimeMs: f.mtimeMs };
    if (d) c.duration = d;
    if (f.vtt) c.vtt = true;
    return c;
  });
  // Chrome takes at most 1 MB per message from a helper: a big library is handed over in pages.
  const first = scanPage(compact, 0);
  let scanId = '';
  if (first.length < compact.length) {
    scanId = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const old of fs.readdirSync(DATA_DIR).filter((n) => /^scan-[a-f0-9]{16}\.json$/.test(n))) {
      try { if (Date.now() - fs.statSync(path.join(DATA_DIR, old)).mtimeMs > 3600e3) fs.unlinkSync(path.join(DATA_DIR, old)); } catch { /* in use */ }
    }
    fs.writeFileSync(path.join(DATA_DIR, `scan-${scanId}.json`), JSON.stringify(compact));
  }
  return { dirs, files: first, total: compact.length, scanId, pending };
}

/** The next slice of a scan that fits in one message (well under Chrome's 1 MB limit). */
export function scanPage(all, offset, maxBytes = 900 * 1024) {
  let n = 4000;
  for (;;) {
    const slice = all.slice(offset, offset + n);
    if (n <= 25 || Buffer.byteLength(JSON.stringify(slice)) < maxBytes) return slice;
    n = Math.floor(n / 2);
  }
}

async function handleScanPageRequest(msg) {
  if (!/^[a-f0-9]{16}$/.test(String(msg.scanId || ''))) throw new Error('Invalid scan id');
  const file = path.join(DATA_DIR, `scan-${msg.scanId}.json`);
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const offset = Math.max(0, Math.floor(Number(msg.offset) || 0));
  const files = scanPage(all, offset);
  if (offset + files.length >= all.length) fs.rmSync(file, { force: true });
  return { files, total: all.length };
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

/** A study page, study guide, cheat sheet or mock exam StreamSnag saved: the only kind of file the helper will open in the browser. */
// (The same pages as the extension's isPackPage, lib/decks.js: the reading edition too.)
const PACK_PAGE = /\.(?:study|guide|read|cheatsheet|mock-exam-\d{4}-\d{2}-\d{2})(?: \(\d+\))?\.html$/i;

/**
 * The small page that sends the browser on to a study page at a minute and a slide: a file can go to
 * another file, where an extension (without "Allow access to file URLs") may not. `file`: the study
 * page's full path; `t` seconds; `slide` the slide's number. Returns { html, target }.
 */
export function redirectPage(file, { t, slide } = {}) {
  const p = String(file || '');
  if (!path.isAbsolute(p) || /["<>\r\n\u0000]/.test(p) || !PACK_PAGE.test(p)) throw new Error('That is not a study page StreamSnag saved.');
  const parts = [Number.isFinite(t) && t >= 0 ? `t=${Math.floor(t)}` : '', Number.isInteger(slide) && slide > 0 && slide < 10000 ? `slide=${slide}` : ''].filter(Boolean);
  const target = `${pathToFileURL(p).href}${parts.length ? `#${parts.join('&')}` : ''}`;
  const safe = target.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${safe}">\n<title>Opening your lecture</title>\n<p><a href="${safe}">Open the study page</a></p>\n`;
  return { html, target };
}

/**
 * "Show me in the lecture" when the browser will not let the extension open a file itself: opens the
 * saved study page in the default browser, at the card's minute and slide.
 */
async function handleOpenPage(msg) {
  const p = String(msg.path || '');
  const { html, target } = redirectPage(p, { t: Number(msg.t), slide: Number(msg.slide) });
  if (!fs.statSync(p, { throwIfNoEntry: false })?.isFile()) throw new Error('File not found');
  const dir = path.join(os.tmpdir(), 'streamsnag-open');
  fs.mkdirSync(dir, { recursive: true });
  for (const old of fs.readdirSync(dir)) {
    // Yesterday's are no use to anyone.
    try { if (Date.now() - fs.statSync(path.join(dir, old)).mtimeMs > 86400000) fs.rmSync(path.join(dir, old), { force: true }); } catch { /* in use */ }
  }
  const go = path.join(dir, `open-${crypto.randomUUID()}.html`);
  fs.writeFileSync(go, html);
  if (process.env.STREAMSNAG_TEST_NO_OPEN !== '1') {
    if (IS_WIN) spawn('explorer.exe', [go], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [go], { detached: true, stdio: 'ignore' }).unref();
  }
  return { opened: target, via: go };
}

const HANDLERS = {
  ping: async () => ({ version: VERSION, tools: tools(), platform: process.platform }),
  reveal: handleReveal,
  openPage: handleOpenPage,
  move: handleMove,
  scanFolder: handleScanFolder,
  scanPage: handleScanPageRequest,
  stat: handleStat,
  checkFolder: handleCheckFolder,
  pickFolder: handlePickFolder,
  claude: handleClaude,
  codex: handleCodex,
  mux: handleMux,
  convert: handleConvert,
  toolVersions: handleToolVersions,
  // @site-edition
  ytdlp: handleYtdlp,
  ytdlpList: handleYtdlpList,
  updateYtdlp: handleUpdateYtdlp,
  // @end-site-edition
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
  // @site-edition
  log('started', process.argv.slice(2).join(' '), process.env.STREAMSNAG_FAKE_YTDLP === '1' ? '(test mode: fake yt-dlp)' : '',
    process.env.STREAMSNAG_FAKE_STT === '1' ? '(test mode: fake transcription)' : '');
  // @store-edition
  // log('started', process.argv.slice(2).join(' '), process.env.STREAMSNAG_FAKE_STT === '1' ? '(test mode: fake transcription)' : '');
  // @end-site-edition
  process.stdin.on('data', createDecoder((m) => { dispatch(m); }, (e) => log('decode error', e.message)));
  process.stdin.on('end', () => {
    // Chrome closed the connection (the request was cancelled, or the browser quit): stop what we started,
    // and whatever those programs started, then remove the half-written files they leave.
    for (const c of [...children]) killTree(c);
    removePartFiles();
    process.exit(0);
  });
}

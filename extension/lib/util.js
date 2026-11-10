// Small pure helpers shared by the service worker, popup, offscreen page and tests.

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Make a string safe to use as a file name on Windows, macOS and Linux. */
export function sanitizeFilename(name, maxLength = 150) {
  let s = String(name ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > maxLength) s = s.slice(0, maxLength).trim();
  if (!s || WINDOWS_RESERVED.test(s)) s = s ? `_${s}` : 'video';
  return s;
}

/**
 * Turn a subfolder template like "StreamSnag/{site}/{date}" into a safe relative path. Each segment is
 * sanitized on its own, and empty, "." and ".." segments are dropped, so it can never climb out of the
 * base folder. Tokens: {site} {course} {date} {kind}.
 */
export function resolveFolder(template, vars = {}) {
  const filled = String(template || '').replace(/\{(site|course|date|kind)\}/g, (_, k) => String(vars[k] || '').replace(/[\\/]+/g, ' '));
  return filled.split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => sanitizeFilename(seg, 60))
    .slice(0, 5)
    .join('/');
}

/**
 * Fill a filename template. Supported tokens: {title} {quality} {host} {date} {kind}.
 * Empty tokens collapse together with the separators around them.
 */
export function buildFilename(template, vars, ext) {
  const tpl = template || '{title} - {quality}';
  const filled = tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
  const cleaned = filled
    .replace(/(\s*[-_·|]\s*){2,}/g, ' - ')
    .replace(/^\s*[-_·|]\s*|\s*[-_·|]\s*$/g, '');
  const base = sanitizeFilename(cleaned || vars.title || 'video');
  const e = String(ext || '').replace(/^\./, '').toLowerCase();
  return e ? `${base}.${e}` : base;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatBitrate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function resolveUrl(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Site key used for recipes: hostname without a leading "www.". */
export function siteKey(urlOrHost) {
  const host = urlOrHost.includes('://') ? hostOf(urlOrHost) : urlOrHost;
  return host.replace(/^www\./i, '').toLowerCase();
}

/** Lower-cased extension from a URL path (ignores query/hash), or ''. */
export function extFromUrl(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    path = String(url).split(/[?#]/)[0];
  }
  const m = /\.([a-z0-9]{1,5})$/i.exec(path);
  return m ? m[1].toLowerCase() : '';
}

export function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

/** Quote a value for a POSIX-ish or PowerShell command line (double quotes, escaped). */
function q(s) {
  return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
}

export function ytdlpCommand(url, { referer, output } = {}) {
  const parts = ['yt-dlp'];
  if (referer) parts.push('--referer', q(referer));
  if (output) parts.push('-o', q(output));
  parts.push(q(url));
  return parts.join(' ');
}

export function ffmpegCommand(url, { referer, output = 'video.mp4' } = {}) {
  const parts = ['ffmpeg'];
  if (referer) parts.push('-referer', q(referer));
  parts.push('-i', q(url), '-c', 'copy', q(output));
  return parts.join(' ');
}

/** Stable short hash (FNV-1a) — used for ids and DNR rule ids. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shortId(str) {
  return hash32(str).toString(36);
}

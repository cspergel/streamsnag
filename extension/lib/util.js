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
 * A lecture/episode number at the start of a title, and the rest: "009: Updates in C. diff" →
 * { number: '009', name: 'Updates in C. diff' }. Dates and times ("2026-11-02 …", "10:30 …") are not numbers.
 */
export function splitLecture(title) {
  const t = String(title || '').trim();
  const m = /^(?:(?:lecture|lec|episode|ep|part|session|video|no|#)\.?\s*)?(\d{1,3})(?![\d:.,/-]\d)(?!\d)\s*(?:[-–—:.)_|]+\s*|\s+)(.*)$/i.exec(t);
  return m && m[2] ? { number: m[1], name: m[2].trim() } : { number: '', name: t };
}

/**
 * Fill a filename template. Tokens: {title} {number} {name} {course} {page} {quality} {host} {date} {kind}
 * ({number} and {name} are the two halves of a numbered title). Empty tokens collapse with their separators.
 */
export function buildFilename(template, vars, ext) {
  const tpl = template || '{title} - {quality}';
  vars = { ...splitLecture(vars.title), ...vars };
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

/**
 * The folder and file-name template for a page: a rule for its site (or a parent domain: a rule for
 * "example.com" also covers "learn.example.com") overrides the general settings.
 */
export function rulesFor(settings, url) {
  const site = url ? siteKey(url) : '';
  const rules = settings?.siteRules || {};
  const key = Object.keys(rules).filter((k) => site === k || site.endsWith(`.${k}`)).sort((a, b) => b.length - a.length)[0];
  const r = key ? rules[key] : {};
  return {
    site: key || '',
    subfolder: r.subfolder != null && r.subfolder !== '' ? r.subfolder : settings?.subfolder,
    filenameTemplate: r.filenameTemplate ? r.filenameTemplate : settings?.filenameTemplate,
  };
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

/**
 * A URL for a command line that is safe to paste into bash, zsh, PowerShell or cmd: double-quoted, with every
 * character any of them would expand or end the quotes on ($ ` " \\ ! ') percent-encoded (same URL to a server).
 */
function qUrl(s) {
  return `"${String(s).replace(/[$`"\\!'\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)}"`;
}

/** A file name for a command line: the same dangerous characters are simply dropped. */
function qName(s) {
  return `"${String(s).replace(/[$`"\\!'%]/g, '').trim() || 'video.mp4'}"`;
}

export function ytdlpCommand(url, { referer, output } = {}) {
  const parts = ['yt-dlp'];
  if (referer) parts.push('--referer', qUrl(referer));
  if (output) parts.push('-o', qName(output));
  parts.push(qUrl(url));
  return parts.join(' ');
}

export function ffmpegCommand(url, { referer, output = 'video.mp4' } = {}) {
  const parts = ['ffmpeg'];
  if (referer) parts.push('-referer', qUrl(referer));
  parts.push('-i', qUrl(url), '-c', 'copy', qName(output));
  return parts.join(' ');
}

// Shared hosting where neighbours are different owners: "a.github.io" and "b.github.io" are not one site.
const SHARED_SUFFIXES = new Set(['github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'herokuapp.com', 'appspot.com', 'blogspot.com', 'wordpress.com', 'wixsite.com', 'squarespace.com',
  'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'r2.dev', 'onrender.com', 'fly.dev', 'glitch.me', 'neocities.org',
  'surge.sh', 'replit.app', 'ngrok.io', 'ngrok-free.app', 'myshopify.com', 'substack.com', 'tumblr.com', 'notion.site']);

/**
 * The part of a host name one owner controls ("www.learn.example.com" → "example.com", "bbc.co.uk" →
 * "bbc.co.uk", "me.github.io" → "me.github.io"). A small built-in list instead of the full Public Suffix List.
 */
export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^[\d.]+$/.test(h) || h.includes(':')) return h; // IP addresses stand alone
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  // Every bucket/distribution is a different owner: the whole host name is the site.
  if (/(^|\.)(amazonaws\.com|cloudfront\.net|r2\.dev|storage\.googleapis\.com)$/.test(h)) return h;
  // Country second levels like co.uk, com.au, ac.jp; and shared hosting: keep one more label.
  const ccSecond = parts.at(-1).length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|gob|nic|mil|ltd|plc|sch|nhs|police|me|info|biz)$/.test(parts.at(-2));
  if (ccSecond || SHARED_SUFFIXES.has(last2) || SHARED_SUFFIXES.has(parts.slice(-3).join('.'))) {
    const keep = SHARED_SUFFIXES.has(parts.slice(-3).join('.')) ? 4 : 3;
    return parts.slice(-keep).join('.');
  }
  return last2;
}

/** Loopback, private-network and link-local hosts (a router, a NAS, a dev server…). */
export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || /\.(local|lan|internal|home|corp|intranet)$/.test(h)) return true;
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
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

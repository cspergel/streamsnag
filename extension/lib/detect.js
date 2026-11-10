// Classifies a network response as downloadable media (or not).
import { extFromUrl, isHttpUrl } from './util.js';

export const DIRECT_EXT = {
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', mkv: 'video', flv: 'video',
  ogv: 'video', avi: 'video', '3gp': 'video', wmv: 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio',
  wav: 'audio', flac: 'audio', weba: 'audio',
};
export const SUBTITLE_EXT = new Set(['vtt', 'srt']);

/**
 * The extension to save a file under when all we have is its address: only a known audio/video one.
 * A page chooses its own addresses, so "clip.scr" or "movie.exe" must never become the saved file's type.
 */
export function mediaExtFromUrl(url, fallback = 'mp4') {
  const e = extFromUrl(url);
  return Object.hasOwn(DIRECT_EXT, e) ? e : fallback;
}
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'm4v_seg']);
const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl',
  'application/mpegurl', 'video/mpegurl',
]);
const DASH_TYPES = new Set(['application/dash+xml', 'video/vnd.mpeg.dash.mpd']);
const SUB_TYPES = new Set(['text/vtt', 'application/x-subrip', 'text/srt']);
const OCTET_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/force-download']);

// Paths that are almost always pieces of an adaptive stream rather than whole files.
const SEGMENT_PATH = /(?:^|[/_.-])(?:seg|segment|frag|fragment|chunk|part)[-_]?\d+|\/range\/\d+-\d+|[?&](?:range|bytes)=\d+-\d+/i;

/**
 * Total size of the resource from Content-Range ("bytes 0-99/12345") or Content-Length.
 * Returns null when unknown.
 */
export function totalSize({ contentLength, contentRange }) {
  if (contentRange) {
    const m = /\/(\d+)\s*$/.exec(contentRange);
    if (m) return Number(m[1]);
  }
  const n = Number(contentLength);
  return Number.isFinite(n) && contentLength !== '' && contentLength != null && n >= 0 ? n : null;
}

/** True when this ranged response is a later chunk of a file (not starting at byte 0). */
function isMidFileRange(contentRange) {
  const m = /bytes\s+(\d+)-/i.exec(contentRange || '');
  return !!m && Number(m[1]) > 0;
}

export function isLikelySegment(url, size) {
  const ext = extFromUrl(url);
  if (SEGMENT_EXT.has(ext)) return true;
  // fMP4/TS chunk names: only call it a segment if it is also reasonably small.
  return SEGMENT_PATH.test(url) && (size == null || size < 15 * 1024 * 1024);
}

/**
 * @param {{url:string, contentType?:string, contentLength?:string|number, contentRange?:string, status?:number}} r
 * @param {{minSizeBytes?:number}} opts
 * @returns {null | {kind:'direct'|'hls'|'dash'|'subtitle', mediaType:'video'|'audio'|'subtitle'|'stream', ext:string, size:number|null, contentType:string}}
 */
export function classifyResponse(r, { minSizeBytes = 300 * 1024 } = {}) {
  if (!r || !isHttpUrl(r.url)) return null;
  if (r.status && (r.status < 200 || r.status >= 300)) return null;
  const ct = String(r.contentType || '').split(';')[0].trim().toLowerCase();
  const ext = extFromUrl(r.url);
  const size = totalSize(r);
  const base = { contentType: ct, size };

  if (HLS_TYPES.has(ct) || ext === 'm3u8') return { ...base, kind: 'hls', mediaType: 'stream', ext: 'm3u8' };
  if (DASH_TYPES.has(ct) || ext === 'mpd') return { ...base, kind: 'dash', mediaType: 'stream', ext: 'mpd' };
  if (SUB_TYPES.has(ct) || SUBTITLE_EXT.has(ext)) {
    // VTT pieces of an HLS subtitle playlist are tiny and numbered; skip those.
    if (SEGMENT_PATH.test(r.url)) return null;
    return { ...base, kind: 'subtitle', mediaType: 'subtitle', ext: SUBTITLE_EXT.has(ext) ? ext : 'vtt' };
  }

  const isAV = ct.startsWith('video/') || ct.startsWith('audio/');
  const isOctetMedia = OCTET_TYPES.has(ct) && DIRECT_EXT[ext];
  const noTypeMedia = !ct && DIRECT_EXT[ext];
  if (!isAV && !isOctetMedia && !noTypeMedia) return null;
  if (ct === 'video/mp2t' || ct === 'video/iso.segment') return null;
  if (isMidFileRange(r.contentRange) && size == null) return null;
  if (isLikelySegment(r.url, size)) return null;
  if (size != null && size < minSizeBytes) return null;

  const mediaType = ct.startsWith('audio/') || DIRECT_EXT[ext] === 'audio' ? 'audio' : 'video';
  const outExt = DIRECT_EXT[ext] ? ext : extFromContentType(ct) || (mediaType === 'audio' ? 'mp3' : 'mp4');
  return { ...base, kind: 'direct', mediaType, ext: outExt };
}

export function extFromContentType(ct) {
  const map = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'video/x-flv': 'flv', 'video/ogg': 'ogv', 'video/3gpp': '3gp', 'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'weba',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/opus': 'opus',
  };
  return map[ct] || '';
}

/** Classify a URL found in the DOM (no headers available). */
export function classifyUrl(url) {
  if (!isHttpUrl(url)) return null;
  const ext = extFromUrl(url);
  if (ext === 'm3u8') return { kind: 'hls', mediaType: 'stream', ext, size: null, contentType: '' };
  if (ext === 'mpd') return { kind: 'dash', mediaType: 'stream', ext, size: null, contentType: '' };
  if (SUBTITLE_EXT.has(ext)) return { kind: 'subtitle', mediaType: 'subtitle', ext, size: null, contentType: '' };
  if (DIRECT_EXT[ext] && !isLikelySegment(url, null)) {
    return { kind: 'direct', mediaType: DIRECT_EXT[ext], ext, size: null, contentType: '' };
  }
  return null;
}

// Query parameters that change between requests for the SAME file: byte ranges, cache busters, and the
// signatures/expiry times CDNs append (CloudFront, Akamai, S3, GCS, Azure, Fastly, Vimeo, Wistia...).
// Parameters that identify the video (id, v, file...) are deliberately not in this list.
const VOLATILE_PARAMS = new Set([
  'range', 'rn', 'rbuf', 'bytes', 'bytestart', 'byteend', '_', 'cb', 't', 'ts', 'time', 'timestamp', 'rand', 'random', 'nocache', 'cachebust',
  'token', 'tok', 'auth', 'authtoken', 'auth_token', 'access_token', 'sig', 'signature', 'sign', 'hmac', 'hash', 'hdnea', 'hdnts', 'hdntl',
  'policy', 'key-pair-id', 'expires', 'expire', 'exp', 'expiry', 'e', 'st', 'se', 'sp', 'sv', 'sr', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv',
  'pathsig', 'qsr', 'oh', 'oe', 'acl', 'validfrom', 'validto', 'starttime', 'endtime', 'sessionid', 'pubtoken', 'md5',
]);
const VOLATILE_PREFIX = /^(x-amz-|x-goog-|_nc_|__gda__|cf_|cdn_|hdn)/i;

/** Normalised key used to de-duplicate the same media seen several times. */
export function dedupeKey(url) {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) {
      if (VOLATILE_PARAMS.has(p.toLowerCase()) || VOLATILE_PREFIX.test(p)) u.searchParams.delete(p);
    }
    u.searchParams.sort();
    u.hash = '';
    // Signed path segments like /token=abc/ or /exp=123~acl=...~hmac=.../ (Akamai-style).
    // Also Vimeo-style per-session segments (/psid=.../) and Fastly-style "/1794236234-0xabc123.../".
    u.pathname = u.pathname
      .replace(/\/(?:[a-z_-]*(?:token|hmac|exp|hdnts|hdnea|sig|psid)[a-z_-]*=[^/]*)(?=\/)/gi, '')
      .replace(/\/\d{9,11}-0x[0-9a-f]{16,}(?=\/)/gi, '');
    return u.href;
  } catch {
    return url;
  }
}

/**
 * Do two detected items look like the same file? Used to merge duplicates whose URLs differ in ways
 * dedupeKey can't know about (different CDN host, renamed path). Direct files: identical byte size
 * (over 256 KB) and the same type. Streams: the same fingerprint of what the manifest lists.
 */
export function sameMedia(a, b) {
  if (!a || !b || a === b) return false;
  if (a.kind === 'subtitle' || b.kind === 'subtitle') return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'direct') {
    return a.size > 256 * 1024 && a.size === b.size && (a.ext || '') === (b.ext || '');
  }
  return !!a.fingerprint && a.fingerprint === b.fingerprint;
}

/** Host-independent fingerprint of a stream: the paths of what its manifest points at. */
export function streamFingerprint(urls, extra = '') {
  const paths = urls.filter(Boolean).map((u) => {
    try {
      return new URL(dedupeKey(u)).pathname + new URL(dedupeKey(u)).search;
    } catch {
      return u;
    }
  });
  if (!paths.length) return '';
  return `${extra}|${paths.slice(0, 12).join('|')}|${paths.length}`;
}

// One video that a page offers as several files (a <video> with several <source>s, a playlist entry with
// an MP4 and an OGV) is one video with choices, not several videos. And a playlist written into the page
// (the JSON a player is set up with) lists every lecture with its own name. Pure, shared by the service
// worker, the popup and the tests.
import { formatBytes, resolveUrl, isHttpUrl } from './util.js';
import { classifyUrl } from './detect.js';

// At the same picture size, the file most players and editors open comes first.
const CONTAINERS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv'];
const containerRank = (ext) => { const i = CONTAINERS.indexOf(String(ext || '').toLowerCase()); return i < 0 ? CONTAINERS.length : i; };

/**
 * The picture height a file says it has: given by the page, or read from its label or name
 * ("….480p.vp9.webm", "BigBuckBunny_320x180.mp4"). Only a number that is written as a height: a bitrate
 * in a name ("lec01_300k.mp4", "book_64kb.mp3") is not one.
 */
export function heightOf(m) {
  if (Number(m?.height) > 0) return Number(m.height);
  const said = /(?<![\p{L}\p{N}])(\d{3,4})p(?![\p{L}\p{N}])/iu.exec(`${m?.quality || ''} ${m?.hint || ''}`)?.[1];
  if (said) return Number(said);
  let file = '';
  try { file = decodeURIComponent(new URL(m.url).pathname.split('/').pop() || ''); } catch { /* no address */ }
  const written = Number(/(?<![\p{L}\p{N}])(\d{3,4})p(?![\p{L}\p{N}])/iu.exec(file)?.[1]
    || /(?<![\p{L}\p{N}])\d{3,4}x(\d{3,4})(?![\p{L}\p{N}])/iu.exec(file)?.[1]) || 0;
  // ("lecture0-4k.mp4": four thousand across is 2160 high.)
  return written || ({ '4k': 2160, '8k': 4320 })[/(?<![\p{L}\p{N}])([48]k)(?![\p{L}\p{N}])/iu.exec(file)?.[1].toLowerCase()] || 0;
}

const groupable = (m) => !!m.set && m.kind === 'direct' && m.mediaType !== 'subtitle' && !m.dismissed;

/**
 * Fold the files of one video into one item. Files that share a `set` (set from the page: the sources of
 * one player, the files of one playlist entry, one recording linked in several formats) become one card:
 * the best one (tallest picture, then MP4 before WebM and OGV, then, where all their sizes are known, the bigger file) carries `variants`
 * [{ id, ext, height, size }], best first, and the others get `variantOf` (its id) and are no longer
 * listed. Run again whenever the list changes: it undoes itself when a group is gone. Streams and caption
 * files are never folded.
 * A picture height only tells the files apart when at least two of them say theirs: where a single file
 * has one (the one a player happens to be playing) and the rest say nothing, the files are told apart by
 * their type, and none is ranked below another for a height it never gave.
 */
export function groupVariants(media) {
  const groups = new Map();
  for (const m of media || []) {
    delete m.variantOf;
    delete m.variants;
    if (!groupable(m)) continue;
    if (!groups.has(m.set)) groups.set(m.set, []);
    groups.get(m.set).push(m);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const told = members.filter((x) => heightOf(x) > 0).length >= 2;
    const high = (x) => (told ? heightOf(x) : 0);
    // (The bigger file first only where every file's size is known: one nobody has asked for is not "smaller".)
    const sized = members.every((x) => x.size > 0);
    const big = (x) => (sized ? x.size : 0);
    const ranked = [...members].sort((a, b) => high(b) - high(a) || containerRank(a.ext) - containerRank(b.ext)
      || big(b) - big(a) || (a.detectedAt || 0) - (b.detectedAt || 0));
    const [first, ...rest] = ranked;
    first.variants = ranked.map((x) => ({ id: x.id, ext: x.ext || '', height: high(x), size: x.size || 0 }));
    for (const x of rest) x.variantOf = first.id;
  }
}

/** The choices of a video that comes in several files, as `inspect` lists a stream's: [{ id, label, height, bandwidth }]. */
export function variantOptions(m) {
  // (Sound files have no picture: they are choices of the recording, not "audio only" of something else.)
  return (m?.variants || []).map((v) => ({
    id: v.id === m.id ? 'file' : `alt:${v.id}`,
    label: [v.height ? `${v.height}p` : '', (v.ext || 'file').toUpperCase(), v.size ? formatBytes(v.size) : ''].filter(Boolean).join(' · '),
    height: v.height || 0, bandwidth: 0,
  }));
}

/**
 * The item a download of choice `optionId` is about: the video itself, or (for "alt:<id>") the video with
 * the chosen file's address, type and size. Its keys are the video's and the file's, so the history knows
 * the video again whichever file was saved.
 */
export function variantChoice(media, m, optionId) {
  const id = /^alt:(.+)$/.exec(String(optionId || ''))?.[1];
  const alt = id && m?.variants?.some((v) => v.id === id) ? (media || []).find((x) => x.id === id) : null;
  if (!alt) return m;
  const keys = [...new Set([alt.key, ...(alt.aliases || []), m.key, ...(m.aliases || [])])].filter(Boolean);
  return {
    ...m, url: alt.url, key: alt.key, aliases: keys.filter((k) => k !== alt.key), ext: alt.ext, size: alt.size ?? null, contentType: alt.contentType || '',
    height: alt.height || 0, quality: alt.quality || '', hint: alt.hint || '', // what says how tall its picture is (heightOf)
  };
}

// ---------------------------------------------------------------- a playlist written into the page

const MAX_ENTRIES = 120;
const MAX_SOURCES = 4;
const text = (v, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const MEDIA_TYPE = /^(?:video|audio)\/|mpegurl|dash\+xml|^(?:mp4|m4v|webm|ogg|ogv|mov|hls|dash|mp3|m4a)$/i;

function sourceOf(raw, base) {
  const given = typeof raw === 'string' ? { file: raw } : raw && typeof raw === 'object' ? raw : null;
  const address = text(given?.file ?? given?.src ?? given?.url, 2000);
  const url = address ? resolveUrl(address, base) : null;
  if (!url || !isHttpUrl(url)) return null;
  const type = text(given.type, 60);
  const kind = classifyUrl(url);
  if (kind ? kind.kind === 'subtitle' : !MEDIA_TYPE.test(type)) return null; // a picture, a page, a caption file
  return { url, height: Number(given.height) > 0 ? Number(given.height) : 0, label: text(given.label, 60), type };
}

function trackOf(raw, base) {
  if (!raw || typeof raw !== 'object' || !/^(subtitles|captions)$/i.test(text(raw.kind) || 'subtitles')) return null;
  const address = text(raw.file ?? raw.src ?? raw.url, 2000);
  const url = address ? resolveUrl(address, base) : null;
  return url && isHttpUrl(url) ? { url, label: text(raw.label, 60), lang: text(raw.srclang ?? raw.language ?? raw.lang, 20) } : null;
}

function entryOf(raw, base) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const title = text(raw.title ?? raw.name);
  const list = Array.isArray(raw.sources) ? raw.sources : [raw.file ?? raw.src ?? raw.url].filter(Boolean);
  const sources = list.map((x) => sourceOf(x, base)).filter(Boolean).slice(0, MAX_SOURCES);
  if (!title || !sources.length) return null;
  const poster = text(raw.image ?? raw.poster ?? raw.thumbnail, 2000);
  return {
    title, duration: Number(raw.duration) > 0 ? Number(raw.duration) : 0, poster: poster ? resolveUrl(poster, base) || '' : '',
    sources, tracks: (Array.isArray(raw.tracks) ? raw.tracks : []).map((x) => trackOf(x, base)).filter(Boolean).slice(0, 8),
  };
}

/**
 * The lectures of playlists written into a page. `texts`: JSON found in its markup (an attribute or a data
 * block a player is set up from); `base`: the page's address. A playlist is a list of two or more entries
 * that each have a title and a media file ("file", "src" or "url", or a list of "sources"), which is how
 * JW Player, video.js playlists and archive.org write theirs. Returns
 * [{ title, duration, poster, sources: [{ url, height, label, type }], tracks: [{ url, label, lang }] }].
 */
export function pagePlaylists(texts, base) {
  const out = [];
  const seen = new Set();
  const take = (list) => {
    const entries = list.map((x) => entryOf(x, base)).filter(Boolean);
    if (entries.length < 2) return;
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES || seen.has(e.sources[0].url)) continue;
      seen.add(e.sources[0].url);
      out.push(e);
    }
  };
  for (const t of (Array.isArray(texts) ? texts : []).slice(0, 6)) {
    if (typeof t !== 'string' || t.length > 2_000_000) continue;
    let data;
    try {
      data = JSON.parse(t);
    } catch {
      continue;
    }
    if (Array.isArray(data)) take(data);
    else if (data && typeof data === 'object') for (const v of [data.playlist, data.sources?.playlist, data.items].filter(Array.isArray)) take(v);
  }
  return out;
}

// The files a stream is made of, read from its own manifests: playlists, init files, segments, whole-track
// files read by byte range. They are the stream's, so they are never listed as videos of their own (and a
// protected stream's files are never offered at all). Pure, shared by the service worker and the tests.
//
// Kept small: an address that can never be listed anyway (a .ts or .m4s piece) is not kept, and a run of
// numbered pieces is kept as one pattern [before, after] instead of thousands of addresses.
import { dedupeKey, isSegmentType } from './detect.js';

const MAX_KEYS = 6000;
const MAX_PATTERNS = 400;
const RUN = 4; // this many numbered files in one folder are a run

const MAX_FOLDERS = 40;

export const emptyParts = () => ({ keys: new Set(), patterns: [], folders: [] });

/** A playlist's address without what follows its "?" ('' for an address that is no playlist's, or has no "?"). */
function barePlaylist(key) {
  const at = String(key).indexOf('?');
  const bare = at < 0 ? '' : String(key).slice(0, at);
  return /\.m3u8$/i.test(bare) ? bare : '';
}

/**
 * Is this address (as dedupeKey gives it) one of the stream's own files? `parts`: { keys: Set | [], patterns }.
 * A playlist is known by its path: a player asks for a quality's playlist with a word of its own after
 * the "?" ("…/720p/video.m3u8?ClassPID=0") that the master playlist did not write.
 */
export function isPart(parts, key) {
  if (!parts || !key) return false;
  const keys = parts.keys;
  const has = (k) => !!keys && (typeof keys.has === 'function' ? keys.has(k) : keys.includes(k));
  if (has(key)) return true;
  const bare = barePlaylist(key);
  if (bare && has(bare)) return true;
  for (const [before, after] of parts.patterns || []) {
    if (key.length > before.length + after.length && key.startsWith(before) && key.endsWith(after)
      && /^\d+$/.test(key.slice(before.length, key.length - after.length))) return true;
  }
  return false;
}

/** Add `more` to `into` ({ keys: Set, patterns }), each once, within the caps. Returns `into`. */
export function addParts(into, more) {
  for (const k of more?.keys || []) if (into.keys.size < MAX_KEYS) into.keys.add(k);
  for (const p of more?.patterns || []) {
    if (into.patterns.length >= MAX_PATTERNS) break;
    if (!into.patterns.some((q) => q[0] === p[0] && q[1] === p[1])) into.patterns.push([p[0], p[1]]);
  }
  if (more?.folders?.length) {
    into.folders = into.folders || [];
    for (const f of more.folders) if (into.folders.length < MAX_FOLDERS && !into.folders.includes(f)) into.folders.push(f);
  }
  return into;
}

/** The folder an address is in ("https://host/a/b/"); '' for what is not an address. */
function folderOf(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/[^/]*$/, '')}`;
  } catch {
    return '';
  }
}

/**
 * Is this caption file the stream's own? A player may load a talk's captions as one file from the folder
 * the stream keeps its subtitle playlists in (TED: ".../subtitles/en/full.vtt" beside ".../subtitles/en.m3u8"):
 * the captions the stream itself has, so not a file to list beside it. Only a caption file, and only in a
 * folder that is the subtitles' own (`parts.folders`, from hlsParts): a stream that keeps everything in
 * one folder says nothing about the files next to it.
 */
export function ownCaption(parts, key) {
  if (!parts?.folders?.length || !/\.(?:vtt|webvtt|srt)(?:$|[?#])/i.test(String(key || ''))) return false;
  return parts.folders.some((f) => key.startsWith(f) && key.length > f.length);
}

/** A templated address [before, after] as its keys would read: signatures off, the way dedupeKey leaves them. */
function patternKey([before, after]) {
  const mark = '7730077300773';
  const cut = dedupeKey(`${before}${mark}${after}`).split(mark);
  return cut.length === 2 ? cut : null;
}

/** Addresses → { keys, patterns }: once each, runs of numbered files in one folder folded into a pattern. */
export function partsOf(urls) {
  const keys = [...new Set((urls || []).filter(Boolean).filter((u) => !isSegmentType(u)).map(dedupeKey))];
  // Group by everything but the file's own name: folder before, extension and query after.
  const groups = new Map();
  for (const k of keys) {
    const m = /^(.*\/)([^/?#]*?)(\.[a-z0-9]{1,6})?(\?[^#]*)?$/i.exec(k);
    const id = m ? `${m[1]}\u0000${m[3] || ''}${m[4] || ''}` : `\u0000${k}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(m ? { k, dir: m[1], stem: m[2], tail: `${m[3] || ''}${m[4] || ''}` } : { k });
  }
  const out = { keys: [], patterns: [] };
  for (const list of groups.values()) {
    const run = list.length >= RUN && list[0].dir != null ? numbered(list) : null;
    if (run) out.patterns.push(run);
    else out.keys.push(...list.map((x) => x.k));
  }
  return out;
}

/** Files of one folder and type whose names differ only in a number: [before, after], or null. */
function numbered(list) {
  const stems = list.map((x) => x.stem);
  let head = stems[0];
  let tail = stems[0];
  for (const s of stems) {
    let i = 0;
    while (i < head.length && i < s.length && head[i] === s[i]) i++;
    head = head.slice(0, i);
    let j = 0;
    while (j < tail.length && j < s.length && tail[tail.length - 1 - j] === s[s.length - 1 - j]) j++;
    tail = tail.slice(tail.length - j);
  }
  head = head.replace(/\d+$/, ''); // "seg-1" shared by seg-10…seg-19: the number starts after "seg-"
  tail = tail.replace(/^\d+/, '');
  const ok = stems.every((s) => s.length > head.length + tail.length && /^\d+$/.test(s.slice(head.length, s.length - tail.length)));
  return ok ? [`${list[0].dir}${head}`, `${tail}${list[0].tail}`] : null;
}

/**
 * The parts of a parsed HLS playlist (lib/hls.js). A master: its video, sound and subtitle playlists. A
 * media playlist: its init file (EXT-X-MAP) and its segments; a file read by byte ranges is there once.
 * Given the master's own address (`at`), also `folders`: where it keeps its subtitle playlists, when
 * that is a folder of their own inside the stream's (see ownCaption).
 */
export function hlsParts(pl, at = '') {
  if (!pl) return { keys: [], patterns: [] };
  if (pl.type === 'master') {
    const home = at ? folderOf(dedupeKey(at)) : '';
    // (A folder inside the stream's own: one beside it, or the server's top folder, may hold other videos' captions.)
    const folders = home ? [...new Set(pl.subtitles.map((s) => folderOf(dedupeKey(s.url || ''))).filter((f) => f && f !== home && f.startsWith(home)))] : [];
    // (Each playlist also by its path alone: see isPart.)
    const lists = [...pl.variants, ...pl.audio, ...pl.subtitles].map((x) => x.url).filter(Boolean).map(dedupeKey);
    return { keys: [...new Set([...lists, ...lists.map(barePlaylist).filter(Boolean)])], patterns: [], ...(folders.length ? { folders } : {}) };
  }
  const parts = partsOf((pl.segments || []).map((s) => s.url));
  if (pl.init?.url) {
    const k = dedupeKey(pl.init.url);
    if (!parts.keys.includes(k)) parts.keys.unshift(k);
  }
  return parts;
}

/**
 * The parts of a parsed DASH manifest (lib/dash.js): for every video, sound and text track its init file
 * and its segments, however they are written (SegmentTemplate, SegmentList, or one file under BaseURL
 * read through SegmentBase).
 */
export function dashParts(mpd) {
  const out = { keys: [], patterns: [] };
  const seen = new Set();
  for (const rep of [...(mpd?.video || []), ...(mpd?.audio || []), ...(mpd?.subtitles || [])]) {
    if (rep.init?.url) seen.add(dedupeKey(rep.init.url));
    const shape = rep.pattern ? patternKey(rep.pattern) : null;
    if (shape) {
      if (!out.patterns.some((p) => p[0] === shape[0] && p[1] === shape[1])) out.patterns.push(shape);
      continue;
    }
    const own = partsOf((rep.segments || []).map((s) => s.url));
    own.keys.forEach((k) => seen.add(k));
    out.patterns.push(...own.patterns);
  }
  out.keys = [...seen];
  return out;
}

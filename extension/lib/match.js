// Is a detected video already downloaded? Shared by the service worker and the popup.
// Works from content first (size, length), so renamed files are still recognised; then from the video's
// id or its own name in the file name, for files saved by other tools or before StreamSnag kept a record.
import { docExtOf } from './files.js';

const MIN_SIZE = 256 * 1024;

/**
 * Is this job/history record about this media item? Matches by item, by any URL the item was seen under
 * (signed links change), by identical file size, or by the same stream contents.
 */
export function sameItem(m, rec) {
  if (!m || !rec) return false;
  if (rec.mediaId && rec.mediaId === m.id) return true;
  if (rec.mediaUrl && rec.mediaUrl === m.url) return true;
  const keys = [m.key, ...(m.aliases || [])].filter(Boolean);
  if (rec.mediaKeys?.some((k) => keys.includes(k))) return true;
  if (m.kind === 'direct' && m.size > MIN_SIZE && rec.mediaSize === m.size) return true;
  if (m.fingerprint && rec.fingerprint === m.fingerprint) return true;
  // Signed links change on every visit, but the video's own file id inside them doesn't.
  const mine = m.kind === 'subtitle' ? [] : contentIds([m.url, m.key, ...(m.aliases || []), m.fingerprint]);
  return mine.length > 0 && contentIds([rec.mediaUrl, ...(rec.mediaKeys || []), rec.fingerprint]).some((id) => mine.includes(id));
}

/**
 * The files a page's videos are shown as downloaded from: the file the folder scan found for each, or, before
 * a scan has found it, every file StreamSnag recorded saving for it. (Not your own marks, nor a file the scan
 * already knows is gone.) Opening StreamSnag checks these are still there, so a file deleted a moment ago is
 * not shown as downloaded until the next scan.
 */
export function savedPathsOf(media = [], history = [], max = 20) {
  const out = new Set();
  for (const m of media) {
    if (!m || m.mark || m.kind === 'subtitle') continue;
    if (m.library) {
      if (m.library.path && !m.library.missing) out.add(m.library.path);
      continue;
    }
    for (const h of history) if (sameItem(m, h)) for (const o of h.outputs || []) if (o?.path) out.add(o.path);
  }
  return [...out].slice(0, max);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Ids of the video file itself, read from its URLs: CDNs like Vimeo's put a per-video UUID in every link
 * (".../c5c7e357-a526-.../v2/playlist/..."), while the signature, expiry and host change each visit.
 */
export function contentIds(urls) {
  const out = new Set();
  for (const u of urls) {
    if (!u) continue;
    let s = String(u);
    try { s = decodeURIComponent(s); } catch { /* keep as is */ }
    if (/\.(vtt|srt|ttml)(\?|$)/i.test(s)) continue; // a subtitle file is not the video
    if (docExtOf(String(u))) continue; // nor are the slides or handout saved from the same folder
    for (const id of s.match(UUID) || []) out.add(id.toLowerCase());
  }
  return [...out];
}

/**
 * Duration tolerance. A merged MP4 rarely has exactly the playlist's length (audio and video tracks end a
 * few frames apart, the first segment may start late), so allow about a second; whole-second durations
 * (Vimeo's player config) were rounded, so allow a little more.
 */
function lengthMatches(want, have, tol = Number.isInteger(want) ? 1.6 : 1.1) {
  if (!(want > 0) || !(have > 0)) return false;
  return Math.abs(want - have) <= tol;
}

// Words a file name picks up that aren't part of the video's name: qualities, codecs, copy counters.
const NOISE = /^(\d{3,4}p|[48]k|hd|sd|fhd|uhd|hq|avc|h264|h265|hevc|x264|x265|aac|mp4|audio|video|copy|final|\d{3,5}x\d{3,5})$/;

/** A video or file name reduced to its words, so "Day 2 – Keynote [123] - 1080p (1).mp4" ≈ "Day 2: Keynote". */
export function nameKey(s) {
  return String(s || '')
    .replace(/^.*[\\/]/, '') // folder
    .replace(/\.[a-z0-9]{2,4}$/i, '') // extension
    .replace(/\[[^\]]*\]/g, ' ') // a download tool's "[id]"
    .replace(/\(\d{1,3}\)/g, ' ') // Windows "(1)" copies
    .replace(/^\s*\d{1,4}\s*[-.)_]\s+/, '') // playlist index "003 - "
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE.test(w))
    .join(' ');
}

// Small words that say nothing about which video it is.
const STOP = new Set('a an and the of for in on to with by at from or vs is are be it its as your you what how do does we our this that'.split(' '));

/** A leading lecture/episode number: "009 Sepsis", "12 - Intro", "033." (not "2026-11-02" or "10:30"). */
export function leadNumber(s) {
  const base = String(s || '').replace(/^.*[\\/]/, '');
  const n = /^\s*(?:(?:lecture|lec|episode|ep|part|session|video|no|#)\.?\s*)?(\d{1,3})(?![\d:.,/-]\d)(?!\d)/i.exec(base)?.[1];
  return n == null ? null : Number(n);
}

const indexes = new WeakMap();

/** Words in each file name, and how many files share each word (words in most of them name the course). */
function folderIndex(files) {
  let ix = indexes.get(files);
  if (ix) return ix;
  const df = new Map();
  const entries = files.map((f) => {
    const raw = f.name || String(f.path || '').replace(/^.*[\\/]/, '');
    const key = nameKey(raw);
    const words = new Set(key.split(' ').filter(Boolean));
    words.forEach((w) => df.set(w, (df.get(w) || 0) + 1));
    return { f, key, words, lead: leadNumber(raw) };
  });
  ix = { entries, df, common: Math.max(3, files.length * 0.2) };
  indexes.set(files, ix);
  return ix;
}

/**
 * Files whose name says they are this video. The words that tell this video apart (not the course name
 * repeated in every file, not dates or small words) must all be in the file name; a lecture number, when
 * both have one, must agree and settles ties ("043 ... Part I" vs "044 ... Part II").
 */
function filesNamed(title, files) {
  const key = nameKey(title);
  if (key.length < 6 || key.split(' ').length < 2) return [];
  const { entries, df, common } = folderIndex(files);
  const lead = leadNumber(title);
  // The lecture number is compared on its own (it may or may not survive in the words: "009 - X" vs "009 X").
  const words = [...new Set(key.split(' '))].filter((w) => !STOP.has(w) && !(lead != null && /^\d+$/.test(w) && Number(w) === lead));
  // Dates and the course name repeat across the folder; "Day 2" vs "Day 3" does not.
  const telling = words.filter((w) => (df.get(w) || 0) <= common);
  const exact = entries.filter((e) => e.key === key || (e.key.length >= 40 && key.startsWith(e.key))); // same name, or cut short
  if (exact.length) return exact.map((e) => e.f);
  const hits = [];
  for (const e of entries) {
    if (lead != null && e.lead != null && lead !== e.lead) continue; // 029 is never 033
    if (!telling.length) continue;
    const found = telling.filter((w) => e.words.has(w)).length;
    const all = found === telling.length || (telling.length >= 4 && found / telling.length >= 0.8);
    if (!all) continue;
    const sameLead = lead != null && lead === e.lead;
    const rare = telling.length === 1 && (df.get(telling[0]) || 0) === 1 && telling[0].length >= 6;
    if (telling.length >= 2 || sameLead || rare) hits.push({ e, sameLead, full: found === telling.length });
  }
  // The same lecture number beats everything; then files with every telling word ("Part I" vs "Part II").
  const numbered = hits.filter((x) => x.sameLead);
  const full = hits.filter((x) => x.full);
  return (numbered.length ? numbered : full.length ? full : hits).map((x) => x.e.f);
}

/**
 * Does this file's name say it is a different video? A different lecture number, or a descriptive name
 * that shares none of the words that tell this video apart. (A bare "video (3).mp4" contradicts nothing.)
 */
export function nameContradicts(title, f, files) {
  const raw = f.name || String(f.path || '').replace(/^.*[\\/]/, '');
  const lead = leadNumber(title);
  const fileLead = leadNumber(raw);
  if (lead != null && fileLead != null && lead !== fileLead) return true;
  const { df, common } = folderIndex(files);
  const key = nameKey(title);
  const telling = [...new Set(key.split(' '))].filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w) && (df.get(w) || 0) <= common);
  const fileWords = new Set(nameKey(raw).split(' ').filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w) && (df.get(w) || 0) <= common));
  return telling.length >= 2 && fileWords.size >= 2 && !telling.some((w) => fileWords.has(w));
}

/** Several hits that are really one file saved twice (same size): treat as one. */
function onlyOne(hits) {
  if (hits.length === 1) return hits[0];
  if (hits.length > 1 && hits.every((f) => f.size === hits[0].size)) return hits[0];
  return null;
}

/** Of several files about as long as the stream, one that is clearly the closest (lectures often differ by under a second). */
function clearlyClosest(hits, want) {
  if (hits.length < 2) return null;
  const by = [...hits].sort((a, b) => Math.abs(a.duration - want) - Math.abs(b.duration - want));
  const d0 = Math.abs(by[0].duration - want);
  const d1 = Math.abs(by[1].duration - want);
  return d0 <= 0.35 && d1 >= d0 * 2 + 0.3 ? by[0] : null;
}

/** The video service's own id, when the item came from (or is) an embedded player. */
export function serviceId(m) {
  if (m.embedId && /^[\w-]{6,}$/.test(m.embedId)) return m.embedId;
  const u = String(m.embedUrl || m.url || '');
  return /vimeo\.com\/(?:video\/)?(\d{6,})(?:[/?#]|$)/i.exec(u)?.[1]
    // @site-edition
    || /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|shorts\/|watch\?(?:.*&)?v=)|youtu\.be\/)([\w-]{11})/i.exec(u)?.[1]
    // @end-site-edition
    || /wistia\.(?:net|com)\/(?:embed\/)?(?:iframe|medias)\/([a-z0-9]{8,})/i.exec(u)?.[1]
    || '';
}

/**
 * Look for this media item among the files in the user's folders.
 * @param m        detected media item
 * @param history  download history entries ({outputs:[{path,size}], mediaKeys, ...})
 * @param files    [{path, name, size, duration?}] from the folder scan
 * @param scannedDirs folders the scan covered (to tell "deleted" from "not scanned")
 * @param scannedAt  when that scan started: a file saved after it can't be in it yet
 * @param opts.nameIsUnique  false when other items on the page share this name (then a name proves nothing)
 * @returns {{path, how:'history'|'renamed'|'id'|'size'|'length'|'name', probable?:true} | {missing:true, path} | null}
 *          `probable`: only the length agrees, so it may be this video: never shown as downloaded.
 */
export function findInLibrary(m, history = [], files = [], scannedDirs = [], scannedAt = Infinity, opts = {}) {
  if (!m || m.kind === 'subtitle' || !files) return null;
  const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
  const bySize = new Map();
  for (const f of files) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  const fileName = (f) => f.name || String(f.path || '').replace(/^.*[\\/]/, '');
  // 1. We saved it before: the exact file size we recorded is still in the folder (renames keep it).
  const mine = history.filter((h) => sameItem(m, h));
  for (const h of mine) {
    for (const o of h.outputs || []) {
      if (!(o.size > 0)) continue;
      const hits = bySize.get(o.size) || [];
      const hit = hits.find((f) => norm(f.path) === norm(o.path)) || hits[0];
      if (hit) return { path: hit.path, how: norm(hit.path) === norm(o.path) ? 'history' : 'renamed' };
    }
  }
  // 2. Many download tools put the video's id in the name: "Keynote [123456789].mp4".
  const id = m.playlist ? '' : serviceId(m);
  if (id) {
    const hit = files.find((f) => fileName(f).includes(`[${id}]`));
    if (hit) return { path: hit.path, how: 'id' };
  }
  // 3. A single-file video: a file of exactly the same size.
  if (m.kind === 'direct' && m.size > MIN_SIZE) {
    const hit = (bySize.get(m.size) || [])[0];
    if (hit) return { path: hit.path, how: 'size' };
  }
  const want = m.info?.duration || m.duration;
  const live = !!m.info?.live;
  // A name is only evidence when it names this video, not the whole site or course.
  const title = m.customName || (m.nameSource && m.nameSource !== 'title' ? m.title : '');
  const named = !m.playlist && opts.nameIsUnique !== false && title ? filesNamed(title, files) : [];
  // 4. A stream: one video in the folder with the same length (the name, or a clearly closer length, settles a tie).
  //    Lectures can be within a fraction of a second of each other, so a file whose name clearly says it is
  //    another lecture ("012 Interstitial Lung..." for "009: C. diff") never counts.
  //    The length alone proves nothing (two films of 10:35 are not the same film): only together with the
  //    file's name is it "found". A lone file of the same length is reported as `probable`, for a note.
  let probable = null;
  if ((m.kind === 'hls' || m.kind === 'dash' || m.kind === 'embed') && want > 20 && !live) {
    const hits = files.filter((f) => lengthMatches(want, f.duration) && !(title && nameContradicts(title, f, files)));
    const sure = onlyOne(hits.filter((f) => named.includes(f)));
    if (sure) return { path: sure.path, how: 'length' };
    const maybe = onlyOne(hits) || clearlyClosest(hits, want);
    if (maybe) probable = { path: maybe.path, how: 'length', probable: true };
  }
  // 5. The file carries this video's own name, and nothing contradicts it (a known, different length).
  if (named.length) {
    const fits = named.filter((f) => !(want > 20 && f.duration > 0 && !live && !lengthMatches(want, f.duration, 3)));
    const hit = onlyOne(fits);
    if (hit) return { path: hit.path, how: 'name' };
  }
  // Saved before, folder was scanned, and nothing matches: it was deleted or moved elsewhere.
  const saved = mine.filter((h) => !(h.at > scannedAt)).flatMap((h) => (h.outputs || []).map((o) => o.path)).filter(Boolean);
  const dirs = scannedDirs.map(norm);
  const lost = saved.find((p) => dirs.some((d) => norm(p).startsWith(d.endsWith('\\') ? d : `${d}\\`)));
  if (lost) return { missing: true, path: lost };
  return probable;
}

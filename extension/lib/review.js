// "Review before downloading": which of a page's videos are ready to download, which deserve a second
// look (and why), and which can't be downloaded at all. Pure: the popup's review sheet and the small tags
// in its list both use it, and the tests run it on its own.
//
// An item here is a plain description of one listed video:
//   { id, name, borrowed, url, duration, kind, mediaType, playlist, protected, live, height, size, order, status }
// `name` is the video's own name (your rename, or what the page calls it; '' when it has none), `borrowed`
// says that name is only the tab's title, `order` is its place on the page, and `status` is the list's
// 'new' | 'failed' | 'missing' | 'active' | 'queued' | 'done'.
import { splitLecture, hostOf, siteKey, registrableDomain } from './util.js';
import { canBulkDownload } from './quality.js';

/**
 * Why a video might not be wanted: the label in the review sheet, and the small tag in the list (the same
 * plain words in both places; 'appeared' only happens on the sheet).
 */
export const REASONS = {
  copy: { label: 'Same as another one', tag: 'Same as another one' },
  sound: { label: 'The same lecture, sound only', tag: 'The same lecture, sound only' },
  promo: { label: 'Looks like a preview or ad', tag: 'Looks like a preview or ad' },
  short: { label: 'Short clip', tag: 'Short clip' },
  audio: { label: 'Sound only', tag: 'Sound only' },
  samename: { label: 'Same name as another one', tag: 'Same name as another one' },
  noname: { label: 'No name', tag: 'No name' },
  appeared: { label: 'Just appeared', tag: '' },
};

/** Why a video can't be downloaded from the sheet, in plain words. */
export const BLOCKED = {
  protected: 'Protected by the site, so it can\'t be saved.',
  live: 'Live stream: record it from its own card.',
  playlist: 'A playlist: list its videos from its own card.',
  unreadable: 'The link may have expired. Reload the page and press play.',
  slow: 'Reading it took too long. Close this and try again.',
  other: 'StreamSnag can\'t download this one from here.',
};

const SHORT_CLIP = 60; // seconds: "a short clip" next to real lectures
const LONG_VIDEO = 300; // a page with a video this long is a page of lectures
const SHORT_SHARE = 0.2; // or: under a fifth of the usual length on the page
const BRIEF = 120; // a "preview" that is not the first word of a name only counts on something this short
const SAME_LENGTH = 1; // seconds apart at most, for two items to be the same video

const lengthOf = (x) => (Number(x?.duration) > 0 ? Number(x.duration) : 0);
const norm = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Words a player or a page puts where a name should be.
const GENERIC = new Set(['video', 'videos', 'player', 'videoplayer', 'mediaplayer', 'untitled', 'untitledvideo', 'movie', 'clip',
  'media', 'stream', 'file', 'embed', 'index', 'master', 'playlist', 'manifest', 'default', 'unknown', 'noname', 'notitle',
  'null', 'undefined', 'watch', 'blank', 'loading']);

/**
 * Ordinary words joined by hyphens or underscores, as a file is often named ("fosdem-2024-2483-citrineos",
 * "37c3-12142-eng-Breaking_DRM_in_Polish_trains"): every part is letters alone or digits alone and one is
 * a word; or at least three parts are words and they make up most of it. An id mixes letters and digits
 * in its parts: "Video-7bad5878-1561-4a12_processed" is still an id, words at its ends or not.
 */
function wordy(bare) {
  const parts = bare.split(/[_.-]+/).filter(Boolean);
  const words = parts.filter((p) => /^\p{L}{3,}$/u.test(p));
  if (parts.length > 1 && words.length && parts.every((p) => /^(?:\p{L}+|\p{N}+)$/u.test(p))) return true;
  return words.length >= 3 && words.join('').length >= 0.6 * parts.join('').length;
}

/**
 * Is this a name a person would recognise the video by? Not when it is empty, only a number, a generic
 * word ("video", "Player", "Untitled 2"), the site's own name ("example.com", "Example"), or a machine-made
 * id ("9f8a3c21d07b", a long run of letters and digits without spaces).
 */
export function usableName(name, { url = '', site = '' } = {}) {
  const raw = String(name || '').trim();
  const n = norm(raw);
  if (!n) return false;
  const words = n.replace(/\p{N}+/gu, '');
  if (!words || GENERIC.has(words)) return false;
  const host = (site || hostOf(url) || '').toLowerCase();
  if (host) {
    const own = registrableDomain(host);
    if ([host, siteKey(host), own, own.split('.')[0]].some((h) => norm(h) === n)) return false;
  }
  const bare = raw.replace(/\.[a-z0-9]{2,5}$/i, '');
  if (!/\s/.test(bare) && !wordy(bare)) {
    const id = bare.replace(/[_-]+/g, '');
    if (/^[0-9a-f]{8,}$/i.test(id) && /\d/.test(id)) return false;
    if (/^[a-z0-9]{16,}$/i.test(id) && /\d/.test(id) && /[a-z]/i.test(id)) return false;
  }
  return true;
}

const PROMO_WORD = '(?:trailer|preview|promo|teaser|advert|sponsor|bumper|sample)';
// A whole word: "sample", not "samples" or "resample". "_" and "-" end a word (they do in file names).
const PROMO_ANY = new RegExp(`(?<![\\p{L}\\p{N}])${PROMO_WORD}(?![\\p{L}\\p{N}])`, 'iu');
const PROMO_FIRST = new RegExp(`^[^\\p{L}\\p{N}]*${PROMO_WORD}(?![\\p{L}\\p{N}])`, 'iu');

/**
 * Does the name or the address say "trailer", "preview", "promo", "teaser", "advert", "sponsor", "bumper"
 * or "sample"? Only as a whole word ("sample", not "Samples of tissue"). A real lecture can have such a
 * word in its name ("Tissue sample preparation", "Sample size calculation"), so it only counts
 *  - as the first word (after a lecture number: "03 - Preview of week 4"; for an address: the start of the
 *    file's name), unless the video is known to be long (five minutes or more), or
 *  - anywhere, when the video is brief (under two minutes).
 */
export function looksLikePromo(item) {
  const d = lengthOf(item);
  const brief = d > 0 && d < BRIEF;
  const long = d >= LONG_VIDEO;
  const name = splitLecture(item?.name).name;
  if ((!long && PROMO_FIRST.test(name)) || (brief && PROMO_ANY.test(name))) return true;
  let path = '';
  try {
    path = decodeURIComponent(new URL(item?.url).pathname);
  } catch { /* no address to read */ }
  const file = path.split('/').pop() || '';
  return (!long && PROMO_FIRST.test(file)) || (brief && PROMO_ANY.test(path));
}

/** Does this item have a name of its own (not just the tab's title, the site, or an id)? */
function named(x, site) {
  return !x.borrowed && usableName(x.name, { url: x.url, site });
}

/**
 * The ids of the items much shorter than the rest: under a minute on a page that also has a video of five
 * minutes or more, or (with at least three known lengths) under a fifth of the usual length. Never on a
 * page where every video is under a minute: there, short is normal.
 */
function shortOnes(items) {
  const lengths = items.map(lengthOf).filter(Boolean);
  const out = new Set();
  if (!lengths.length || Math.max(...lengths) < SHORT_CLIP) return out;
  const hasLong = Math.max(...lengths) >= LONG_VIDEO;
  const usual = lengths.length >= 3 ? median(lengths) : 0;
  for (const x of items) {
    const d = lengthOf(x);
    if (d && ((d < SHORT_CLIP && hasLong) || (usual && d < SHORT_SHARE * usual))) out.add(x.id);
  }
  return out;
}

// A file that plays everywhere is the one to keep of two that are otherwise alike.
const oddFile = (x) => Number(x.kind === 'direct' && !!x.ext && String(x.ext).toLowerCase() !== 'mp4');

/**
 * The items that are one lecture a second time: Map of id → 'copy' | 'samename'. One file per lecture is
 * kept: the one with a name, then a player's video before a file the page only links to, video before
 * sound, the higher quality, an MP4 before another type, the bigger file, the one listed first.
 *  - 'copy': the same video as a better one on the list: the same length (within about a second) and the
 *    same name, or one of the two has no name of its own; or the same name where a length is not known
 *    (the same lecture offered as .mp4 and as .ogv).
 *  - 'samename': the same name as one that is kept, at another length (or two embedded players of one
 *    name). It may be a different recording, but two of one name are worth a look before both are saved.
 */
function copies(items, site) {
  const best = items.map((x, i) => ({ x, i, named: named(x, site) })).sort((a, b) =>
    Number(b.named) - Number(a.named)
    || Number(!!a.x.linked) - Number(!!b.x.linked)
    || Number(a.x.mediaType === 'audio') - Number(b.x.mediaType === 'audio')
    || (Number(b.x.height) || 0) - (Number(a.x.height) || 0)
    || oddFile(a.x) - oddFile(b.x)
    || (Number(b.x.size) || 0) - (Number(a.x.size) || 0)
    || (a.x.order ?? 0) - (b.x.order ?? 0) || a.i - b.i);
  const kept = [];
  const out = new Map();
  for (const c of best) {
    const d = lengthOf(c.x);
    const namesake = (k) => k.named && c.named && norm(k.x.name) === norm(c.x.name);
    // (Two embedded players are two videos, whatever they are called: a player's address is its video's.)
    const players = (k) => k.x.kind === 'embed' && c.x.kind === 'embed';
    const twin = kept.find((k) => (d && lengthOf(k.x)
      ? Math.abs(lengthOf(k.x) - d) <= SAME_LENGTH && (!k.named || !c.named || namesake(k))
      : namesake(k) && !players(k)));
    if (twin) out.set(c.x.id, 'copy');
    else if (kept.some(namesake)) out.set(c.x.id, 'samename');
    else kept.push(c);
  }
  return out;
}

/**
 * Why each video on a page might not be wanted: Map of id → 'copy' | 'promo' | 'short' | 'audio' |
 * 'samename' | 'noname' (see REASONS), one reason each, the most telling first. Empty for a page with a single video:
 * there is nothing to compare it with. The same holds when everything else on the page is that one video
 * again: its copies are marked, and the video itself is not ("a preview" of what, when it is all there is?).
 *  - 'audio': a sound file on a page that also has videos.
 *  - 'noname': no name of its own while at least as many of the page's videos do have one (when most have
 *    no name, that is just how the page is, and nothing is flagged).
 *  - 'copy' also for the one file a page links to for download (`linked`) next to its one player: the
 *    "Download video" link of a lecture is that lecture again.
 *  - 'sound': such a copy that is a sound file, of a lecture the page has as a video: not a second copy
 *    of the video, but the same lecture to listen to.
 */
export function flagItems(items, { site = '' } = {}) {
  const list = (items || []).filter((x) => x && x.kind !== 'subtitle' && !x.playlist);
  const out = new Map();
  if (list.length < 2) return out;
  const short = shortOnes(list);
  const copy = copies(list, site);
  const links = list.filter((x) => x.linked);
  if (links.length === 1 && list.length === 2) copy.set(links[0].id, 'copy');
  const hasVideo = list.some((x) => x.mediaType !== 'audio');
  const nameless = list.filter((x) => !named(x, site));
  const flagNameless = nameless.length > 0 && list.length - nameless.length >= nameless.length;
  const alone = list.filter((x) => copy.get(x.id) !== 'copy').length < 2; // one video, and copies of it
  for (const x of list) {
    const why = copy.get(x.id) === 'copy' ? (x.mediaType === 'audio' && hasVideo ? 'sound' : 'copy')
      : alone ? ''
      : looksLikePromo(x) ? 'promo'
        : short.has(x.id) ? 'short'
          : x.mediaType === 'audio' && hasVideo ? 'audio'
            : copy.get(x.id) === 'samename' ? 'samename'
              : flagNameless && nameless.includes(x) ? 'noname' : '';
    if (why) out.set(x.id, why);
  }
  return out;
}

/**
 * Course order: videos with a lecture number in their name first, by that number ("002" before "010"),
 * then the ones without, in the order they are on the page. Equal numbers keep their page order.
 */
export function courseOrder(items) {
  const numberOf = (x) => {
    const n = splitLecture(x.name).number;
    return n === '' ? null : Number(n);
  };
  return (items || []).map((x, i) => ({ x, i, n: numberOf(x) })).sort((a, b) =>
    Number(a.n == null) - Number(b.n == null)
    || (a.n ?? 0) - (b.n ?? 0)
    || (a.x.order ?? 0) - (b.x.order ?? 0)
    || a.i - b.i).map(({ x }) => x);
}

/** Why this item can't be downloaded from the sheet, or null. `plan`: what the worker said about it, if it has. */
function blockOf(x, plan) {
  const why = x.protected ? 'protected' : x.live ? 'live' : x.playlist ? 'playlist'
    : !canBulkDownload({ kind: x.kind, mediaType: x.mediaType }) ? 'other' : '';
  if (why) return { why, reason: BLOCKED[why] };
  if (plan && plan.ok === false) {
    const known = Object.hasOwn(BLOCKED, plan.why) && plan.why !== 'other';
    return { why: known ? plan.why : 'other', reason: known ? BLOCKED[plan.why] : plan.reason || BLOCKED.other };
  }
  return null;
}

/**
 * The review sheet's groups, each in course order:
 *   { ready: [{id}], check: [{id, reason}], blocked: [{id, why, reason}], have, busy }
 * `ready` is what gets downloaded unless you untick it; `check` is offered unticked, each with a key of
 * REASONS; `blocked` can't be downloaded (`reason` is the sentence to show). `have` counts the videos
 * already in your folders and `busy` the ones downloading now: neither is offered again.
 * Options: `flags` (a Map from flagItems, e.g. worked out over the whole page; by default over `items`),
 * `plans` (Map of id → the worker's answer {ok, why, reason}), and `known` (the ids on the sheet when it
 * opened: anything else turned up since and goes last under `check` as 'appeared').
 */
export function reviewGroups(items, { flags = null, plans = null, known = null } = {}) {
  const list = (items || []).filter((x) => x && x.kind !== 'subtitle');
  const why = flags || flagItems(list);
  const out = { ready: [], check: [], blocked: [], have: 0, busy: 0 };
  const late = [];
  for (const x of courseOrder(list)) {
    if (x.status === 'done') { out.have++; continue; }
    if (x.status === 'active' || x.status === 'queued') { out.busy++; continue; }
    const block = blockOf(x, plans?.get(x.id));
    if (block) out.blocked.push({ id: x.id, ...block });
    else if (known && !known.has(x.id)) late.push({ id: x.id, reason: 'appeared' });
    else if (why.has(x.id)) out.check.push({ id: x.id, reason: why.get(x.id) });
    else out.ready.push({ id: x.id });
  }
  late.sort((a, b) => (list.find((x) => x.id === a.id).order ?? 0) - (list.find((x) => x.id === b.id).order ?? 0));
  out.check.push(...late);
  return out;
}

/**
 * "Number them in page order": for the selected videos [{id, name}] (in the order they will be saved),
 * the names of the ones without a lecture number, numbered from 01: Map of id → "01 - Name". Offered
 * (`eligible`) when at least three of them have no number; with fewer there is nothing to put in order.
 * Videos that already have a number keep their name.
 */
export function numberNames(rows) {
  const plain = (rows || []).filter((r) => !splitLecture(r.name).number);
  const eligible = plain.length >= 3;
  const width = Math.max(2, String(plain.length).length);
  const names = new Map(eligible ? plain.map((r, i) => [r.id, `${String(i + 1).padStart(width, '0')} - ${r.name}`]) : []);
  return { eligible, names };
}

/**
 * The ids of the rows [{id, folder, filename}] whose file would get the same name, in the same folder, as
 * an earlier row's: the browser then adds "(1)" to it, so the sheet says so.
 */
export function sameFileNames(rows) {
  const seen = new Set();
  const out = new Set();
  for (const r of rows || []) {
    if (!r.filename) continue;
    const key = `${r.folder || ''}/${r.filename}`.toLowerCase();
    if (seen.has(key)) out.add(r.id);
    seen.add(key);
  }
  return out;
}

/**
 * A file name in two parts, for a line that is cut in the middle when it doesn't fit: the end (quality
 * and type, " - 720p.mp4") always stays in view, and the start keeps the lecture number.
 */
export function splitName(filename) {
  const chars = [...String(filename || '')];
  const dot = chars.lastIndexOf('.');
  const ext = dot > 0 && chars.length - dot <= 6 ? chars.length - dot : 0;
  const tail = Math.min(14, ext + 7);
  if (chars.length <= tail + 12) return [chars.join(''), ''];
  return [chars.slice(0, -tail).join(''), chars.slice(-tail).join('')];
}

/** The folders a download goes through, outermost first: ["Videos", "StreamSnag", "learn.example.com"]. */
export function folderTrail(rootLabel, folder) {
  return [rootLabel || 'Downloads', ...String(folder || '').split('/').filter(Boolean)];
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The sheet's one-line summary: "12 videos selected · 3 need a look · 1 can't be downloaded".
 * `noun`: what the selected recordings are ("video", "audio file", "recording"); `only`: 'files' when the
 * sheet is about the page's files alone (then no videos are counted at all).
 */
export function reviewSummary({ selected = 0, files = 0, check = 0, blocked = 0, noun = 'video', only = '' } = {}) {
  const what = [(selected || !files) && only !== 'files' ? plural(selected, noun) : '', files || only === 'files' ? plural(files, 'file') : ''].filter(Boolean).join(' and ');
  return [
    selected || files ? `${what} selected` : 'Nothing selected',
    check ? `${check} ${check === 1 ? 'needs' : 'need'} a look` : '',
    blocked ? `${blocked} can't be downloaded` : '',
  ].filter(Boolean).join(' · ');
}

const DOC_WORDS = {
  pdf: 'PDFs', ppt: 'slides', pptx: 'slides', pps: 'slides', ppsx: 'slides', key: 'slides', odp: 'slides',
  doc: 'documents', docx: 'documents', odt: 'documents', rtf: 'documents', pages: 'documents',
  xls: 'spreadsheets', xlsx: 'spreadsheets', csv: 'spreadsheets', ods: 'spreadsheets', numbers: 'spreadsheets',
  epub: 'books', zip: 'zip files', ipynb: 'notebooks',
};

/** What kinds of documents these are, for "Also download 5 files (PDFs, slides)": at most three kinds. */
export function docKinds(docs) {
  return [...new Set((docs || []).map((d) => DOC_WORDS[String(d?.ext || '').toLowerCase()]).filter(Boolean))].slice(0, 3).join(', ');
}

// Why a video is not what the page is about: a clip much shorter than the rest, a preview or an ad, or
// a second copy of a video that is listed in a better file.
const ASIDE = new Set(['short', 'promo', 'copy', 'sound']);

/**
 * The video for the popup's big card: { id, why } ('playing' | 'paused' | ''), or null when there is none.
 * The one playing in the page (or paused there), else the one already in front (`kept`), else the newest.
 * A short clip, an ad or a second copy (`flags`: what flagItems says of each id) is passed over while the
 * page has a video that is none of these: a pre-roll that starts playing never pushes the lecture off the
 * card, and the best file of a video stands in front of its smaller copies.
 * On a page that only links to its videos, lists them or embeds players that have loaded nothing, nothing says which
 * one is meant: the first in the page's order is in front (`candidates` come in that order), not whichever
 * link happened to answer last.
 */
export function heroChoice(candidates, { playing = null, kept = '', flags = new Map() } = {}) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return null;
  // (Nor is a file the page only links to or lists what is in front, while a player on it has a video loaded.)
  const main = list.filter((m) => !ASIDE.has(flags.get(m.id)) && !m.linked && !m.listed);
  const pool = main.length ? main : list;
  const watching = playing && pool.find((m) => m.id === playing.id);
  if (watching) return { id: watching.id, why: playing.playing ? 'playing' : 'paused' };
  // (Nor does a player that has loaded nothing StreamSnag can see: when it was found says nothing of what is being watched.)
  const loaded = pool.some((m) => !m.linked && !m.listed && m.kind !== 'embed');
  const hero = pool.find((m) => m.id === kept) || (loaded ? pool.reduce((a, b) => ((b.detectedAt || 0) > (a.detectedAt || 0) ? b : a)) : pool[0]);
  return { id: hero.id, why: '' };
}

// ---------------------------------------------------------------- folded away in the list
// A second copy, the same lecture as sound only, a preview or ad, a short clip: in the popup's list (and the
// side panel's) these fold into one quiet line at the end ("2 more hidden: a copy and a preview · Show").
// They stay exactly as they are for "Download all" and the review sheet (under "Check these", unticked).

/** The flags that fold an item away (the same ones that keep it off the big card: heroChoice). */
export const FOLDED = Object.freeze(['copy', 'sound', 'promo', 'short']);

/**
 * Which listed items fold away: those flagged as one of FOLDED, never the big card's (`hero`), and none at
 * all when every item is flagged so (then they are what the page has) or when `showAll` (Settings: "Always
 * show everything", or "Show" on this page). `items`: [{ id, kind?, playlist? }]; `flags`: id -> reason.
 */
export function foldedIds(items, flags, { hero = '', showAll = false } = {}) {
  const out = new Set();
  if (showAll || !flags) return out;
  const list = (items || []).filter((x) => x && x.kind !== 'subtitle');
  const folds = (x) => FOLDED.includes(flags.get(x.id));
  if (list.every(folds)) return out;
  for (const x of list) if (folds(x) && x.id !== hero) out.add(x.id);
  return out;
}

const FOLD_WORDS = { copy: ['a copy', 'copies'], sound: ['a sound-only copy', 'sound-only copies'], promo: ['a preview', 'previews'], short: ['a short clip', 'short clips'] };

/** The one line for what is folded away: "2 more hidden: a copy and a preview" ('' when nothing is). */
export function foldLine(ids, flags) {
  const n = ids?.size ?? ids?.length ?? 0;
  if (!n) return '';
  const counts = new Map();
  for (const id of ids) {
    const why = flags?.get(id);
    if (FOLD_WORDS[why]) counts.set(why, (counts.get(why) || 0) + 1);
  }
  const parts = FOLDED.filter((k) => counts.has(k)).map((k) => (counts.get(k) === 1 ? FOLD_WORDS[k][0] : `${counts.get(k)} ${FOLD_WORDS[k][1]}`));
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || '';
  return `${n} more hidden${said ? `: ${said}` : ''}`;
}

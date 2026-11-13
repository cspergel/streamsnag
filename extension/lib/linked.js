// Media files a page only links to (a "Download video" button, a list of lectures to download). Nothing
// is asked of a link the page itself has not loaded until StreamSnag is opened on the tab: until then the
// links wait here as candidates. Also what such a file is called, and where it goes in the list.
// Pure, shared by the service worker and the tests.
import { isHttpUrl } from './util.js';
import { linkTitle, fileTitle, recordingKey, whenOnly } from './naming.js';
import { langCode } from './captions.js';
import { languageName } from './wording.js';

/**
 * Links kept for one frame; a page cannot grow what is stored for it past this. (A room's page of a
 * conference lists eighty recordings; each kept link costs one one-byte request when StreamSnag is opened.)
 */
export const MAX_LINKS = 150;
const words = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '');

/**
 * Remember one frame's links ({frameId: { items: [{url, label, row, near}], done, left }}). A frame always
 * reports its whole list, so this replaces what it said before; the same list again changes nothing (what
 * was found out about it stands), a different one is to be looked at again. `more`: how many further
 * links the frame says it has and did not send; with the ones over the limit here, that is `left`: the
 * links of this frame that are not looked at.
 */
export function noteLinks(byFrame, frameId, reported, more = 0) {
  const seen = new Set();
  const items = [];
  let over = 0;
  for (const it of Array.isArray(reported) ? reported : []) {
    if (typeof it?.url !== 'string' || it.url.length > 2000 || !isHttpUrl(it.url) || seen.has(it.url)) continue;
    seen.add(it.url);
    if (items.length >= MAX_LINKS) over += 1;
    else items.push({ url: it.url, label: words(it.label), row: words(it.row), near: words(it.near) });
  }
  const left = over + (Number.isInteger(more) && more > 0 ? Math.min(more, 100000) : 0);
  const next = { ...(byFrame || {}) };
  if (!items.length) delete next[frameId];
  else if (JSON.stringify(next[frameId]?.items) !== JSON.stringify(items)) next[frameId] = { items, done: false, left };
  else if ((next[frameId].left || 0) !== left) next[frameId] = { ...next[frameId], left };
  return next;
}

/**
 * How many linked files are still to be looked at. `never`: says of a link that it will not be asked at
 * all (an address on your own network from a public page; one past the page's limit): such a link is not
 * waiting for anything, and never counts.
 */
export function linksWaiting(byFrame, never = () => false) {
  return Object.values(byFrame || {}).reduce((n, set) => n + (set.done ? 0 : set.items.filter((it) => !never(it)).length), 0);
}

/** How many of a page's media links are not looked at: past a frame's limit (`left`), or past the page's (`skipped`). */
export function linksLeftOut(byFrame) {
  return Object.values(byFrame || {}).reduce((n, set) => n + (set.left || 0) + (set.skipped || 0), 0);
}

/**
 * What a linked file is called: { title, source }. The link's own words when they name it; else the row
 * it sits in (a lecture's number and title beside a link that only says "Download", the episode's title
 * beside a link that only says "Play"); else, among `several` such links, the file's own name. A lone "Download video" names nothing: that file is the
 * page's lecture, and takes the page's name for it.
 */
export function linkName({ url = '', label = '', row = '', near = '' } = {}, { several = false } = {}) {
  // (A listing of files cuts a long name short, "36c3-10497-deu-Messenger_Hacking_Remotely_Compr..>": the
  // file's own name, in its address, is whole.)
  if (/(?:\.{2,}|…)\s*>?$/.test(String(label).trim())) label = '';
  // (A row tells one file from the others: beside a page's only file stands what the page says of it, not its name.)
  // (`near`: the words of the row's main link, where the link itself only says "Play": an episode's or a
  // chapter's own title. A row that only says when it was recorded, how long it is or how big, names nothing.)
  const rowSays = several ? linkTitle(row) : '';
  const said = linkTitle(label) || (rowSays && !whenOnly(rowSays) ? rowSays : '') || (several ? linkTitle(near) : '');
  if (said) return { title: said, source: 'link' };
  const own = several ? fileTitle(url) : '';
  return own ? { title: own, source: 'file' } : { title: '', source: '' };
}

const flat = (s) => String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * A linked file known only by its own name ("37c3-12142-eng-Breaking DRM in Polish trains") on a page that
 * says what its talk is called ('Breaking "DRM" in Polish trains'): when the file's name holds the talk's
 * name word for word (three words or more of it, or fifteen letters), the file is that talk, and is called
 * by it. What tells one such file from the next is the language its name gives ("eng", "deu"): it is
 * added in words, "… (German)". '' when the file's name does not hold the page's.
 */
export function talkName(fileName, pageName) {
  const [file, talk] = [flat(fileName), flat(pageName)];
  if (!talk || (talk.split(' ').length < 3 && talk.replace(/ /g, '').length < 15)) return '';
  const at = ` ${file} `.indexOf(` ${talk} `);
  if (at < 0) return '';
  const rest = `${file.slice(0, at)} ${file.slice(at + talk.length)}`.split(' ').filter(Boolean);
  // (A three-letter code or a language's own name, never a two-letter word: "no", "is", "it" are words too.)
  const langs = [...new Set(rest.filter((w) => w.length >= 3 && langCode(w)).map((w) => languageName(langCode(w))).filter(Boolean))];
  const name = String(pageName).replace(/\s+/g, ' ').trim();
  return langs.length ? `${name} (${langs.join(', ')})` : name;
}

/**
 * Is a linked file, named by its link, a lecture the page's playlist already lists (an audiobook's
 * chapter as a bigger MP3 beside the player's own)? Then it is that lecture in another file: the `set`
 * of the one playlist entry with the same name and the same kind of media, '' when there is none (or
 * more than one). Sharing the set makes it one more choice of that lecture (lib/variants.js).
 */
export function sameLecture(media, m) {
  if (!m?.linked || m.nameSource !== 'link' || !m.title) return '';
  const name = m.title.toLowerCase();
  const twins = (media || []).filter((x) => x !== m && x.kind === 'direct' && x.nameSource === 'playlist' && !!x.set && !x.variantOf && !x.dismissed
    && x.mediaType === m.mediaType && String(x.title || '').toLowerCase() === name);
  return twins.length === 1 ? twins[0].set : '';
}

/**
 * Which of a page's linked files are one recording in several formats: Map of url → the key they share.
 * Files of the same kind (video with video, sound with sound) whose names differ only in what says how
 * they were encoded ("talk.av1.webm" and "talk.mp4"; "book_01_64kb.mp3" and "book_01.mp3"; a talk's MP3
 * and its Opus file), see recordingKey. Two files of exactly the same name are not told apart by their
 * format, so they are left alone; and so are files whose links name them differently. `items`:
 * [{ url, mediaType, title }] (`title`: what the link itself calls the file, '' when it says nothing).
 */
export function formatTwins(items) {
  const groups = new Map();
  for (const it of items || []) {
    const key = recordingKey(it.url);
    if (!key) continue;
    const id = `${it.mediaType === 'audio' ? 'audio' : 'video'}|${key}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(it);
  }
  const fileOf = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || '').toLowerCase(); } catch { return u; } };
  const out = new Map();
  for (const [id, members] of groups) {
    if (members.length < 2) continue;
    if (new Set(members.map((m) => fileOf(m.url))).size !== members.length) continue;
    if (new Set(members.map((m) => String(m.title || '').toLowerCase()).filter(Boolean)).size > 1) continue;
    for (const m of members) out.set(m.url, `twin:${id}`);
  }
  return out;
}

/** One plain line for the links that were not looked at ('' when none were): "12 more links on this page were left out. StreamSnag looks at the first 150 on a page." */
export function leftOutNote(left) {
  const n = Number(left) || 0;
  return n > 0 ? `${n} more link${n === 1 ? '' : 's'} on this page ${n === 1 ? 'was' : 'were'} left out. StreamSnag looks at the first ${MAX_LINKS} on a page.` : '';
}

const RANK = { hls: 0, dash: 0, direct: 1, embed: 1.5, subtitle: 2 };

/**
 * The list's order: streams, then files (the biggest first), embedded players, caption files. Files the
 * page only links to (a list of lectures) come after the ones it has loaded and stay in the page's own
 * order. `order`: every item's id in the order it was found, which is the order on the page.
 */
export function listSort(media, order) {
  const at = new Map((order || []).map((id, i) => [id, i]));
  const rank = (m) => (RANK[m.kind] ?? 3) + (m.kind === 'direct' && m.linked ? 0.25 : 0);
  return [...(media || [])].sort((a, b) => rank(a) - rank(b)
    || (a.linked && b.linked ? (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9) : (b.size || 0) - (a.size || 0)));
}

// "Files on this page": the documents a page links to (course slides, handouts, reading lists).
// Which links count, what each file is called, and whether it was downloaded before. Pure, shared by the
// service worker, the popup and the tests. The content script asks the worker for DOC_EXTS (it can't import).
import { sanitizeFilename, isHttpUrl } from './util.js';
import { dedupeKey } from './detect.js';

/**
 * The only file types ever offered or saved, with the short label on each row's tile. Documents only:
 * nothing a computer runs. A saved file's extension always comes from this list, never from the page.
 */
const DOC_TYPES = new Map([
  ['pdf', 'PDF'],
  ['ppt', 'PPT'], ['pptx', 'PPT'], ['pps', 'PPT'], ['ppsx', 'PPT'], ['key', 'KEY'], ['odp', 'ODP'],
  ['doc', 'DOC'], ['docx', 'DOC'], ['odt', 'ODT'], ['rtf', 'RTF'], ['pages', 'PAGES'],
  ['xls', 'XLS'], ['xlsx', 'XLS'], ['csv', 'CSV'], ['ods', 'ODS'], ['numbers', 'NUM'],
  ['epub', 'EPUB'], ['zip', 'ZIP'], ['ipynb', 'IPYNB'],
]);
export const DOC_EXTS = [...DOC_TYPES.keys()];

/** Most documents listed for one tab; a page cannot grow the list (or what is stored for it) past this. */
export const MAX_DOCS = 200;
const MAX_NAME = 120;
const MAX_URL = 2000;

/** "PDF", "PPT", "DOC"… for a whitelisted extension ('' for anything else). */
export function docLabel(ext) {
  return DOC_TYPES.get(String(ext || '').toLowerCase()) || '';
}

/**
 * The document type of a link: the whitelisted extension its path ends in, lower-cased, or ''. Only web
 * addresses count, and only the path: "notes.pdf.exe" is an exe, and "run.exe?name=a.pdf" is too.
 */
export function docExtOf(url) {
  if (typeof url !== 'string' || !isHttpUrl(url)) return '';
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return '';
  }
  const ext = /\.([a-z0-9]{1,8})$/i.exec(path)?.[1].toLowerCase() || '';
  return DOC_TYPES.has(ext) ? ext : '';
}

/** One document, however it is linked: "#page=2" and a fresh signature on the link don't make it another file. */
export function docKey(url) {
  return dedupeKey(url);
}

// Text and file names from a page: no control or direction-override characters, single spaces.
const tidy = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
// Cut by whole characters, so an emoji or accented letter is never split in half.
const clip = (s) => ([...s].length > MAX_NAME ? [...s].slice(0, MAX_NAME).join('').trim() : s);
// "Syllabus.pdf" → "Syllabus": the type is added back from the link when the file is saved.
const stripExt = (s) => s.replace(/\.([a-z0-9]{1,8})$/i, (all, e) => (DOC_TYPES.has(e.toLowerCase()) ? '' : all)).trim();

// Words that say "this is a link to a file" without saying which file.
const GENERIC = new Set(('download downloads here click tap this that the a an file files link view open get save see read more as in to '
  + 'new tab window document attachment format version full text and or for of now it').split(' '));

/** Link text that doesn't name the file: "Download", "click here", "PDF", "Download (PDF, 2.4 MB)", "[1]". */
export function isGenericText(text) {
  const words = tidy(text).toLowerCase()
    .replace(/\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|kib|mib|bytes?)\b/g, ' ') // a file size
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.every((w) => GENERIC.has(w) || DOC_TYPES.has(w) || /^\d+$/.test(w));
}

/** The file's own name from its address, decoded, without the extension: ".../Week%203%20notes.pdf" → "Week 3 notes". */
export function nameFromUrl(url) {
  let last = '';
  try {
    last = new URL(url).pathname.split('/').pop() || '';
  } catch {
    return '';
  }
  try {
    last = decodeURIComponent(last);
  } catch { /* a stray "%": keep it as written */ }
  return clip(stripExt(tidy(last.replace(/[\\/]+/g, ' '))));
}

/** What the link itself says the file is: its visible text, else its tooltip/label. '' when neither says. */
function linkName({ text, alt } = {}) {
  for (const raw of [text, alt]) {
    const t = clip(stripExt(tidy(raw)));
    if (t && !isGenericText(t) && !/^(?:https?:\/\/|www\.)/i.test(t)) return t;
  }
  return '';
}

/**
 * The name shown for a document (and used for the saved file): the link's visible text when it says
 * something, otherwise the file name from the address.
 */
export function docName(link = {}) {
  return linkName(link) || nameFromUrl(link.url) || 'document';
}

/** The saved file's name: the sanitised name plus the whitelisted extension. '' if the type isn't allowed. */
export function docFilename(name, ext) {
  const e = String(ext || '').toLowerCase();
  if (!DOC_TYPES.has(e)) return '';
  const base = stripExt(tidy(name));
  // sanitizeFilename's own fallback is "video"; a nameless document is a "document".
  const hasName = /[^<>:"/\\|?*.\s]/.test(base);
  return `${sanitizeFilename(hasName ? base : 'document', MAX_NAME)}.${e}`;
}

/**
 * What one frame reported ([{url, text, alt}], untrusted) → [{key, url, ext, name}]: whitelisted web links
 * only, one per document, at most `max`. A document linked twice takes the first link that names it.
 */
export function cleanDocs(reported, max = MAX_DOCS) {
  const byKey = new Map();
  for (const it of (Array.isArray(reported) ? reported : []).slice(0, max * 5)) {
    const url = typeof it?.url === 'string' && it.url.length <= MAX_URL ? it.url : '';
    const ext = docExtOf(url);
    if (!ext) continue;
    const key = docKey(url);
    const named = linkName(it);
    const prev = byKey.get(key);
    if (prev) {
      if (!prev.named && named) Object.assign(prev, { name: named, named: true });
      continue;
    }
    if (byKey.size >= max) continue;
    byKey.set(key, { key, url: url.split('#')[0], ext, name: named || nameFromUrl(url) || 'document', named: !!named });
  }
  return [...byKey.values()].map(({ named, ...d }) => d);
}

/**
 * Store one frame's report next to the other frames' ({frameId: [doc]}). A frame always reports its whole
 * list, so this replaces what it said before. One budget for the whole tab, main page first.
 */
export function frameDocs(byFrame, frameId, reported, max = MAX_DOCS) {
  const next = { ...(byFrame || {}) };
  next[frameId] = cleanDocs(reported, max);
  let room = max;
  for (const id of Object.keys(next).sort((a, b) => Number(a) - Number(b))) {
    next[id] = next[id].slice(0, room);
    room -= next[id].length;
    if (!next[id].length) delete next[id];
  }
  return next;
}

/** Every frame's documents as one list: each document once (main page first), same-named ones told apart. */
export function mergeDocs(byFrame, max = MAX_DOCS) {
  const seen = new Set();
  const out = [];
  for (const id of Object.keys(byFrame || {}).sort((a, b) => Number(a) - Number(b))) {
    for (const d of byFrame[id] || []) {
      if (out.length >= max || seen.has(d.key)) continue;
      seen.add(d.key);
      out.push({ ...d });
    }
  }
  // Ten links all called "Slides": add each file's own name, so the rows (and saved files) can be told apart.
  const count = new Map();
  for (const d of out) count.set(d.name.toLowerCase(), (count.get(d.name.toLowerCase()) || 0) + 1);
  for (const d of out) {
    if (count.get(d.name.toLowerCase()) < 2) continue;
    const own = nameFromUrl(d.url);
    if (own && own.toLowerCase() !== d.name.toLowerCase()) d.name = clip(`${d.name} (${own})`);
  }
  return out;
}

/** Is this job or history record a download of this document? By address only (signatures aside). */
export function sameDoc(doc, rec) {
  if (!doc || !rec) return false;
  if (rec.mediaUrl && rec.mediaUrl === doc.url) return true;
  return !!doc.key && Array.isArray(rec.mediaKeys) && rec.mediaKeys.includes(doc.key);
}

/** 'active' | 'queued' | 'done' | 'failed' | 'new', from this session's downloads and the download history. */
export function docStatus(doc, jobs = [], history = []) {
  const mine = (jobs || []).filter((j) => sameDoc(doc, j));
  if (mine.some((j) => ['running', 'recording', 'muxing'].includes(j.status))) return 'active';
  if (mine.some((j) => j.status === 'queued')) return 'queued';
  if (mine.some((j) => j.status === 'done') || (history || []).some((x) => sameDoc(doc, x))) return 'done';
  if (mine.some((j) => j.status === 'error')) return 'failed';
  return 'new';
}

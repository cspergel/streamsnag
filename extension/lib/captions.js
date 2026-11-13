// Captions of long lectures: reading every piece of a segmented caption track, saying so when something
// is missing, and fitting a very long transcript into one AI request without dropping its end.
// Pure, shared by the service worker and the tests.
import { mapLimit } from './plan.js';

/** The most caption pieces read for one video. At six seconds a piece that is over thirty hours. */
export const SEGMENT_CAP = 20000;

/**
 * Read every caption piece, a few at a time, in order: { texts, total, read, missed }. A piece that fails
 * is tried again; one that still fails is left empty and counted in `missed`. `read` is less than `total`
 * only when the safety cap was hit.
 */
export async function readSegments(urls, fetchOne, { limit = 6, cap = SEGMENT_CAP, retries = 1 } = {}) {
  const all = Array.isArray(urls) ? urls : [];
  const list = all.slice(0, Math.max(0, cap));
  let missed = 0;
  const texts = await mapLimit(list, limit, async (url) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return String(await fetchOne(url) ?? '');
      } catch { /* try once more */ }
    }
    missed++;
    return '';
  });
  return { texts, total: all.length, read: list.length, missed };
}

/** What to tell the user when captions were not read in full ('' when they were). */
export function coverageNote({ total = 0, read = 0, missed = 0 } = {}) {
  const parts = [];
  if (read < total) parts.push(`These captions are very long: only the first ${read} of ${total} parts were read, so the end is missing.`);
  if (missed > 0) parts.push(`${missed} of ${read} caption parts could not be read, so some lines are missing.`);
  return parts.join(' ');
}

/** Marks a stretch that was left out of a condensed transcript. */
export const GAP_MARK = '[…]';
const WINDOWS = 40;

/**
 * Fit a transcript ("[m:ss] text" lines) into `max` characters: { text, condensed, kept }. A transcript
 * that fits is returned as it is. A longer one is sampled evenly from start to end: it is cut into equal
 * stretches and the beginning of each is kept (of the last one, its end), whole lines with their
 * timestamps, with "[…]" where lines were left out. So a three-hour lecture is covered to its last
 * minute, not cut off after two hours.
 * `kept` is the share of the text that remains (0 to 1).
 */
export function condenseCaptions(text, max) {
  const full = String(text ?? '');
  if (!(max > 0) || full.length <= max) return { text: full, condensed: false, kept: 1 };
  const lines = full.split('\n').filter((l) => l.trim());
  const n = Math.max(1, Math.min(WINDOWS, lines.length));
  // Each stretch gets the same room; a line of its own is needed for the "left out" mark.
  const room = Math.floor(max / n) - (GAP_MARK.length + 1);
  const out = [];
  for (let w = 0; w < n; w++) {
    const from = Math.floor((w * lines.length) / n);
    const to = Math.floor(((w + 1) * lines.length) / n);
    // The last stretch keeps its end (how the lecture closes); every other one its beginning.
    const fromEnd = w === n - 1 && n > 1;
    const picked = [];
    let used = 0;
    for (let k = 0; k < to - from; k++) {
      const line = lines[fromEnd ? to - 1 - k : from + k];
      if (used + line.length + 1 > room) break;
      if (fromEnd) picked.unshift(line); else picked.push(line);
      used += line.length + 1;
    }
    // Not even one line fits (a very long line): keep its start, which has the timestamp.
    if (!picked.length && to > from && room > 20) picked.push(lines[from].slice(0, room - 1));
    const whole = picked.length === to - from && picked.every((l, i) => l === lines[from + i]);
    const gap = () => { if (out[out.length - 1] !== GAP_MARK) out.push(GAP_MARK); };
    if (!whole && fromEnd) gap();
    out.push(...picked);
    if (!whole && !fromEnd) gap();
  }
  const short = out.join('\n');
  return { text: short, condensed: true, kept: Math.min(1, short.length / full.length) };
}

/**
 * Is this the page's only video? Then a separate caption file on the page (a <track>) belongs to it.
 * `visible`: the items shown for the page (a video that comes in several files is one item there).
 * A file the page only links to for download ("Download video") is the same lecture as the page's one
 * player, so with one player and one such link either of them is "the" video; two players, or a page of
 * download links, are not.
 */
export function soleVideo(visible, id) {
  const videos = (visible || []).filter((x) => x.kind !== 'subtitle' && !x.playlist && !x.variantOf);
  const players = videos.filter((x) => !x.linked);
  const links = videos.filter((x) => x.linked);
  if (players.length > 1 || (!players.length && links.length !== 1)) return false;
  return players[0]?.id === id || (links.length === 1 && links[0].id === id);
}

// Languages a caption file may name itself by (ISO 639-1, the common ones), and their three-letter and written forms.
const LANGS = new Set(('en es fr de it pt ru ja zh ko ar hi nl sv no nb da fi pl tr el he cs hu ro uk vi th id bn fa ur ms ta te bg hr sr sk sl lt lv et ca gl eu'
  + ' sw af sq hy az ka kk mn ne si km lo my is ga cy mt mk bs').split(' '));
const LONG = {
  eng: 'en', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', zho: 'zh', chi: 'zh', kor: 'ko', ara: 'ar', hin: 'hi', nld: 'nl', dut: 'nl',
  english: 'en', spanish: 'es', español: 'es', french: 'fr', français: 'fr', german: 'de', deutsch: 'de', italian: 'it', italiano: 'it', portuguese: 'pt', português: 'pt', russian: 'ru',
  русский: 'ru', japanese: 'ja', 日本語: 'ja', chinese: 'zh', 中文: 'zh', korean: 'ko', 한국어: 'ko', arabic: 'ar', العربية: 'ar', hindi: 'hi', dutch: 'nl', nederlands: 'nl',
};

/** "en-US", "eng", "English" → "en" ('' when it names no language we know). */
export function langCode(s) {
  const t = String(s || '').trim().toLowerCase();
  const first = t.split(/[-_\s,(]/)[0];
  if (LANGS.has(first)) return first;
  return LONG[first] || '';
}

/**
 * The language a caption file's address names: "talk.EN.srt", "Intro-en-GB (1).asr.srt", "…&lang=pt-br".
 * Lower case, with its region when there is one; '' when the address does not say.
 */
export function langOfFile(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  for (const p of ['lang', 'language', 'srclang', 'tlang', 'hl']) {
    const v = (u.searchParams.get(p) || '').toLowerCase();
    if (LANGS.has(v.split('-')[0]) && /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(v)) return v;
  }
  let name = u.pathname.split('/').pop() || '';
  try { name = decodeURIComponent(name); } catch { /* keep as written */ }
  // Without the file type, a copy counter and the marks of automatic captions: the language is the last word.
  const stem = name.replace(/\.(?:vtt|webvtt|srt|ttml|dfxp)$/i, '').replace(/(?:\s*\(\d+\)|[._-](?:asr|auto|cc|sdh|forced))+$/i, '');
  const m = /(?:^|[._\-\s])([a-z]{2,3})(?:-([a-z]{2}|[a-z]{4}))?$/i.exec(stem);
  if (!m || !LANGS.has(m[1].toLowerCase())) return '';
  return `${m[1]}${m[2] ? `-${m[2]}` : ''}`.toLowerCase();
}

/** The most caption files read on one page to see whether they hold words, each time StreamSnag is opened on it. */
export const WORD_CHECKS = 6;

/**
 * The caption files to read, to know that "Save transcript" has something to save: for each video, its
 * caption files in the order they would be used (captionFiles), up to the first that is known to have
 * words; the ones known to have none are passed over. At most `max` in all, no file twice. `videos`: the
 * page's videos as listed; `may(sub)`: may this file be asked for at all.
 * Returns [[sub, …]]: one run per video, to be read in order until one of the run has words.
 */
export function wordChecks(media, videos, prefs = {}, { max = WORD_CHECKS, may = () => true } = {}) {
  const runs = [];
  const taken = new Set();
  let room = max;
  for (const v of videos || []) {
    const run = [];
    for (const sub of captionFiles(media, v, prefs)) {
      if (sub.words === true) break;
      if (taken.has(sub)) continue; // (another video's run reads it)
      if (room <= 0 || !may(sub)) break; // not known, and not to be asked: offered as before
      taken.add(sub);
      run.push(sub);
      room -= 1;
    }
    if (run.length) runs.push(run);
  }
  return runs;
}

/**
 * The languages to look for, in order: the user's own, the page's, English. One order for every choice:
 * the subtitles saved inside a video, the track a transcript is made from, the caption file read first.
 */
function wanted({ langs = [], pageLang = '' } = {}) {
  return [...new Set([...langs.map(langCode), langCode(pageLang), 'en'].filter(Boolean))];
}

/**
 * Subtitle tracks in the order they are worth having: the user's language(s) first, then the page's
 * language, then English, then the rest as the stream lists them. `list`: tracks that say their language as
 * `language`, `lang` or `name`. (Only the first few are saved inside a video.)
 */
export function orderSubtitles(list, prefs = {}) {
  const want = wanted(prefs);
  const rank = (s) => { const i = want.indexOf(langCode(s.language) || langCode(s.lang) || langCode(s.name)); return i < 0 ? want.length : i; };
  return (list || []).map((s, i) => ({ s, i, r: rank(s) })).sort((a, b) => a.r - b.r || a.i - b.i).map(({ s }) => s);
}

/**
 * The caption files that belong to a video, the one to read first: those the page declared for it (same
 * `set`: one player's <track>s, one playlist entry's captions), else, when it is the page's only video,
 * every caption file on the page. The user's language first, then the page's, then English; and a .vtt
 * before the .srt next to it (a converted copy is often the worse one). `media`: every item of the tab.
 * A file that was read and has no words in it (`words` false: a header and no cues, cues with nothing
 * said) is not a caption file: it is never one of them.
 */
export function captionFiles(media, item, prefs = {}) {
  const all = (media || []).filter((x) => x.kind === 'subtitle' && !x.dismissed && !x.part && x.words !== false);
  if (!item || item.kind === 'subtitle') return [];
  const own = item.set ? all.filter((x) => x.set === item.set) : [];
  const visible = (media || []).filter((x) => !x.hidden && !x.covered && !x.variantOf);
  const list = own.length ? own : soleVideo(visible, item.id) ? all : [];
  const want = wanted(prefs);
  const rank = (s) => { const code = langCode(s.lang) || langCode(langOfFile(s.url)); const i = want.indexOf(code); return i >= 0 ? i : code ? want.length + 1 : want.length; };
  return list.map((s, i) => ({ s, i, r: rank(s) })).sort((a, b) => a.r - b.r || Number(a.s.ext === 'srt') - Number(b.s.ext === 'srt') || a.i - b.i).map(({ s }) => s);
}

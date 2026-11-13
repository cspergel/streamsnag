// What a video is called. The content script reports what the page offers (the player's own label, a
// highlighted lesson next to the player, the heading by the player, the page's video data, its title);
// this picks the one a person would use, and never a generic word, a slogan or a bare address when there
// is something better. Pure, shared by the service worker and the tests.
import { usableName } from './review.js';
import { DIRECT_EXT } from './detect.js';
import { isGenericText } from './files.js';
import { langCode } from './captions.js';
import { decodeEntities } from './transcript.js';

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** A web address standing where a name should be ("https://…", "cdn.example.com/a/b.mp4"). */
export function addressLike(s) {
  const t = tidy(s);
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(t)) return true;
  // host.tld/path with no spaces: what a tab shows for a file opened on its own.
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i.test(t);
}

// Words that label a part of a page or a player, not a video.
// (And a control of the player or its side panel: "Jump to" is the tab over a lecture-capture player's list of slides.)
const GENERIC = new Set(['video', 'videos', 'video player', 'player', 'media', 'media player', 'audio', 'movie', 'watch', 'untitled', 'home', 'beginning', 'jump to', 'go to', 'skip to',
  'top', 'contents', 'table of contents', 'overview', 'menu', 'navigation', 'loading', 'embed', 'embedded video', 'embedded content', 'iframe', 'file', 'stream']);
// How a call to action starts: a line that sells or instructs, where a heading by the player was looked for.
// ("View isolated demos", "See all talks", "Browse the archive": a link's words set as a heading.)
const CALL = /^(?:try|sign up|sign in|log in|subscribe|join|get started|click|press|choose|select|register|start your|buy|upgrade|donate|share|follow|learn more|watch more|read more|download|view|see|browse|explore|check out)\b/i;

// What a section of a page under a player is headed: the part of the page, not the video.
const SECTIONS = new Set(['summary', 'description', 'about', 'details', 'transcript', 'captions', 'subtitles', 'comments', 'discussion', 'related', 'related videos',
  'more videos', 'up next', 'chapters', 'resources', 'downloads', 'download', 'share', 'license', 'licensing', 'file history', 'file usage', 'metadata', 'references',
  'see also', 'credits', 'tags', 'categories', 'speakers', 'speaker', 'presenters', 'presenter', 'about the speaker', 'about the speakers', 'links', 'attachments',
  'abstract', 'schedule', 'slides', 'materials', 'handouts', 'show notes']);

// What a button that starts a recording says: "Play", "Listen", "Watch the video", "Play episode", "Listen to the latest".
const CONTROL = /^(?:play|listen|watch|view|open|stream|start|resume|launch|hear)(?:\s+(?:to|the|this|it|now|here|online|again|latest|newest|episode|video|audio|recording|lecture|talk|podcast|show|file|clip|track|chapter|in|a|new|tab|window|browser|full|screen|fullscreen))*$/i;

/**
 * Is this only what a control says ("Play", "▶ Listen", "Watch the video", "Play episode")? Such words
 * start a recording; they name none. "Play Chapter 3" and "Watch: Sorting" say more, and are not.
 */
export function controlOnly(s) {
  return CONTROL.test(tidy(s).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
}

// What a player is called, not what it plays: "EPlayer", "Video Player", "JW Player", "Vimeo video player",
// "Wistia video", "Vimeo embed" (the title a frame or its page gives a player that says nothing of its video).
const PLAYER_BRANDS = [
  // @site-edition
  'youtube',
  // @end-site-edition
  'vimeo', 'wistia', 'loom', 'dailymotion', 'kaltura', 'brightcove', 'jw', 'jwplayer', 'panopto', 'vidyard', 'twitch', 'facebook',
  'mediasite', 'echo360', 'yuja', 'peertube', 'html5'].join('|');
// (One word that ends in "player", or "player" after a brand or after "video", "media", "web", "embedded": never
// a phrase that merely ends in the word, "From the player", "The Piano Player".)
const PRODUCT = new RegExp(`^(?:[\\p{L}\\p{N}.-]*player|(?:(?:${PLAYER_BRANDS}|video|media|audio|web|embedded)\\s+){1,2}player|(?:${PLAYER_BRANDS})\\s+(?:video|embed|iframe|media|clip))(?:\\s+(?:toolkit|embed|frame|iframe|window|page))?$`, 'iu');

/** Is this what a player is called ("EPlayer", "Wistia video", "Vimeo player"), not what a video is? */
export function productName(s) {
  return PRODUCT.test(tidy(s).replace(/[.…:!]+$/, ''));
}

/**
 * Does this read as a file's name, not as a title a person wrote: no spaces, and an underscore, a media
 * file's type at its end, or several hyphens or dots with a number among them ("Deconstruct_DanAbramov_V3",
 * "lecture-01-intro", "talk.final.v2", "intro.mp4")? One word, or a hyphenated one ("Wi-Fi", "COVID-19"), is not.
 */
export function fileLikeName(s) {
  const t = tidy(s);
  if (t.length < 4 || /\s/.test(t)) return false;
  if (fileLike(t) || /[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(t)) return true;
  return (t.match(/[-.]/g) || []).length >= 2 && /\d/.test(t) && /\p{L}/u.test(t);
}

// Words a heading over a part of a page is made of when it says what kind of thing is there, not which
// video: "Open Access Media", "Examples", "Lecture Chapters", "Presentation Video", "Recordings".
const SECTION_WORDS = new Set(('open access media video videos audio recording recordings presentation presentations example examples demo demos demonstration demonstrations '
  + 'lecture lectures chapters watch online stream streaming player content materials resources files downloads download free full the this a an of and for').split(' '));
const sectionWords = (t) => {
  const words = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => SECTION_WORDS.has(w));
};

/**
 * Not a name a person would use: empty, without a letter, an address, or a word like "Video" or
 * "Beginning". For a heading picked up near the player (`source` 'heading') also a slogan (a line that
 * ends in "!" or starts like a call to action: "Try … with your own content!") and the heading of a
 * section of the page ("Summary", "Captions [edit]"). For what a player or an entry of a list is labelled
 * (`source` 'player', 'list', 'heading', 'embed') also a control's own word ("Play"). For what a player is
 * labelled ('player', 'embed') also the player's own product name ("EPlayer", "Wistia video"); for a
 * heading also one that only says what kind of thing is there ("Examples", "Open Access Media").
 */
export function weakName(s, source = '') {
  const t = tidy(s);
  if (t.length < 3 || !/\p{L}/u.test(t) || addressLike(t)) return true;
  if (GENERIC.has(t.toLowerCase().replace(/[.…:!]+$/, ''))) return true;
  if (['player', 'list', 'heading', 'embed'].includes(source) && controlOnly(t)) return true;
  if (['player', 'embed'].includes(source) && productName(t)) return true;
  if (source !== 'heading') return false;
  return /!$/.test(t) || CALL.test(t) || sectionWords(t) || SECTIONS.has(t.toLowerCase().replace(/\s*\[?edit\]?$/, '').replace(/[.…:]+$/, '').trim());
}

// Parts of a host name that are not the site's own name.
const HOST_NOISE = new Set(['www', 'com', 'org', 'net', 'edu', 'gov', 'co', 'io', 'app', 'tv', 'ac', 'uk', 'us', 'de', 'fr', 'info', 'online', 'site', 'web', 'player', 'cdn', 'media', 'video', 'videos']);
// Tried in this order: the first one a title has is how its parts are told apart.
const SEPARATORS = [' | ', ' · ', ' — ', ' – ', ' : ', ' - '];

/** Is this part of a title the site's name (as the page says it, or by a word it shares with the address)? */
function isSite(part, site, host) {
  const p = part.toLowerCase();
  if (site && p === site.toLowerCase()) return true;
  const labels = String(host || '').toLowerCase().split('.').filter((l) => l.length >= 3 && !HOST_NOISE.has(l));
  const words = p.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const flat = p.replace(/[^\p{L}\p{N}]+/gu, '');
  // ("Deconstruct" at deconstructconf.com: the address begins with the name, six letters or more of it.)
  return labels.some((l) => words.includes(l) || flat === l || (flat.length >= 6 && l.startsWith(flat)));
}

/**
 * Is this text nothing but the site's own name? As the page gives it (`site`: its og:site_name; `cut`:
 * the part of its title that was taken off as the site), or made of the words of its address alone
 * ("Blender Video" at video.blender.org, "Khan Academy" at khanacademy.org). A name that merely has the
 * site's word in it ("What's New in Blender 5.3") is not.
 */
export function siteOnly(text, { site = '', host = '', cut = '' } = {}) {
  const flat = (x) => tidy(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const t = flat(text);
  if (!t) return false;
  if ([site, cut].some((x) => flat(x) === t)) return true;
  const labels = String(host || '').toLowerCase().split('.').filter(Boolean);
  const own = labels.filter((l) => l.length >= 3 && !HOST_NOISE.has(l));
  if (own.includes(t)) return true;
  const words = tidy(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some((w) => own.includes(w)) && words.every((w) => labels.includes(w));
}

/**
 * A page title without the site: { name, course }. "Lecture 1 | Big Course | Academy" is the lecture and
 * its course; "Talk - Site" loses the site. Only a part that is the site's own name is cut from a title
 * written with dashes or colons, so "Day 2 - Keynote" stays whole.
 */
export function cleanPageTitle(title, opts = {}) {
  const { name, course } = splitTitle(title, opts);
  return { name, course };
}

/** cleanPageTitle, and `site`: the part of the title that was cut as the site's name ('' when none was). */
function splitTitle(title, { site = '', host = '' } = {}) {
  const full = tidy(title).replace(/\s+(?:from\s+.+\s+)?on\s+Vimeo$/i, '');
  const sep = SEPARATORS.find((s) => full.includes(s));
  if (!sep) return { name: full, course: '', site: '' };
  let parts = full.split(sep).map(tidy).filter(Boolean);
  const strong = sep === ' | ' || sep === ' · ';
  let cut = '';
  if (parts.length > 1 && isSite(parts.at(-1), site, host)) { cut = parts.at(-1); parts = parts.slice(0, -1); } else if (parts.length > 1 && isSite(parts[0], site, host)) { cut = parts[0]; parts = parts.slice(1); }
  if (!parts.length) return { name: full, course: '', site: '' };
  // "A | B | C": the page's own name comes first. Dashes and colons are also part of ordinary names.
  if (strong) return { name: parts[0], course: parts.length > 1 ? parts[1] : '', site: cut };
  if (sep === ' : ' && cut) return { name: parts[0], course: '', site: cut };
  return { name: parts.join(sep), course: '', site: cut };
}

// The end of a file's name that only says how it was encoded: its type again, a codec, a picture size, a
// bitrate, "hd", "sd" or "hdr" (and the counter some sites add after it: "…_mp3-2").
const ENCODING = 'av1|vp[89]|[hx]\\.?26[45]|hevc|avc|\\d{3,4}p|\\d{3,4}x\\d{3,4}|\\d{2,4}k(?:b|bps)?|u?hd|fhd|sd|hq|lq|hdr|sdr|mp3|mp4|m4a|m4v|webm|ogg|ogv|opus|flac|wav|mkv|mov';
const FORMAT_TAIL = new RegExp(`[\\s._-]+(?:${ENCODING})(?:-\\d)?$`, 'i');
// ("4k" too says a quality, "lecture0-4k.mp4", but it may as well be part of a name, "Sintel movie 4K": it
// is never cut from a name, and only left out where files are compared to see which are one recording.)
const QUALITY_WORD = `(?:${ENCODING}|[48]k)(?:-\\d)?`;
const QUALITY_TAIL = new RegExp(`[\\s._-]+${QUALITY_WORD}$`, 'i');
// A name that is nothing else ("720p", "1080p-hdr", "4k"): it says which quality, of a recording it does not name.
const FORMAT_ALL = new RegExp(`^${QUALITY_WORD}(?:[\\s._-]+${QUALITY_WORD})*$`, 'i');

/**
 * A media file's name without its type and without what only says how it was encoded:
 * "Sintel_movie_4K.webm.240p.vp9.webm" → "Sintel_movie_4K", "talk.av1.webm" and "talk.mp4" → "talk",
 * "book_01_64kb.mp3" → "book_01". Never cut down to nothing: a file called "720p.mp4" keeps "720p".
 */
export function fileStem(file, tail = FORMAT_TAIL) {
  let name = String(file ?? '').replace(/\.([a-z0-9]{1,5})$/i, (all, e) => (Object.hasOwn(DIRECT_EXT, e.toLowerCase()) ? '' : all));
  for (let i = 0; i < 5; i++) {
    const cut = name.replace(tail, '');
    if (cut === name || !/[\p{L}\p{N}]/u.test(cut)) break;
    name = cut;
  }
  // (A name that ends in a hyphen before its type, "talk-.mp4" beside "talk-.av1.webm", is the same name.)
  return /[\p{L}\p{N}]/u.test(name) ? name.replace(/[\s._-]+$/, '') : name;
}

/** The last part of an address, decoded ('' when it is no address). */
function lastPart(url) {
  let last = '';
  try {
    last = new URL(url).pathname.split('/').pop() || '';
  } catch {
    return '';
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last; // a stray "%": kept as written
  }
}

/**
 * A video file's own name from its address: "…/Week%203%20-%20Valves.mp4" → "Week 3 - Valves", without what
 * only says how it was encoded ("…/Sintel_movie_4K.webm.240p.vp9.webm" → "Sintel movie 4K"). '' when it says nothing.
 */
export function fileTitle(url) {
  const stem = fileStem(lastPart(url));
  if (FORMAT_ALL.test(stem)) return ''; // "720p.mp4": a quality, not a name
  const name = tidy(stem.replace(/[_+]+/g, ' '));
  return name && usableName(name) && !weakName(name) ? name : '';
}

/**
 * What tells one recording's files apart from another's, for files a page links to in several formats
 * ("talk.av1.webm" and "talk.mp4"; "book_01_64kb.mp3" and "book_01.mp3"): the file's name without its
 * type and encoding, in lower case, with the folder it is in, or (for a name long enough to say which
 * recording it is) the site alone: a site may keep each format in a folder of its own. Files named by
 * their quality alone ("720p.mp4" beside "1080p.mp4") are the qualities of the one recording their folder
 * holds. '' when the address has no name to go by.
 */
export function recordingKey(url) {
  const stem = fileStem(lastPart(url), QUALITY_TAIL).toLowerCase();
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const folder = u.pathname.replace(/[^/]*$/, '');
  if (FORMAT_ALL.test(stem)) return folder.length > 1 ? `${u.host}${folder}|*` : '';
  if (!stem || !usableName(stem)) return '';
  const telling = stem.length >= 12 && /\p{L}/u.test(stem);
  return `${u.host}${telling ? '' : folder}|${stem}`;
}

/** A name that is a file's ("File:Sintel movie 4K.webm"): what the video is called comes before it when the page says. */
const fileLike = (s) => /\.([a-z0-9]{2,5})$/i.test(s) && Object.hasOwn(DIRECT_EXT, /\.([a-z0-9]{2,5})$/i.exec(s)[1].toLowerCase());

/**
 * The name a link to a video file gives it: its text without the words that only say it is a download
 * ("Lecture 4: Counting download" → "Lecture 4: Counting"). '' when the text names nothing ("Download video", "MP4", "2.2M").
 */
export function linkTitle(text) {
  let t = tidy(text);
  // Words that tell the reader how to save the file, not what it is: 'To download: Right-click and choose "Save Link As..."'.
  if (/\bright[- ]click\b|\bsave (?:link|target|file|video) as\b|\bclick here\b/i.test(t)) return '';
  // What a control says ("Play", "Listen to the latest") starts the recording and names none.
  if (controlOnly(t)) return '';
  // A link whose text is the file's own name ("talk.av1.webm" in a listing of files): the name without its type and encoding.
  if (fileLike(t)) {
    const own = tidy(/\s/.test(t) ? fileStem(t) : fileStem(t).replace(/[_+]+/g, ' '));
    return own && !FORMAT_ALL.test(own) && usableName(own) && !weakName(own) && !formatOnly(own) ? own : '';
  }
  for (let i = 0; i < 3; i++) {
    t = t.replace(/[\s([–—|:-]*\b(?:download|mp4|webm|video file|hd|sd)\b[\s)\]]*$/i, '').replace(/^(?:download|watch|play|view|get|listen to)(?:\s*:\s*|\s+)(?:the\s+)?/i, '').trim();
  }
  return t && !controlOnly(t) && !isGenericText(t) && !weakName(t) && !formatOnly(t) ? t : '';
}

// Words of a row that say when, how long or how big, not what: "2024-01-05 · 45 min", "Jan 5, 2024",
// "01 00:08:26", and a listing of files' "80.7 MiB 2024-Feb-06 18:17".
const WHEN_WORDS = new Set(('min mins minute minutes sec secs second seconds hr hrs hour hours h m s am pm ago today yesterday '
  + 'b k g t kb mb gb tb kib mib gib tib byte bytes '
  + 'jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december '
  + 'mon tue wed thu fri sat sun monday tuesday wednesday thursday friday saturday sunday').split(' '));

/** Does a row's text only say when a recording was made, how long it is or how big its file is (no word of its own)? */
export function whenOnly(text) {
  const words = tidy(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // ("198m", "56k", "2gb": a size written as one word with its unit, as a listing of files has it.)
  return words.every((w) => /^\d+(?:st|nd|rd|th|[kmgt]i?b?)?$/.test(w) || WHEN_WORDS.has(w));
}

// Words that say which kind of file a link gives ("H.264 IA", "OGG VIDEO", "MPEG4"), not which video.
// Also its size and its language ("mp3 eng 56.5 MB", "1080p eng-deu-fra 703.5 MB").
const FORMAT_WORDS = new Set(('h 264 265 h264 h265 hevc avc mpeg mpeg4 mp4 m4v mp3 m4a aac opus flac wav ogg oga ogv webm weba mkv mov flv vbr cbr ia video audio the file link hd sd hq uhd 4k 8k hdr sdr original source '
  + 'low medium high quality res resolution version stream torrent kb mb gb kib mib gib bytes').split(' '));
const formatOnly = (t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  .every((w) => FORMAT_WORDS.has(w) || /^\d+(?:p|k|kb|kbps|x\d+)?$/.test(w) || (w.length >= 3 && !!langCode(w))); // "eng", "deutsch": a language (never a two-letter word: "no", "is", "it")

const SMALL = new Set('a an the of and or in on to for with by at from'.split(' '));
const wordsOf = (t) => new Set(String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !SMALL.has(w)));
// "Lecture 1", "Episode 12", "Part 3": the mark of one item of a series.
const NUMBERED = /(?<![\p{L}\p{N}])(?:lecture|lesson|episode|part|session|chapter|week|module|unit|class|day)\s*#?\d+/iu;

/**
 * Do a heading found by the player and the page's title speak of the same thing, with the title saying
 * more of this page? They share a word, neither is part of the other, and the title has more words of
 * its own (a numbered "Lecture 1" counts for three). "Lecture Chapters" or the course's heading against
 * "ASTR 160 - Lecture 1 - Introduction": the title. A heading with nothing in common with the title is
 * the lesson on a page titled after its course, and stays.
 */
function titleSaysMore(heading, title) {
  const h = wordsOf(heading);
  const t = wordsOf(title);
  if (![...h].some((w) => t.has(w))) return false;
  const [hs, ts] = [[...h].join(' '), [...t].join(' ')];
  if (hs.includes(ts) || ts.includes(hs)) return false;
  const own = (mine, other, text) => [...mine].filter((w) => !other.has(w)).length + (NUMBERED.test(text) ? 3 : 0);
  return own(t, h, title) > own(h, t, heading);
}

/**
 * A player in a frame and the page around it both have a name for the video: does the player's give way?
 * It does when it says nothing a person would call the lecture (the file's name the uploader left,
 * "Deconstruct_DanAbramov_V3"; the player's own product name, "EPlayer"; nothing but its site's name) and
 * the page has a name that is none of those. `frame`, `top`: what chooseName gave for each (or null).
 */
export function pageNameWins(frame, top) {
  const says = (info) => !!info?.name && !info.siteOnly && !fileLikeName(info.name) && !productName(info.name);
  return !says(frame) && says(top);
}

// (`rule`: what a rule saved for the site, or one that ships with StreamSnag, says the lecture is called:
// written for this very site, so it comes before everything the page is merely guessed to say.)
const ORDER = ['rule', 'player', 'list', 'video', 'heading', 'structured'];

/**
 * The name of the video a page is showing, from what the content script found:
 * { rule, player, list, video, heading, structured, title, site, host, h1, duration }. Returns
 * { name, source, course, heading, pageTitle, duration, candidates, page }, or null when the page has no name
 * to give (then a file's own name is used, see fileTitle). What is only the site's own name (its
 * og:site_name, the part of the title that names the site, the words of its address) is never taken for
 * the video's, wherever the page says it; when the title is all there is and it is the site's name, the
 * answer carries `siteOnly`.
 * `video` is the name the page's own data gives its one video (a VideoObject, or the title of a page
 * that says it is a video): when the page's title says so too, that is what the video is called, though
 * a sub-heading stands nearer to the player.
 */
export function chooseName(signals) {
  const s = signals || {};
  const page = splitTitle(s.title, { site: tidy(s.site), host: s.host });
  const pageTitle = tidy(s.title);
  // The site's own name is no video's: a page that goes from video to video without a load (PeerTube) leaves
  // the site's name where its video data was, and a player in a frame is titled after the site it comes from.
  const isSiteName = (text) => siteOnly(text, { site: s.site, host: s.host, cut: page.site });
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  // (The page's video data often repeats its whole title, site and all: it is read the way the title is.)
  // (And a page's data may write a character as its code, "What&#39;s new": it stands for the character.)
  const bare = (text) => cleanPageTitle(decodeEntities(text), { site: tidy(s.site), host: s.host }).name;
  const said = { ...s, structured: bare(s.structured), video: bare(s.video) };
  // (Only while the page's title says it too: an app that goes from video to video rewrites its title, not
  // always its data. On a page that has gone on without a load (`moved`) that holds for all of its data.)
  const borne = (text) => !!text && pageTitle.toLowerCase().includes(text.toLowerCase());
  if (!borne(said.video)) said.video = '';
  if (s.moved && !borne(said.structured)) said.structured = '';
  const found = ORDER.map((source) => [source, tidy(said[source])]).filter(([source, text]) => text && !weakName(text, source) && (source === 'rule' || !isSiteName(text)));
  // What the page calls the video comes before a heading that is the file's own name.
  const candidates = [...found.filter(([, text]) => !fileLike(text)), ...found.filter(([, text]) => fileLike(text))];
  // A "lecture name" that only repeats the page's title is no better than the title (unless it is the video's declared name).
  let distinct = candidates.filter(([src, text]) => src === 'video' || src === 'rule' || (!same(text, pageTitle) && !same(text, page.name)));
  const titled = page.name && !weakName(page.name) ? ['title', page.name] : null;
  // A heading by the player that is about the same thing as the title but says less of this page (a section
  // under the player, the course's own heading above it) gives way to the title.
  if (distinct[0]?.[0] === 'heading' && titled && titleSaysMore(distinct[0][1], page.name)) distinct = [...distinct.slice(1), titled];
  const [from, name] = distinct[0] || candidates[0] || titled || [];
  if (!name) return null;
  const source = from === 'video' ? 'structured' : from; // both are the page's video data
  const site = tidy(s.site);
  let course = '';
  if (source !== 'title') {
    // (What is left of a title that is a file's name, "File:Sintel movie 4K.webm", is no course.)
    const after = page.name.includes(name) ? page.name.slice(page.name.indexOf(name) + name.length) : '';
    const inFileName = fileLike(page.name) || Object.hasOwn(DIRECT_EXT, (/^\.([a-z0-9]{2,5})(?![a-z0-9])/i.exec(after)?.[1] || '').toLowerCase());
    const rest = inFileName ? '' : tidy(page.name.replace(name, '')).replace(/^[\s|:·–—-]+|[\s|:·–—-]+$/g, '');
    course = page.course || (rest && !weakName(rest) && !same(rest, name) ? rest : '');
  } else course = page.course;
  // (A main heading that is the site's name, in its top bar, is not the heading of this page's content.)
  const h1 = tidy(s.h1);
  return {
    name, source, course: course || site, heading: h1 && !isSiteName(h1) ? h1 : '', pageTitle, duration: Number(s.duration) > 0 ? Number(s.duration) : 0,
    candidates: candidates.map(([src, text]) => `${src}: ${text}`),
    // What the page's title calls the page, without the site: the course, on a page that lists its lectures.
    page: titled && !isSiteName(titled[1]) ? titled[1] : '',
    // Nothing but the site's own name was there to give: the page says what site it is, not what video.
    ...(source === 'title' && isSiteName(name) ? { siteOnly: true } : {}),
  };
}

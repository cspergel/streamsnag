// Sentences the popup and the service worker say in more than one place, each worded once: what is shown
// when nothing is listed, the heading of the page's caption files, what to do when a video has no captions,
// the one kind of live stream StreamSnag cannot record, and the plain words of the first screen (a
// recording's one line, its quality rows, where it was saved, how far a download is). Pure, so the tests
// read them too.

/** A live broadcast in the DASH format: said like the other limits (what it is, what you can do). */
// @site-edition
export const LIVE_DASH = 'This is a live broadcast of a kind StreamSnag can\'t record itself. Press "Try another way" to hand it to the local helper.';

/** The button that hands a page to the helper's other downloader (its name, yt-dlp, is only said in tooltips and under Advanced). */
export const OTHER_WAY = 'Try another way';
// @store-edition
// export const LIVE_DASH = 'This is a live broadcast of a kind StreamSnag can\'t record.';
// @end-site-edition

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the popup says when nothing is listed: { title, hint } (`hint` may be ''). One state that describes
 * the page in front of you:
 *  - no video and no player: "No video on this page." and what to do instead;
 *  - a player that has not started (`players` > 0): "Press play, then open StreamSnag again.";
 *  - something already playing that StreamSnag cannot see (`playing` > 0): what to try, since pressing play would be no help;
 *  - files or caption files but no video: the same first line, and the files stay listed under it.
 *  - `webPage`: an ordinary web page (not a browser page, which no extension may look at);
 *  - `videos`: recordings on the page (all of them, whatever the filter shows); `subs`, `docs`: caption files and documents;
 *  - `filter`: 'all' | 'new' | 'done'; `query`: what was typed into the search box;
 *  - `checking`: links on the page that may be lectures and are being looked at right now (they are only
 *    looked at once StreamSnag is opened): the page is not called empty while the answer is on its way.
 *  - `lectures`: how many pages of single lectures the page links to, when it is a list of them (a
 *    course's page): then the lectures are one click away, and the hint says so.
 */
export function emptyState({ webPage = true, videos = 0, subs = 0, docs = 0, players = 0, playing = 0, filter = 'all', query = '', checking = 0, lectures = 0 } = {}) {
  if (query && videos) return { title: `No names match “${query}”.`, hint: '' };
  if (videos) return { title: filter === 'done' ? 'Nothing downloaded from this page yet.' : 'Everything on this page is downloaded.', hint: '' };
  if (!webPage) {
    return { title: 'StreamSnag can\'t look at this page.', hint: 'Browser pages like this one are off limits to extensions. Open a lecture in a normal tab, then click StreamSnag.' };
  }
  if (checking > 0) return { title: 'Looking at the links on this page…', hint: `${count(checking, 'link')} here may be ${checking === 1 ? 'a lecture' : 'lectures'} to download. ${checking === 1 ? 'It' : 'They'} will be listed in a moment.` };
  // What was found without a video (files, caption files) is listed under the sentence, whichever it is.
  const found = [docs ? count(docs, 'file') : '', subs ? count(subs, 'caption file') : ''].filter(Boolean).join(' and ');
  const below = found ? ` The ${found} found here ${docs + subs === 1 ? 'is' : 'are'} listed below.` : '';
  if (playing) return { title: 'StreamSnag can\'t see this player\'s video yet.', hint: `Something is playing here that it did not find by itself. Try "Scan again"; if that finds nothing, your AI can look for it.${below}` };
  if (players) return { title: 'Press play, then open StreamSnag again.', hint: `The player on this page has not loaded its video yet. Most players only do once they start.${below}` };
  // A page that lists its lectures, each on a page of its own: they are one click away.
  const listed = lectures >= 3 ? `This page links to ${lectures} lectures, each on a page of its own. Open one, then open StreamSnag there.` : 'Open a lecture to save it.';
  return { title: 'No video on this page.', hint: `${listed}${below}` };
}

/**
 * The part of the page a video sits in (a tab's label, "Licensing"), for the line under its name: '' when
 * the name already says it ("Licensing", "Licensing (2)", "Licensing: an example"), so the line never
 * repeats the title above it.
 */
export function sectionUnder(name, section) {
  const flat = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const [n, s] = [flat(name), flat(section)];
  if (!s) return '';
  return n === s || n.startsWith(`${s} `) || n.endsWith(` ${s}`) ? '' : String(section);
}

/**
 * How the page's captions travel with a download, for the "Captions (N)" heading: 'inside' (a stream's own
 * captions, merged into the saved video), 'beside' (saved as files next to it), '' (they are just listed).
 * `settings`: includeSubtitles, embedSubtitles, useFfmpeg; `ffmpeg`: the local helper is there and has ffmpeg.
 */
export function captionsTravel(media, { settings = {}, ffmpeg = false } = {}) {
  const withStream = (media || []).some((m) => (m.kind === 'hls' || m.kind === 'dash') && m.info?.hasSubtitles);
  if (!withStream || settings.includeSubtitles === false) return '';
  return settings.embedSubtitles !== false && settings.useFfmpeg !== false && ffmpeg ? 'inside' : 'beside';
}

/** "Captions (2): saved inside the video when you download it": the promise only when it is true. */
export function captionsHeading(n, travel = '') {
  const head = `Captions (${n})`;
  if (travel === 'inside') return `${head}: saved inside the video when you download it`;
  if (travel === 'beside') return `${head}: saved next to the video when you download it`;
  return head;
}

/** What the page's caption files are, in a few words (the worker's notes use it; the popup's heading is captionsHeading). */
export function subsNote(media) {
  const withStream = (media || []).some((m) => (m.kind === 'hls' || m.kind === 'dash') && m.info?.hasSubtitles);
  return withStream ? 'Already saved with stream downloads' : 'Caption files found on this page';
}

let languageNames = null;
/** "en" → "English", "pt-br" → "Brazilian Portuguese"; '' when the code names no language. */
export function languageName(code) {
  const tag = String(code || '').trim().replace(/_/g, '-');
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(tag)) return '';
  try {
    languageNames = languageNames || new Intl.DisplayNames(['en'], { type: 'language' });
    const name = languageNames.of(tag);
    return name && name.toLowerCase() !== tag.toLowerCase() ? name : '';
  } catch {
    return '';
  }
}

/**
 * What a page calls a caption file, when that says anything about it. A bitrate ("300k"), a picture size, a
 * number or a bare dash does not: '' then. A label that is only a remark ("- (translated)") is kept as one:
 * "Captions (translated)".
 */
export function captionName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim().replace(/^[\s\-–—_.,:;·|/\\]+|[\s\-–—_.,:;·|/\\]+$/g, '');
  if (!/\p{L}/u.test(s)) return '';
  if (/^\d+(?:[.,]\d+)?\s*(?:k|kb|kbps|kbit\/s|m|mb|mbps|mbit\/s|p|fps)$/i.test(s)) return '';
  if (/^(?:subtitles?|captions?|cc|default|track(?: ?\d+)?)$/i.test(s)) return ''; // what a player calls a track that has no label
  const remark = /^\(([^()]+)\)$/.exec(s);
  return remark ? `Captions (${remark[1].trim()})` : s;
}

/** "a VTT file", "an SRT file": the article goes by how the letters are said. */
const aFile = (format) => `${/^[AEFHILMNORSX]/.test(format) ? 'an' : 'a'} ${format} file`;

/**
 * What each caption file is called in the list, and the quiet detail under it: Map of id → { name, detail }.
 *  - `name`: its language ("English"), else what the page calls it when that says something; on a page
 *    with several lectures the lecture it belongs to is added ("English · Lecture 3"), and a file with
 *    neither a language nor a usable name is called by its lecture alone. Never a bitrate or a bare dash.
 *  - Two files in one language that differ only in format are the same captions twice: they get the same
 *    name, and the format is the detail ("VTT file", then "also as an SRT file").
 *  - Files that even share the format are numbered ("English · 1", "English · 2").
 * `files`: [{ id, lang, ext, name, of }] (`name`: what the page calls it; `of`: the lecture it belongs to).
 */
export function captionLabels(files = []) {
  const list = files || [];
  const lecture = (f) => String(f.of || '').replace(/\s+/g, ' ').trim();
  const several = new Set(list.map(lecture).filter(Boolean)).size > 1;
  const base = (f) => [languageName(f.lang) || captionName(f.name), several ? lecture(f) : ''].filter(Boolean).join(' · ') || 'Captions';
  const format = (f) => String(f.ext || '').toUpperCase();
  const groups = new Map();
  for (const f of list) groups.set(base(f), [...(groups.get(base(f)) || []), f]);
  const out = new Map();
  for (const [name, members] of groups) {
    const formats = new Set(members.map(format));
    const told = formats.size === members.length && !formats.has(''); // the format alone tells them apart
    members.forEach((f, i) => {
      if (members.length === 1) out.set(f.id, { name, detail: '' });
      else if (told) out.set(f.id, { name, detail: i ? `also as ${aFile(format(f))}` : `${format(f)} file` });
      else out.set(f.id, { name: `${name} · ${i + 1}`, detail: formats.size > 1 && format(f) ? `${format(f)} file` : '' });
    });
  }
  return out;
}

/**
 * What to do when a video has no captions to read. Transcribing it on this computer is only named where it
 * can be done: this copy has the study tools (`studyTools`) and the local helper says this computer can
 * run it. Without the helper it is named as something its setup makes possible.
 * `helper`: what the helper last said ({ ok, stt: { supported } }), or null.
 */
export function noCaptions({ studyTools = false, helper = null } = {}) {
  const base = 'No captions found on this page. Turn on the player\'s captions (CC) so they load, then try again.';
  if (!studyTools) return base;
  if (helper?.ok && helper.stt?.supported) return `${base} Or download the video and use "Transcribe on this computer" to make them.`;
  if (helper && !helper.ok) return `${base} Or set up the local helper (Settings, on the Local helper tab): it can then make captions from the downloaded video on this computer.`;
  return base;
}

// ---------------------------------------------------------------- plain words on the first screen

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma']);

/** Is this item sound only? (By what the page said it is, else by its file type.) */
export function isAudio(m) {
  return m?.mediaType === 'audio' || AUDIO_EXTS.has(String(m?.ext || '').toLowerCase());
}

/** What an item is, in one plain word: "Video", "Audio", "Live video", "Playlist", "Captions". */
export function kindWord(m) {
  if (m?.kind === 'subtitle') return 'Captions';
  if (m?.playlist) return 'Playlist';
  if (isAudio(m)) return m?.info?.live ? 'Live audio' : 'Audio';
  return m?.info?.live ? 'Live video' : 'Video';
}

/** The noun for a list of items: "videos", "audio files", or "recordings" when it holds both. `n`: how many are meant. */
export function nounFor(items = [], n = 2) {
  const list = (items || []).filter((m) => m && m.kind !== 'subtitle');
  const audio = list.filter(isAudio).length;
  const one = audio && audio === list.length ? 'audio file' : audio ? 'recording' : 'video';
  return n === 1 ? one : `${one}s`;
}

/** A length in plain words: "45 s", "27 min", "1 h 5 min"; '' when it is not known. */
export function plainDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 60)} h`;
}

const bytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

/**
 * The card's one line about a recording: "Video · 27 min · 129 MB". What it is, how long, how big, and
 * nothing else: the container, the bitrate and the server are under Details.
 * `length`: false leaves the length out (a list row already shows it on its tile).
 */
export function cardLine(m, { length = true } = {}) {
  const dur = length ? plainDuration(m?.info?.duration || m?.duration) : '';
  const size = m?.size && (m.kind === 'direct' || m.kind === 'subtitle') ? bytes(Number(m.size)) : '';
  return [kindWord(m), dur, size].filter(Boolean).join(' · ');
}

const PLAYS_ANYWHERE = new Set(['mp4', 'm4v', 'mp3', 'm4a']);
const NEEDS_A_PLAYER = new Set(['webm', 'mkv', 'ogv', 'ogg', 'oga', 'opus', 'flac', 'avi', 'wmv', 'wma', 'flv']);

/**
 * The type of a file that is saved as the site has it, as a quiet detail beside the button: "OGV file",
 * "MP3 file". '' for an MP4 (what everyone expects) and for a stream (it is saved as a video file, whatever
 * its playlist is called). The button itself says "Download": the type is never the choice.
 */
export function fileTypeWord(m) {
  const ext = String(m?.ext || '').toLowerCase();
  if (m?.kind !== 'direct' || !ext || ext === 'mp4' || !/^[a-z0-9]{2,5}$/.test(ext)) return '';
  return `${ext.toUpperCase()} file`;
}

/** What a file type means for the person who opens it, in one line (a tooltip); '' when there is nothing useful to say. */
export function fileTypeHint(ext) {
  const e = String(ext || '').toLowerCase();
  if (PLAYS_ANYWHERE.has(e)) return `${e.toUpperCase()} file: plays on almost any phone, tablet and computer.`;
  if (NEEDS_A_PLAYER.has(e)) return `${e.toUpperCase()} file: plays in a browser and in the free VLC player. Some phones and editors cannot open it.`;
  return e ? `${e.toUpperCase()} file` : '';
}

/**
 * The rows of a choice between several qualities or files of one recording, in plain words:
 * [{ words, detail }], best first as listed. `rows`: a picture size as listed ("1080p"), or
 * { q: its picture size ('' when not known), bytes: the file's size, rate: a stream's bitrate, ext: the file's type }.
 *  - Picture sizes that tell the rows apart are the names: "1080p · best", "720p · smaller", "360p · smallest".
 *  - When they do not (two files of the same picture, or sound in two formats) the size is the name:
 *    "3.9 MB", "2.1 MB · smaller"; without sizes, the type is all there is: "MP3", "OGG".
 *  - "best" is only said of the first row when every row says its picture size; "smaller" and "smallest"
 *    only of a row that is known to be smaller (every row's size is known, else every row's bitrate).
 *    Equal or unknown sizes get no such word.
 *  - `detail`: the file's type, as a small label ("WEBM"), when it is not already the name.
 */
export function qualityRows(rows = []) {
  const num = (v) => (Number(v) > 0 ? Number(v) : 0);
  const list = (rows || []).map((r) => (typeof r === 'string' ? { q: r } : r || {}))
    .map((r) => ({ q: String(r.q || '').trim(), bytes: num(r.bytes), rate: num(r.rate), ext: String(r.ext || '').trim().toUpperCase() }));
  const told = list.every((r) => r.q) && new Set(list.map((r) => r.q)).size === list.length;
  const unit = list.every((r) => r.bytes) ? 'bytes' : list.every((r) => r.rate) ? 'rate' : '';
  const most = unit ? Math.max(...list.map((r) => r[unit])) : 0;
  const least = unit ? Math.min(...list.map((r) => r[unit])) : 0;
  const lone = unit ? list.filter((r) => r[unit] === least).length === 1 : false; // one row is the smallest of all
  return list.map((r, i) => {
    const size = r.bytes ? bytes(r.bytes) : '';
    const name = told ? r.q : [r.q, size].filter(Boolean).join(' · ') || r.ext || `Choice ${i + 1}`;
    const detail = r.ext && r.ext !== name ? r.ext : '';
    if (list.length < 2) return { words: name, detail };
    const word = i === 0 && told ? 'best'
      : unit && r[unit] < most ? (list.length > 2 && lone && r[unit] === least ? 'smallest' : 'smaller') : '';
    return { words: [name, word].filter(Boolean).join(' · '), detail };
  });
}

/** The words of those rows alone: ["1080p · best", "720p · smaller"]. */
export function qualityWords(rows = []) {
  return qualityRows(rows).map((r) => r.words);
}

// ---------------------------------------------------------------- why a recording is left out of "Download all"

const FLAG_MEANS = {
  copy: 'A second copy of one listed here.',
  sound: 'The same lecture as one listed here, as sound only.',
  samename: 'Another one here has the same name.',
  promo: 'Probably not a lecture.',
  short: 'Probably too short to be a lecture.',
  audio: 'Sound only, no picture.',
  noname: 'The page gave it no name of its own.',
  appeared: 'Found after this list opened.',
};

/**
 * What a flag on a recording means for the person, and what to do about it, in a few plain words. `key`: a
 * reason of lib/review.js ('copy' | 'sound' | 'samename' | 'promo' | 'short' | 'audio' | 'noname' | 'appeared').
 * `where`: 'list' (the popup's list: it is about "Download all") | 'sheet' (the review sheet: the box is right there).
 * '' for a key that is no flag.
 */
export function flagWords(key, where = 'list') {
  const means = FLAG_MEANS[key];
  if (!means) return '';
  return where === 'sheet' ? `${means} Not ticked: tick it if you want it too.` : `${means} "Download all" leaves it unticked: tick it there if you want it.`;
}

// ---------------------------------------------------------------- what a finished download adds, in plain words

/**
 * The note of a finished download as a sentence a student can read: { text, detail }. The worker's own
 * note names the tool it used ("ffmpeg: merged video + audio, embedded 2 subtitle tracks"); that becomes
 * "Picture and sound joined into one file. Captions saved inside the video (2 sets)." and what was really
 * reported is `detail` (a tooltip, and under Details). A note that is already plain is kept as it is.
 */
export function plainNote(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { text: '', detail: '' };
  const did = (s) => {
    if (/^merged video \+ audio$/i.test(s)) return 'Picture and sound joined into one file';
    const conv = /^converted to (\w+)$/i.exec(s);
    if (conv) return `Saved as ${aFile(conv[1].toUpperCase())}`;
    const inside = /^embedded (\d+) subtitle tracks?$/i.exec(s);
    if (inside) return `Captions saved inside the video${Number(inside[1]) > 1 ? ` (${inside[1]} sets)` : ''}`;
    if (/^subtitles kept as separate files$/i.test(s)) return 'Captions saved as files next to it';
    return s;
  };
  const one = (part) => {
    const tool = /^ffmpeg:\s*(.*)$/i.exec(part);
    if (tool) return tool[1].split(/,\s*/).filter(Boolean).map(did).map((s) => `${s}.`).join(' ');
    if (/^ffmpeg merge failed/i.test(part)) return 'The picture and sound could not be joined, so they were saved as two files.';
    if (/^Video and audio saved as separate files \(install/i.test(part)) return 'Picture and sound were saved as two files. Set up the local helper (in Settings) and they are joined into one from then on.';
    if (/^Video and audio saved as separate files\.?$/i.test(part)) return 'Picture and sound were saved as two files.';
    if (/^The subtitles could not be downloaded\.?$/i.test(part)) return 'The captions could not be downloaded.';
    return part;
  };
  const plain = text.split(' · ').map((p) => one(p.trim())).filter(Boolean).join(' ');
  return { text: plain, detail: plain === text ? '' : text };
}

/**
 * Where a saved file is, as the folders a person would click through, outermost first:
 * ["Downloads", "StreamSnag", "PHYS201"]. `path`: the saved file; `folder`: the subfolder the download used
 * ("StreamSnag/PHYS201"; null when it is not known); `root`: the name of the folder downloads land in.
 * With a path and its subfolder, the folder above the subfolder is named as it really is; with only a path,
 * its last two folders; without a path, the root and the subfolder as planned.
 */
export function savedTrail({ path = '', folder = null, root = 'Downloads' } = {}) {
  const sub = String(folder || '').split(/[\\/]/).filter(Boolean);
  const dirs = String(path || '').split(/[\\/]/).filter(Boolean).slice(0, -1);
  if (!dirs.length) return [root || 'Downloads', ...sub];
  if (folder == null) return dirs.slice(-2);
  const tail = sub.length ? dirs.slice(-sub.length) : [];
  const fits = sub.every((s, i) => String(tail[i] || '').toLowerCase() === s.toLowerCase());
  if (!fits) return dirs.slice(-2);
  return [dirs[dirs.length - sub.length - 1] || root || 'Downloads', ...sub];
}

/** "Saved to Downloads › StreamSnag › PHYS201" ("Saved" alone when the place is not known). */
export function savedTo(trail = [], lead = 'Saved to') {
  const where = (trail || []).filter(Boolean).join(' › ');
  return where ? `${lead} ${where}` : lead.replace(/ to$/, '');
}

/**
 * A running download in one line, with a time from the start: "Starting…", then "42% · about 20 s left".
 * `status`: 'queued' | 'running' | 'recording' | 'muxing'; `pct`: 0–100; `indeterminate`: no total is known;
 * `begun`: something has arrived (a download whose size is never known says "Downloading…" once it has);
 * `eta`: "about 20 s left" ('' until there is a rate).
 */
export function progressWords({ status = 'running', pct = 0, indeterminate = false, begun = false, eta = '' } = {}) {
  if (status === 'queued') return 'Waiting for its turn';
  if (status === 'recording') return 'Recording live…';
  if (status === 'muxing') return 'Finishing: joining picture and sound…';
  const n = Math.round(Number(pct) || 0);
  if (indeterminate) return eta ? `Downloading · ${eta}` : begun ? 'Downloading…' : 'Starting…';
  if (n < 1 && !eta) return 'Starting…';
  return eta ? `${n}% · ${eta}` : `${n}%`;
}

/**
 * Activity with nothing running: what to say, and whether to point at History.
 * `earlier`: downloads saved from this page before; `history`: downloads on record at all.
 */
export function activityEmpty({ earlier = 0, history = 0 } = {}) {
  if (earlier) return { text: 'Nothing running. Saved from this page earlier:', link: true };
  if (history) return { text: 'Nothing running. Earlier downloads are in History.', link: true };
  return { text: 'Nothing running. Downloads, transcripts and study packs show up here.', link: false };
}

/** Is this history record a download from this page? By address, ignoring the part after "#". */
export function samePage(a, b) {
  const tidy = (u) => String(u || '').split('#')[0].replace(/\/$/, '');
  return !!tidy(a) && tidy(a) === tidy(b);
}

/** A protected item: the sentence, and one line on what still works. */
export function protectedWords(m, { captions = false, files = 0 } = {}) {
  const what = isAudio(m) ? 'recording' : 'video';
  const still = [captions ? 'its transcript can still be saved' : '', files ? `the ${files === 1 ? 'file' : `${files} files`} on this page can still be downloaded` : ''].filter(Boolean).join(', and ');
  return {
    text: `This ${what} is protected by the site, so it can't be saved.`,
    still: still ? `${still[0].toUpperCase()}${still.slice(1)}.` : 'You can still watch it on the page.',
  };
}

// @site-edition
const TECH = /\b(HLS|DASH|MPD|m3u8|EXTM3U|manifest|ffmpeg|ffprobe|yt-dlp|codec|mux\w*|HTTP \d{3}|ERR_[A-Z_]+|SERVER_[A-Z_]+|NETWORK_[A-Z_]+|FILE_[A-Z_]+|USER_[A-Z_]+|TypeError|undefined)\b|#EXT/;
// @store-edition
// const TECH = /\b(HLS|DASH|MPD|m3u8|EXTM3U|manifest|ffmpeg|ffprobe|codec|mux\w*|HTTP \d{3}|ERR_[A-Z_]+|SERVER_[A-Z_]+|NETWORK_[A-Z_]+|FILE_[A-Z_]+|USER_[A-Z_]+|TypeError|undefined)\b|#EXT/;
// @end-site-edition

/**
 * An error as one plain sentence plus what to do: { text, detail }. A message that is already plain is
 * kept; one that speaks of formats, tools or codes becomes a sentence a student can act on, and what was
 * really reported is `detail` (shown under Details, for bug reports).
 */
export function plainProblem(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { text: 'Something went wrong. Try again.', detail: '' };
  if (/\bDRM\b|encrypted/i.test(text)) return { text: 'This one is protected by the site, so it can\'t be saved.', detail: text };
  // (A sentence that already says what to do, such as how to install a missing tool, is kept as it is.)
  if (!TECH.test(text) || /Install it with|\bSettings\b|local helper/i.test(text)) return { text, detail: '' };
  if (/NETWORK_|ERR_INTERNET|ERR_NETWORK|ERR_CONNECTION|Failed to fetch/i.test(text)) return { text: 'The connection dropped. Check your internet, then try again.', detail: text };
  if (/FILE_(NO_SPACE|TOO_LARGE)/.test(text)) return { text: 'There is not enough room on the disk. Free some space, then try again.', detail: text };
  if (/FILE_/.test(text)) return { text: 'The file could not be written to your Downloads folder. Check the folder, then try again.', detail: text };
  if (/ffmpeg|ffprobe|mux|codec/i.test(text)) return { text: 'The download finished, but its picture and sound could not be joined. Try again; if it keeps happening, pick another quality.', detail: text };
  // @site-edition
  if (/yt-dlp/i.test(text)) return { text: 'The other way of downloading could not get this one either. Reload the page, press play, then try again.', detail: text };
  // @end-site-edition
  return { text: 'StreamSnag couldn\'t read this one. Reload the page, press play, then try again.', detail: text };
}

// ---------------------------------------------------------------- a long list of files

/** A list of files longer than this is cut here until "Show all N" is pressed. */
export const DOC_FOLD = 12;
/** A list longer than this gets a find-by-name box. */
export const DOC_FIND = 20;

const DOC_GROUPS = [
  ['PDFs', ['pdf']], ['Slides', ['ppt', 'pptx', 'pps', 'ppsx', 'key', 'odp']], ['Documents', ['doc', 'docx', 'odt', 'rtf', 'pages']],
  ['Spreadsheets', ['xls', 'xlsx', 'csv', 'ods', 'numbers']], ['Books', ['epub']], ['Notebooks', ['ipynb']], ['Archives', ['zip']],
];
const groupOf = (d) => DOC_GROUPS.find(([, exts]) => exts.includes(String(d?.ext || '').toLowerCase()))?.[0] || 'Other files';

/** The heading of the page's site-wide links (legal PDFs, press kits): never counted as the page's own files. */
export const ASIDE_GROUP = 'From the page\'s footer or menu';

/**
 * A page's files as the popup lists them: { rows, total, shown, hidden, find, aside }.
 *  - `rows`: the files in page order. A long list (more than DOC_FOLD) is grouped by type instead, each
 *    group under a heading with its count ({ group, n }: PDFs, Slides, Documents…), in page order within it.
 *  - beyond DOC_FOLD files the rest waits behind "Show all N" (`hidden` of them), unless `all` or a `query`;
 *  - `find`: the list is long enough for a find-by-name box; `query` keeps the files whose name has every word of it;
 *  - `aside`: the addresses of files linked only from the page's footer or menus. They are not the page's
 *    files: they come last under their own heading, shown once the list is opened in full (`aside` counts them).
 */
export function docRows(docs = [], { aside = new Set(), query = '', all = false } = {}) {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (d) => words.every((w) => `${d.name || ''} ${d.ext || ''}`.toLowerCase().includes(w));
  const own = (docs || []).filter((d) => !aside.has(d.url));
  const side = (docs || []).filter((d) => aside.has(d.url));
  const mine = own.filter(hit);
  const full = all || words.length > 0;
  const room = full ? Infinity : DOC_FOLD;
  const rows = [];
  let shown = 0;
  if (own.length > DOC_FOLD) {
    const names = [...DOC_GROUPS.map(([name]) => name), 'Other files'];
    for (const name of names) {
      const list = mine.filter((d) => groupOf(d) === name);
      if (!list.length || shown >= room) continue;
      rows.push({ group: name, n: list.length });
      const part = list.slice(0, room - shown);
      rows.push(...part);
      shown += part.length;
    }
  } else {
    rows.push(...mine);
    shown = mine.length;
  }
  const sideHits = side.filter(hit);
  // With no file of its own, the page's site-wide links are all there is to list.
  if (sideHits.length && (full || !own.length)) rows.push({ group: ASIDE_GROUP, n: sideHits.length }, ...sideHits);
  return { rows, total: own.length, shown, hidden: mine.length - shown, find: own.length > DOC_FIND, aside: side.length };
}

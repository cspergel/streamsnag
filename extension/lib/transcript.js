// Captions into a transcript a person can read: cues are parsed with their times, cleaned (tags,
// positioning, entities), repeated lines are dropped, and the text is joined into paragraphs that
// break on pauses. Rendered as Markdown or plain text. Pure functions; times are whole milliseconds
// so "exactly two seconds" compares exactly.

/** A pause longer than this between two cues starts a new paragraph. */
export const PAUSE_MS = 2000;
/** A paragraph is closed once it holds this many sentences... */
export const MAX_SENTENCES = 5;
/** ...or, for captions without punctuation (auto-captions), once it is about this long. */
export const MAX_PARAGRAPH_CHARS = 900;
// A cue that starts while the one before it is still up (or right as it leaves) may be repeating its lines.
const ROLL_SLACK_MS = 250;

const STAMP = '(?:(\\d+):)?(\\d{1,2}):(\\d{2})[.,](\\d{1,3})';
const TIMING = new RegExp(`^\\s*${STAMP}\\s*-->\\s*${STAMP}`);

function toMs(h, m, s, frac) {
  return ((Number(h) || 0) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(String(frac).padEnd(3, '0'));
}

/**
 * The cues of a WebVTT (or SRT) file, in file order: [{ startMs, endMs, text }]. `text` is the raw cue
 * text (tags and line breaks still in it). Headers, NOTE/STYLE/REGION blocks and anything without a
 * timing line are skipped, so garbage gives [].
 */
export function parseCues(vttOrSrt) {
  const raw = String(vttOrSrt ?? '');
  const body = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, '\n'); // without the byte-order mark
  const cues = [];
  // Only a truly empty line ends a cue: auto-captions put a line holding one space inside their cues.
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n');
    // The timing line is the first line, or the second one after a cue id.
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0 || at > 1) continue;
    // Cues written without an empty line between them: every further timing line starts a new one, and
    // the line just before it is that cue's identifier, not the last words of the cue above.
    if (!TIMING.test(lines[at])) continue;
    let open = null;
    let first = false; // the next line is the first of a cue's text
    for (let i = at; i < lines.length; i++) {
      const m = TIMING.exec(lines[i]);
      if (m) {
        if (open && open.text.length && isCueId(open.text.at(-1))) open.text.pop();
        const startMs = toMs(m[1], m[2], m[3], m[4]);
        open = { startMs, endMs: Math.max(startMs, toMs(m[5], m[6], m[7], m[8])), text: [] };
        cues.push(open);
        first = true;
        continue;
      }
      // A machine-made identifier left as the first line of a cue's text (by a converter that copied it
      // over from the WebVTT file) is not something that was said.
      if (!(first && UUID_ID.test(lines[i].trim()))) open.text.push(lines[i]);
      first = false;
    }
  }
  return cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text.join('\n').replace(/\n+$/, '') }));
}

// A machine-made cue identifier: "28c4bfd0-49bc-47c4-9ff0-23faec4a71cc-0".
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+)?$/i;
/** A line that is a cue's identifier when it stands right before a timing line: a number, or a machine-made id. */
const isCueId = (line) => /^\d+$/.test(line.trim()) || UUID_ID.test(line.trim());

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

/** "&amp;" → "&", "&#39;" → "'". One pass, so "&amp;lt;" stays "&lt;" (what the author wrote). */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (all, name) => {
    if (name[0] !== '#') {
      const known = ENTITIES[name.toLowerCase()];
      return known === undefined ? all : known;
    }
    const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (code < 32) return ' '; // tab, line break and other control characters
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
    return String.fromCodePoint(code);
  });
}

const tidy = (s) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const VOICE = '<v(?:\\.[^\\s>]+)?[ \\t]+([^>]+)>';

/**
 * One line of cue text, cleaned: { speaker, text }. A voice tag at the start (<v Ada>) names the
 * speaker; other tags, word timings, and positioning codes are removed, and entities decoded.
 */
export function cleanLine(raw) {
  let s = String(raw ?? '').replace(/\{\\[^}]*\}/g, ''); // positioning left in SRT files: {\an8}
  let speaker = '';
  const lead = new RegExp(`^\\s*${VOICE}`, 'i').exec(s);
  if (lead) {
    speaker = tidy(decodeEntities(lead[1]));
    s = s.slice(lead[0].length);
  }
  s = s
    .replace(new RegExp(VOICE, 'gi'), ' $1: ') // a second voice inside the line stays as a label
    .replace(/<\d[\d:.]*>/g, '') // word timings: <00:00:01.500>
    .replace(/<\/?[a-z][^<>]*>/gi, ''); // <c.yellow> <i> </b> <ruby> <font color=…>
  return { speaker, text: tidy(decodeEntities(s)) };
}

const lineKey = (l) => `${l.speaker}\u0000${l.text}`;

/**
 * A cue line that points at a picture, not at something said: a thumbnail for a player's seek bar
 * ("…/storyboard.jpg#xywh=0,0,256,144", "sprites/sheet_01.png"). One address and nothing else on the line.
 */
export function imageRef(line) {
  const t = String(line ?? '').trim();
  if (!t || /\s/.test(t)) return false;
  return /#xywh=\d+,\d+,\d+,\d+$/i.test(t) || /\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]\S*)?$/i.test(t);
}

/** The lines of a caption file's cues, cleaned (tags and empty lines aside). */
function cueLines(vttOrSrt) {
  return parseCues(vttOrSrt).flatMap((c) => c.text.split('\n').map((l) => cleanLine(l).text).filter(Boolean));
}

/** Is this "caption" file a thumbnail index: it has cues, and every one of them points at a picture? */
export function imageCues(vttOrSrt) {
  const lines = cueLines(vttOrSrt);
  return lines.length > 0 && lines.every(imageRef);
}

/**
 * Does a caption file hold anything that was said: a cue line with a letter in it that is not a picture's
 * address? A notice parked where it is never shown is not: every worded cue at one and the same moment,
 * with no length ("99:59:59.999 --> 99:59:59.999 / Please use the Etherpad for the transcript.").
 */
export function hasWords(vttOrSrt) {
  const said = parseCues(vttOrSrt).filter((c) => c.text.split('\n').map((l) => cleanLine(l).text).some((l) => l && /\p{L}/u.test(l) && !imageRef(l)));
  if (!said.length) return false;
  return !said.every((c) => c.endMs <= c.startMs && c.startMs === said[0].startMs);
}

/**
 * Clean every cue and drop what only repeats the cue before it: the same cue twice, and the rolling
 * captions of auto-generated tracks, where each cue shows the previous line again above a new one.
 * A line counts as a repeat only while the earlier cue is still on screen (or has just left), so
 * someone saying the same thing again later is kept. Returns [{ startMs, endMs, speaker, text }].
 */
export function cleanCues(cues) {
  const out = [];
  let prev = new Set();
  let prevEnd = -Infinity;
  for (const cue of cues || []) {
    const lines = String(cue.text ?? '').split('\n').map(cleanLine).filter((l) => l.text && !imageRef(l.text)); // a picture's address was not said
    if (!lines.length) continue;
    const rolling = cue.startMs <= prevEnd + ROLL_SLACK_MS;
    const fresh = rolling ? lines.filter((l) => !prev.has(lineKey(l))) : lines;
    prev = new Set(lines.map(lineKey));
    prevEnd = cue.endMs;
    if (!fresh.length) {
      // Nothing new was said, but the words stayed up: no pause has started yet.
      if (out.length) out[out.length - 1].endMs = Math.max(out[out.length - 1].endMs, cue.endMs);
      continue;
    }
    const speaker = fresh[0].speaker;
    // Another voice further down the same cue keeps its name in the text.
    const text = fresh.map((l, i) => (i && l.speaker && l.speaker !== speaker ? `${l.speaker}: ${l.text}` : l.text)).join(' ');
    out.push({ startMs: cue.startMs, endMs: cue.endMs, speaker, text });
  }
  return out;
}

const SENTENCE_END = /(?:[.!?…]+["'”’)\]]*(?=\s|$)|[。！？]+)/g;
const ENDS_SENTENCE = /(?:[.!?…]["'”’)\]]*|[。！？])$/;

/**
 * Join cleaned cues into paragraphs: [{ startMs, speaker, text }]. A new paragraph starts after a
 * pause longer than `gapMs` (exactly `gapMs` is not a pause), when a different named speaker starts,
 * after `maxSentences` sentences (at the end of a sentence), or once it is `maxChars` long.
 */
export function toParagraphs(cues, { gapMs = PAUSE_MS, maxSentences = MAX_SENTENCES, maxChars = MAX_PARAGRAPH_CHARS } = {}) {
  const out = [];
  let cur = null;
  let lastEnd = 0;
  let full = false;
  for (const cue of cues || []) {
    const pause = cur && cue.startMs - lastEnd > gapMs;
    const newVoice = cur && cue.speaker && cue.speaker !== cur.speaker;
    if (!cur || pause || newVoice || full) {
      cur = { startMs: cue.startMs, speaker: cue.speaker || '', text: cue.text };
      out.push(cur);
      lastEnd = cue.endMs;
    } else {
      cur.text += ` ${cue.text}`;
      lastEnd = Math.max(lastEnd, cue.endMs);
    }
    const sentences = (cur.text.match(SENTENCE_END) || []).length;
    full = (sentences >= maxSentences && ENDS_SENTENCE.test(cue.text)) || cur.text.length >= maxChars;
  }
  return out;
}

/** 65 000 ms → "01:05"; from one hour on "1:01:05". */
export function formatStamp(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const pad = (x) => String(x).padStart(2, '0');
  const rest = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h ? `${h}:${rest}` : rest;
}

/**
 * Text from a web page, safe inside a Markdown file: characters that would turn into formatting,
 * raw HTML or a link are escaped. Brackets stay as they are, so "[Music]" reads normally.
 */
export function mdEscape(s) {
  return String(s ?? '').replace(/[\\`*_<]/g, '\\$&').replace(/\]\(/g, ']\\(');
}

/** The file extension for a transcript format: only ever "md" or "txt". */
export function transcriptExt(format) {
  return format === 'txt' ? 'txt' : 'md';
}

/**
 * The finished transcript. Markdown: a "# title" heading and "[mm:ss] text" paragraphs. Plain text:
 * the title on its own line and the paragraphs without times (pass `timestamps` to choose).
 */
export function renderTranscript(paragraphs, { title = '', format = 'md', timestamps, sourceUrl = '' } = {}) {
  const md = transcriptExt(format) === 'md';
  const stamps = timestamps ?? md;
  const esc = md ? mdEscape : (s) => s;
  const name = tidy(String(title || '')) || 'Transcript';
  const blocks = [md ? `# ${esc(name)}` : name];
  for (const p of paragraphs || []) {
    blocks.push(`${stamps ? `[${formatStamp(p.startMs)}] ` : ''}${p.speaker ? `${esc(p.speaker)}: ` : ''}${esc(p.text)}`);
  }
  if (sourceUrl) blocks.push(`Source: ${sourceUrl}`);
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Captions (WebVTT or SRT text) to a transcript file: { text, ext, paragraphs, cues }. When the
 * captions hold no words (empty or not captions at all) `paragraphs` is 0 and `text` is ''.
 */
export function buildTranscript(vttOrSrt, { title = '', format = 'md', sourceUrl = '' } = {}) {
  const cues = cleanCues(parseCues(vttOrSrt));
  const paragraphs = toParagraphs(cues);
  const ext = transcriptExt(format);
  if (!paragraphs.length) return { text: '', ext, paragraphs: 0, cues: 0 };
  return { text: renderTranscript(paragraphs, { title, format: ext, sourceUrl }), ext, paragraphs: paragraphs.length, cues: cues.length };
}

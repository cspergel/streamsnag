// The files StreamSnag saves next to a video (its transcript, and what the study tools make), and their names.
import { sanitizeFilename } from './util.js';


// What may be saved next to a video, and under which extensions: nothing here comes from a web page.
const COMPANIONS = {
  transcript: ['md', 'txt'], notes: ['md'], flashcards: ['txt'],
  // The study page: the page itself, and the slides it shows (their index, and the PDF or
  // the PowerPoint file itself; which of the two is told by the file's own first bytes, never by its link).
  study: ['html'], slides: ['md', 'pdf', 'pptx'],
  // The study pack: its guide. (Its transcript and flashcards use the kinds above.)
  guide: ['html', 'md'],
  // ...and its one-page cheat sheet, made from the same pack.
  cheatsheet: ['html'],
  // The reading edition: the lecture as an article, as a page and as Markdown.
  read: ['html', 'md'],
};

/** "Lecture 3 - 720p" + "transcript" + "md" → "Lecture 3 - 720p.transcript.md". Unknown kinds or extensions throw. */
export function companionFilename(base, kind, ext, room = Infinity) {
  // A mock exam across a course is dated: "<course>.mock-exam-2026-11-11.html".
  const known = Object.hasOwn(COMPANIONS, kind) ? COMPANIONS[kind] : /^mock-exam-\d{4}-\d{2}-\d{2}$/.test(String(kind)) ? ['html'] : null;
  if (!known || !known.includes(ext)) throw new Error(`Not a file StreamSnag saves: ${kind}.${ext}`);
  // `room`: how long the whole name may be (lib/plan.js: pathRoom). The title is shortened to fit, never
  // the ending: ".study.html" is how the file is known again. (At least a few letters of the title stay.)
  const ending = `.${kind}.${ext}`;
  const most = Math.min(150, Math.max(8, (Number.isFinite(room) ? room : 150 + ending.length) - ending.length));
  return `${sanitizeFilename(base, most)}${ending}`;
}

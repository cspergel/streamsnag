// What a download will be called and where it goes. Pure, shared by the download itself and by the
// "Review before downloading" sheet, so the name the sheet shows is the name the file gets.
import { buildFilename, resolveFolder, rulesFor, sanitizeFilename, siteKey } from './util.js';

/** A name the user typed (Rename, or the review sheet), tidied: single spaces, at most 150 characters. '' clears it. */
export function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 150);
}

/**
 * The base file name (no extension) and the subfolder of one download: the name template and folder of the
 * page's site rule, or of the general settings, with their tokens filled in.
 */
export function downloadName({ settings, title, quality = '', course = '', pageTitle = '', pageUrl = '', url = '', kind = '', date = '' }) {
  const where = pageUrl || url;
  const rules = rulesFor(settings, where); // a site rule beats the general settings
  const site = siteKey(where);
  const c = sanitizeFilename(course || '', 80);
  const base = buildFilename(rules.filenameTemplate, { title, quality, course: c, page: pageTitle || '', host: site, date, kind }, '');
  return { base, folder: resolveFolder(rules.subfolder, { site, course: c, date, kind }) };
}

/**
 * Do a finished download's files become one merged file (the helper's ffmpeg does it), and of which type?
 * `av`: its video and audio tracks [{role, ext}]; `subs`: how many subtitle files would go inside it.
 * '' when there is nothing to merge.
 */
export function mergedExt(av, subs = 0) {
  const needsMux = av.length > 1 || (av.length === 1 && av[0].ext === 'ts') || (av.length >= 1 && subs > 0);
  if (!needsMux) return '';
  const video = av.find((x) => x.role === 'video');
  return !video ? 'm4a' : video.ext === 'webm' ? 'mkv' : 'mp4';
}

const fileOf = (p) => String(p || '').split('/').pop();

/**
 * The file a download ends up as, for the review sheet: {filename, extra}. `tracks` carry the file names
 * the download gives them ("folder/name.ext"); `canMerge`: the helper and its ffmpeg are there.
 * `extra`: how many more files are saved next to it (separate audio, subtitle files).
 */
export function plannedFile(tracks, base, settings, canMerge) {
  const av = tracks.filter((x) => x.role === 'video' || x.role === 'audio');
  const subs = tracks.filter((x) => x.role === 'subtitle');
  const inside = settings.embedSubtitles && av.some((x) => x.role === 'video') ? subs.filter((x) => /^(vtt|srt)$/i.test(x.ext)) : [];
  const ext = settings.useFfmpeg && canMerge ? mergedExt(av, inside.length) : '';
  if (!ext) return { filename: fileOf(tracks[0]?.filename), extra: Math.max(0, tracks.length - 1) };
  return { filename: `${base}.${ext}`, extra: subs.length - (settings.keepSubtitleFiles ? 0 : inside.length) };
}

/**
 * Where downloads land, for the sheet's "where it goes" line: your own save folder when one is set and the
 * helper is there to move files into it, else the browser's Downloads folder.
 * {label: the folder's own name, path: the full path ('' for Downloads), note: why it isn't your folder}.
 */
export function saveRoot(settings, helperOk) {
  const dir = String(settings?.saveFolder || '').trim();
  if (!dir) return { label: 'Downloads', path: '', note: '' };
  if (!helperOk) return { label: 'Downloads', path: '', note: 'Your own folder needs the local helper, so these stay in Downloads.' };
  return { label: dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir, path: dir, note: '' };
}

/** Run `fn` over `items`, at most `limit` at a time; the results keep the order of the items. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}

// Windows allows 259 characters for a whole path, and Chrome keeps some of them for itself (the
// ".crdownload" it saves under first): a longer file name is cut down to fit, in the middle of
// ".study.html" if it must (measured: paths of up to 243 characters are left alone). A copy counter
// (" (1)") may still be added to the name.
export const PATH_LIMIT = 240;
const COUNTER = 4;

/**
 * How long a file's name may be so its whole path fits: `root` is the folder downloads land in (as learned
 * from a finished one), `folder` the subfolder asked for. Infinity while the root is not known.
 */
export function pathRoom(root, folder = '', limit = PATH_LIMIT) {
  if (!root) return Infinity;
  const sub = String(folder || '').replace(/^[\\/]+|[\\/]+$/g, '');
  return limit - String(root).replace(/[\\/]+$/, '').length - 1 - (sub ? sub.length + 1 : 0) - COUNTER;
}

/** Did the saved file keep the ending it was asked for (".study.html")? A copy counter before the type is fine. */
export function keptSuffix(savedPath, askedName) {
  const saved = String(savedPath || '').split(/[\\/]/).pop().toLowerCase();
  const ending = /((?:\.[a-z0-9]+){1,2})$/i.exec(String(askedName || ''))?.[1].toLowerCase() || '';
  if (!ending) return true;
  if (saved.endsWith(ending)) return true;
  // "name.study (1).html": the counter sits before the last part of the ending.
  const at = ending.lastIndexOf('.');
  const counted = / \(\d+\)$/.exec(saved.slice(0, saved.length - (ending.length - at)));
  return !!counted && saved.endsWith(ending.slice(at)) && saved.slice(0, counted.index).endsWith(ending.slice(0, at));
}

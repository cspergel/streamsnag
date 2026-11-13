// "Leave out of studying" on the study desk: a video with nothing to study in it (a course introduction, say)
// stays on its shelf with its files, but is no longer a course's next step, counted in its progress, offered
// under "To study" or in a mock exam, or made into a study pack by itself after a download.
//
// What is kept: one object in chrome.storage.local under LEFT_OUT_KEY, { lecture key: when it was left out },
// by the same keys the desk knows a lecture by (its media keys, "fp:" fingerprint, "file:" path, "deck:" key),
// so it holds after a reload and when the same video is saved again. Only the desk changes it, through the
// worker (background.js: deskLeaveOut). Pure: the tests run this file on its own.

export const LEFT_OUT_KEY = 'desk:leftOut';
/** At most this many keys are kept (the oldest go first): a few per lecture, for a great many lectures. */
export const LEFT_OUT_MAX = 3000;
/** At most this many keys of one lecture are noted. */
const KEYS_MAX = 32;

/** The keys of one lecture as given: strings only, no empty or overlong ones, no repeats. */
export function lectureKeys(keys) {
  const out = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    if (typeof k !== 'string' || !k || k.length > 2100 || out.includes(k)) continue;
    out.push(k);
    if (out.length >= KEYS_MAX) break;
  }
  return out;
}

/** What is stored, made safe to read: { key: time } with only real times (anything else is dropped). A new object. */
export function leftOutMap(stored) {
  const out = {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [k, v] of Object.entries(stored)) {
    const at = Number(v);
    if (k && Number.isFinite(at) && at > 0) out[k] = at;
  }
  return out;
}

/** Is the lecture with these keys left out? (Any one of its keys is enough: a video saved again has the same ones.) */
export function isLeftOut(keys, stored) {
  const map = leftOutMap(stored);
  return lectureKeys(keys).some((k) => Object.hasOwn(map, k));
}

/** The stored object with this lecture left out (every one of its keys, at `at`). A new object; the oldest go past LEFT_OUT_MAX. */
export function leaveOut(stored, keys, at = Date.now()) {
  const next = leftOutMap(stored);
  for (const k of lectureKeys(keys)) next[k] = Number(at) > 0 ? Number(at) : Date.now();
  const all = Object.keys(next);
  if (all.length > LEFT_OUT_MAX) all.sort((a, b) => next[a] - next[b]).slice(0, all.length - LEFT_OUT_MAX).forEach((k) => delete next[k]);
  return next;
}

/** The stored object with this lecture studied again (none of its keys left). A new object. */
export function includeAgain(stored, keys) {
  const next = leftOutMap(stored);
  for (const k of lectureKeys(keys)) delete next[k];
  return next;
}

/**
 * After a download, with Autopilot on: what is not made for a video that is left out, as the job's note, or ''
 * when nothing is held back (it is not left out, it has no captions to make anything from, or none of the three
 * is switched on). The transcript is still saved: it is a file next to the video, not studying.
 * `settings`: autoStudyPack, autoStudyPage, autoRead; `keys`: the video's keys; `stored`: LEFT_OUT_KEY as stored.
 */
export function leftOutAuto({ settings = {}, keys = [], stored = null, captions = false } = {}) {
  if (!captions || !isLeftOut(keys, stored)) return '';
  const what = [settings?.autoStudyPack === true ? 'study pack' : '', settings?.autoStudyPage === true ? 'study page' : '', settings?.autoRead === true ? 'reading edition' : ''].filter(Boolean);
  if (!what.length) return '';
  const list = what.length === 1 ? what[0] : `${what.slice(0, -1).join(', ')} or ${what[what.length - 1]}`;
  return `No ${list}: this video is left out of studying on the desk`;
}

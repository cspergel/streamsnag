// Download jobs: what a waiting job keeps so it can start without its page, how a failure is worded,
// what is said when a step after a download is skipped, and the bottom bar's summary line.
// Pure, shared by the service worker, the popup and the tests.

// What a download reads from a media item. Nothing else of the item is kept on a waiting job.
const ITEM_FIELDS = [
  'id', 'key', 'aliases', 'url', 'kind', 'mediaType', 'ext', 'size', 'contentType', 'title', 'customName', 'course', 'nameSource',
  'hint', 'lang', 'pageUrl', 'fingerprint', 'protected', 'provider', 'playlist', 'parentId', 'playlistUrl', 'playlistIndex', 'info',
];

/**
 * What a queued download keeps of its media item and page, so it can start when its turn comes even if
 * the page has moved on or its tab is closed: { item, pageUrl, pageTitle }. Only what a download reads,
 * and only values that are there (the job is stored until it starts).
 */
export function mediaSnapshot(m, page = {}) {
  const item = {};
  for (const f of ITEM_FIELDS) {
    const v = m?.[f];
    if (v == null || v === '' || v === false) continue;
    item[f] = Array.isArray(v) ? v.slice(-30) : v && typeof v === 'object' ? { ...v } : v;
  }
  return { item, pageUrl: String(page.pageUrl || ''), pageTitle: String(page.pageTitle || '') };
}

/** The same for a document ("Files on this page"): the link, and the name and folder worked out for it. */
export function docSnapshot(d, target = {}) {
  return {
    doc: { id: d.id, key: d.key, url: d.url, ext: d.ext, name: d.name },
    target: { file: String(target.file || ''), folder: String(target.folder || ''), pageUrl: String(target.pageUrl || '') },
  };
}

export const LINK_REFUSED = 'The link expired or the site refused it. Reload the page, press play, and try again.';
export const LINK_EXPIRED_QUEUED = 'The link expired. Reload the page and press Download all again.';
/** What is said when an address that looked like a stream did not give one (what the reader reported goes to `detail`). */
export const NOT_A_STREAM = 'This link did not give a video StreamSnag can read. Reload the page, press play, and try again.';

/**
 * A download error in plain words: { text, detail }. A server that says no (401, 403, 404, 410, or Chrome's
 * SERVER_FORBIDDEN / SERVER_UNAUTHORIZED / SERVER_BAD_CONTENT) becomes one sentence that says what to do;
 * `detail` keeps what was really reported, for bug reports. Anything else is returned as it is.
 * `queued`: the download was waiting its turn when its link stopped working.
 * A stream whose playlist or manifest could not be read as one gets a sentence too, and `code` 'not-a-stream'.
 */
export function plainError(raw, { status = 0, queued = false } = {}) {
  const text = String(raw ?? '');
  if (/^Not an? (?:HLS playlist|DASH manifest)\b/.test(text)) return { text: NOT_A_STREAM, detail: text, code: 'not-a-stream' };
  const code = Number(status) || Number(/\bHTTP (\d{3})\b/.exec(text)?.[1]) || 0;
  const chrome = /\bSERVER_(FORBIDDEN|UNAUTHORIZED|BAD_CONTENT)\b/.exec(text)?.[1] || '';
  if (![401, 403, 404, 410].includes(code) && !chrome) return { text, detail: '' };
  const expired = [401, 403, 410].includes(code) || chrome === 'FORBIDDEN' || chrome === 'UNAUTHORIZED';
  return { text: queued && expired ? LINK_EXPIRED_QUEUED : LINK_REFUSED, detail: text };
}

/**
 * "After a download finishes" found no captions and nothing is set to make any: the one line that says
 * which steps were skipped and what would make them happen. '' when nothing was skipped.
 */
export function skippedNote(settings = {}) {
  const what = [settings.autoTranscript ? 'transcript' : '', settings.autoStudyPack ? 'study pack' : '', settings.autoStudyPage ? 'study page' : '', settings.autoRead ? 'reading edition' : ''].filter(Boolean);
  if (!what.length || settings.autoTranscribe) return '';
  const them = what.length > 1 ? 'them' : 'one';
  // "transcript", "transcript or study pack", "transcript, study pack or study page"
  const list = [what.slice(0, -1).join(', '), what.at(-1)].filter(Boolean).join(' or ');
  return `No captions, so no ${list}. Turn on transcription in Settings to make ${them}.`;
}

/**
 * The files a download leaves behind when it stops before its last file: the tracks already saved (a
 * video without its sound). None once every track is saved: a finished download is never touched.
 */
export function leftoverTracks(tracks = []) {
  const list = Array.isArray(tracks) ? tracks : [];
  if (!list.length || list.every((t) => t.status === 'done' || t.status === 'skipped')) return [];
  return list.filter((t) => t.status === 'done' && t.downloadId != null);
}

const RUNNING = ['running', 'recording', 'muxing'];

/** The bottom bar's line: "2 downloading · 1 converting · 1 transcribing · 1 making a study pack · 3 queued" (each part only when there is one). */
export function traySummary(jobs = []) {
  const running = jobs.filter((j) => RUNNING.includes(j.status));
  const copies = running.filter((j) => j.kind === 'convert').length;
  const speech = running.filter((j) => j.kind === 'transcribe').length;
  const packs = running.filter((j) => j.kind === 'studypack').length;
  const reads = running.filter((j) => j.kind === 'reading').length;
  const loading = running.length - copies - speech - packs - reads;
  const waiting = jobs.filter((j) => j.status === 'queued').length;
  return [
    loading ? `${loading} downloading` : '', copies ? `${copies} converting` : '', speech ? `${speech} transcribing` : '',
    packs ? `${packs} making ${packs === 1 ? 'a study pack' : 'study packs'}` : '',
    reads ? `${reads} tidying ${reads === 1 ? 'a reading edition' : 'reading editions'}` : '',
    waiting ? `${waiting} queued` : '',
  ].filter(Boolean).join(' · ');
}

const PACKAGES = {
  // @site-edition
  'yt-dlp': { win: 'yt-dlp.yt-dlp', other: 'yt-dlp' },
  // @end-site-edition
  ffmpeg: { win: 'Gyan.FFmpeg', other: 'ffmpeg' },
};

/**
 * How to install a tool the helper uses, for this kind of computer (`os` as chrome.runtime.getPlatformInfo
 * names it: 'win', 'mac', 'linux'…): winget on Windows, Homebrew on a Mac, the package manager elsewhere.
 */
export function installHint(tool, os) {
  const pkg = Object.hasOwn(PACKAGES, tool) ? PACKAGES[tool] : null;
  if (!pkg) return '';
  if (os === 'win') return `Install it with "winget install ${pkg.win}"`;
  if (os === 'mac') return `Install it with "brew install ${pkg.other}"`;
  return `Install it with your package manager (for example "sudo apt install ${pkg.other}")`;
}

/**
 * The "Transcribe on this computer" entry of a video's menu, for each state it can be in:
 * { state, label, enabled, reason, opens? }, or null when it has no place (captions already sit next to
 * the file, or the page has captions and transcription can't run here anyway).
 *  - `hasCaptions`: there are captions to read (so "Save transcript" is offered);
 *  - `localCaptions`: captions are already saved next to the downloaded file;
 *  - `downloaded`: the video counts as downloaded; `file`: where it is on this computer ('' if not found);
 *  - `helper`: what the local helper last said ({ ok, stt: { supported, ready } }), or null.
 * A video without captions always gets the entry, greyed out with the reason when it can't run yet.
 */
export function transcribeOffer({ hasCaptions = false, localCaptions = false, downloaded = false, file = '', helper = null } = {}) {
  if (localCaptions) return null;
  const label = 'Transcribe on this computer';
  const off = (state, reason) => (hasCaptions ? null : { state, label, enabled: false, reason });
  if (!downloaded) return off('download', 'Download it first, then transcribe it on this computer.');
  if (!helper?.ok) return off('helper', 'This needs the local helper. Set it up in Settings, on the Local helper tab.');
  if (!helper.stt?.supported) return off('unsupported', 'Transcription can\'t run on this kind of computer.');
  if (!file) return off('nofile', 'The downloaded file was not found in your folders, so it can\'t be transcribed.');
  if (!helper.stt.ready) {
    return {
      state: 'setup', label: `${label} (needs setup)`, enabled: true, opens: 'settings',
      reason: 'Turns speech into text on this computer. It needs a one-time setup in Settings first.',
    };
  }
  return { state: 'ready', label, enabled: true, reason: 'Turns the speech into text on this computer and saves it next to the video. Nothing is uploaded.' };
}

/**
 * The size a finished download goes on record with: its saved files, measured (`outputs`: [{ size }]).
 * `counted`: what was counted while it ran, used only when a file could not be measured.
 */
export function savedBytes(outputs, counted = 0) {
  const sizes = (outputs || []).map((o) => Number(o?.size) || 0);
  return sizes.length && sizes.every((n) => n > 0) ? sizes.reduce((a, b) => a + b, 0) : Number(counted) || 0;
}

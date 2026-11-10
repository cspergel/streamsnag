// Which quality to pick first (Settings → Downloads), and which page items "Download all" may start.
// Pure helpers shared by the service worker, the popup and tests.
import { rankVideoOptions } from './util.js';

/** The choices of the "Quality to pick first" setting. */
export const QUALITY_PREFS = ['best', '1080', '720', '480', 'smallest'];

// Encoders round the picture height up to a whole block: "1080p" is often stored as 1088 lines.
const HEIGHT_SLACK = 16;
// When a stream doesn't say its picture sizes, its bitrate is the only hint: the most a quality usually needs.
const BITRATE_CEILING = { 1080: 8e6, 720: 4.5e6, 480: 1.6e6 };

const heightOf = (o) => Number(o.height) || Number(/^(\d+)p/.exec(o.label || '')?.[1]) || 0;
const rateOf = (o) => {
  if (Number(o.bandwidth) > 0) return Number(o.bandwidth);
  const m = /([\d.]+)\s*(M|k)bps/i.exec(o.label || '');
  return m ? Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1e6 : 1e3) : 0;
};

/**
 * The video option to pick first from a stream's choices (as `inspect` lists them), for the setting
 * 'best' | '1080' | '720' | '480' | 'smallest':
 *  - a number is a cap: the best quality not above it, or the lowest there is when all are above it;
 *  - 'smallest' is the lowest quality; 'best' (and anything unknown) the highest.
 * Only ever a video option: audio-only and subtitle choices are never returned. Null when there is none.
 * Without picture heights the bitrate decides (a rough guide), and without that the order of the list.
 */
export function pickPreferred(options, pref = 'best') {
  const vids = rankVideoOptions(options); // best first; audio-only and subtitles left out
  if (!vids.length) return null;
  if (pref === 'smallest') return vids[vids.length - 1];
  const cap = QUALITY_PREFS.includes(String(pref)) ? Number(pref) : NaN;
  if (!(cap > 0)) return vids[0];
  // true: within the cap, false: above it, null: this option says nothing we can measure.
  const fits = (o) => {
    const h = heightOf(o);
    if (h) return h <= cap + HEIGHT_SLACK;
    const r = rateOf(o);
    return r ? r <= BITRATE_CEILING[cap] : null;
  };
  const within = vids.find((o) => fits(o) === true);
  if (within) return within;
  const measured = vids.filter((o) => fits(o) !== null);
  // Everything is above the cap: the lowest. Nothing can be told at all: the first, as listed.
  return measured.length ? measured[measured.length - 1] : vids[0];
}

/**
 * The few quality buttons of the big card: the best `max` video options (as ranked by rankVideoOptions),
 * with the chosen one always among them, so the quality set in Settings can be seen even when a stream
 * has more qualities than there is room for.
 */
export function qualityChips(ranked, chosen, max = 4) {
  const top = (ranked || []).slice(0, max);
  if (chosen && top.length && (ranked || []).includes(chosen) && !top.includes(chosen)) top[top.length - 1] = chosen;
  return top;
}

const BULK_KINDS = ['hls', 'dash', 'direct', 'embed'];

/**
 * May "Download all" start this page item? Single videos and audio files only: not playlists, protected
 * (DRM) items, subtitle files or live streams (a recording never ends on its own).
 */
export function canBulkDownload(m) {
  return !!m && BULK_KINDS.includes(m.kind) && !m.playlist && !m.protected && !m.info?.live && m.mediaType !== 'subtitle';
}

/** One line for the result of "Download all": {started, failed: [{error}]} → "Started 6, 1 couldn't start: …". */
export function bulkSummary({ started = 0, failed = [] } = {}) {
  const n = failed.length;
  if (!n) return started ? `Started ${started} download${started === 1 ? '' : 's'}.` : 'Nothing to download.';
  const reasons = [...new Set(failed.map((f) => String(f?.error || 'unknown reason')))];
  const why = `${reasons[0]}${reasons.length > 1 ? ' (and other reasons)' : ''}`;
  return started ? `Started ${started}, ${n} couldn't start: ${why}` : `None could start: ${why}`;
}

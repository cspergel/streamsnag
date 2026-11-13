// Which quality to pick first (Settings → Downloads), and which page items "Download all" may start.
// Pure helpers shared by the service worker, the popup and tests.
import { rankVideoOptions, formatBitrate } from './util.js';

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
 * The few quality buttons of the big card. One per picture size: the best of each (a stream often has
 * the same size at several bitrates; the others are under "Other formats"). Up to `max` + 1 sizes all
 * show, the lowest included; of more, the best `max`. The chosen one is always among them (in place of
 * its own size's best, else of the last), so the quality set in Settings can be seen.
 * `ranked`: the video options as rankVideoOptions orders them. Options that say no size are each their own.
 */
export function qualityChips(ranked, chosen, max = 4) {
  const list = ranked || [];
  const seen = new Set();
  const sizes = list.filter((o) => {
    const h = heightOf(o);
    if (!h) return true;
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
  const top = sizes.length <= max + 1 ? sizes : sizes.slice(0, max);
  if (chosen && top.length && list.includes(chosen) && !top.includes(chosen)) {
    const same = heightOf(chosen) ? top.findIndex((o) => heightOf(o) === heightOf(chosen)) : -1;
    top[same >= 0 ? same : top.length - 1] = chosen;
  }
  return top;
}

const VIDEO_CODEC = /(?:^|,)\s*(?:avc[13]|hvc1|hev1|vp0?[89]|av01|dvh[1e]|mp4v|theora)/i;
const AUDIO_CODEC = /(?:^|,)\s*(?:mp4a|ac-3|ec-3|opus|vorbis|flac|mp3)/i;

/** An HLS variant with sound and no picture: it says no picture size, and its codecs name only sound. */
export function audioOnly(v) {
  const codecs = String(v?.codecs || '');
  return !v?.height && !v?.width && AUDIO_CODEC.test(codecs) && !VIDEO_CODEC.test(codecs);
}

/** How one quality of a stream is listed: "720p · 1.2 Mbps", "1080p · 8.2 Mbps · 60fps", "Audio only · 136 kbps". */
export function variantLabel(v) {
  const res = audioOnly(v) ? 'Audio only' : v.height ? `${v.height}p` : v.width ? `${v.width}w` : 'Auto';
  return [res, formatBitrate(v.bandwidth), v.frameRate > 30 ? `${Math.round(v.frameRate)}fps` : ''].filter(Boolean).join(' · ');
}

/**
 * A stream's choices with every identical one listed once. A master playlist often lists one picture
 * size and bitrate several times over (once per sound format, or per video codec): rows that read the
 * same are one choice to a person. Of each such group the first is kept, except that a variant most
 * players and editors open (H.264 picture, AAC sound) is kept in place of one they may not.
 * `options`: [{ id, label, audio?, subtitle?, codecs? }]; `codecs` is only used here and is not passed on.
 */
export function uniqueChoices(options) {
  const plain = (o) => Number(/(?:^|,)\s*(?:hvc1|hev1|dvh[1e]|av01|vp0?9)/i.test(o.codecs || '')) + Number(/(?:^|,)\s*(?:ac-3|ec-3)/i.test(o.codecs || ''));
  const out = [];
  const at = new Map();
  for (const o of options || []) {
    const key = `${o.audio ? 'a' : o.subtitle ? 's' : 'v'}|${o.label}`;
    if (!at.has(key)) {
      at.set(key, out.length);
      out.push(o);
    } else if (plain(o) < plain(out[at.get(key)])) out[at.get(key)] = o;
  }
  return out.map(({ codecs, ...rest }) => rest);
}

const BULK_KINDS = ['hls', 'dash', 'direct', 'embed'];

/**
 * May "Download all" start this page item? Single videos and audio files only: not playlists, protected
 * (DRM) items, subtitle files or live streams (a recording never ends on its own). Nor an embedded player
 * that is still waiting to be looked up (`pending`): what it holds is not known yet.
 */
export function canBulkDownload(m) {
  return !!m && BULK_KINDS.includes(m.kind) && !m.playlist && !m.protected && !m.info?.live && m.mediaType !== 'subtitle' && !m.pending;
}

/** One line for the result of "Download all": {started, failed: [{error}]} → "Started 6, 1 couldn't start: …". */
export function bulkSummary({ started = 0, failed = [] } = {}) {
  const n = failed.length;
  if (!n) return started ? `Started ${started} download${started === 1 ? '' : 's'}.` : 'Nothing to download.';
  const reasons = [...new Set(failed.map((f) => String(f?.error || 'unknown reason')))];
  const why = `${reasons[0]}${reasons.length > 1 ? ' (and other reasons)' : ''}`;
  return started ? `Started ${started}, ${n} couldn't start: ${why}` : `None could start: ${why}`;
}

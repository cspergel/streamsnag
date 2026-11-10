// Download speed and time left, worked out from timestamped progress samples. Pure: no clock, no chrome.*.
import { formatBytes } from './util.js';

const WINDOW_MS = 10000; // the speed is the average over about the last 10 seconds
const WARMUP_MS = 2000; // the first moments say nothing reliable
const MIN_GAP_MS = 250; // samples closer together than this replace each other
const MAX_BYTES_PER_SEC = 1e10; // faster than any real connection: a counting glitch
const MAX_ETA_SECONDS = 99 * 3600; // longer than this is not an estimate worth showing

/** A fresh meter for one file of a download. */
export function newRate() {
  return { startedAt: 0, samples: [] };
}

/** Forget everything (a retry, or the job's next file). */
export function resetRate(meter) {
  meter.startedAt = 0;
  meter.samples = [];
  return meter;
}

/**
 * Add one progress sample: { at: ms, done, total, bytes }.
 * `done`/`total` are in whatever the download counts (bytes, segments or percent) and give the time
 * left; `bytes` (null when unknown) gives the speed. Progress that runs backwards means a new attempt:
 * the meter starts afresh. Samples that make no sense are ignored.
 */
export function feedRate(meter, sample) {
  const at = Number(sample?.at);
  const done = Number(sample?.done);
  if (!Number.isFinite(at) || !Number.isFinite(done) || done < 0) return meter;
  const total = Number.isFinite(Number(sample.total)) && Number(sample.total) > 0 ? Number(sample.total) : 0;
  const bytes = typeof sample.bytes === 'number' && Number.isFinite(sample.bytes) && sample.bytes >= 0 ? sample.bytes : null;
  const s = { at, done, total, bytes };
  const last = meter.samples[meter.samples.length - 1];
  if (last && (at < last.at || done < last.done || (bytes != null && last.bytes != null && bytes < last.bytes))) resetRate(meter);
  const list = meter.samples;
  // Still waiting for the first byte (the server is thinking): the clock starts when something arrives,
  // or the wait would count as a slow start.
  if (list.length === 1 && list[0].done === 0 && done === 0) list.pop();
  if (!list.length) meter.startedAt = at;
  if (list.length >= 2 && at - list[list.length - 2].at < MIN_GAP_MS) list[list.length - 1] = s;
  else list.push(s);
  // Keep the window, plus the newest sample from before it: that one is where a stall is measured from.
  while (list.length > 2 && list[1].at <= at - WINDOW_MS) list.shift();
  return meter;
}

/**
 * The speed and time left at time `now`: { bytesPerSec, etaSeconds }, each null when it can't be told
 * (too early, no byte counts, no total, stalled). Never negative, NaN or absurd.
 * The speed is measured from the newest sample at least 10 s old up to `now`, so a stall slows it down
 * to zero, and a burst after a stall is spread over the wait instead of looking like a huge speed.
 */
export function readRate(meter, now) {
  const none = { bytesPerSec: null, etaSeconds: null };
  const list = meter?.samples || [];
  if (list.length < 2) return none;
  const last = list[list.length - 1];
  const t = Number.isFinite(Number(now)) ? Math.max(Number(now), last.at) : last.at;
  if (t - meter.startedAt < WARMUP_MS) return none;
  let from = list[0];
  for (const s of list) {
    if (s.at <= t - WINDOW_MS) from = s;
    else break;
  }
  const seconds = (t - from.at) / 1000;
  if (!(seconds >= 1)) return none;
  const sane = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const bytesPerSec = last.bytes != null && from.bytes != null ? sane((last.bytes - from.bytes) / seconds, MAX_BYTES_PER_SEC) : null;
  const perSec = (last.done - from.done) / seconds;
  const etaSeconds = last.total > 0 && perSec > 0 ? sane((last.total - last.done) / perSec, MAX_ETA_SECONDS) : null;
  return { bytesPerSec, etaSeconds };
}

/** "about 40 s left", "about 2 min left", "about 1 h 5 min left"; '' when there is no believable estimate. */
export function formatEta(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_ETA_SECONDS) return '';
  if (seconds < 5) return 'a few seconds left';
  // Seconds in steps of five, so the text doesn't flicker; "60 s" is a minute.
  const s = Math.round(seconds / 5) * 5;
  if (s < 60) return `about ${s} s left`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  return min % 60 ? `about ${h} h ${min % 60} min left` : `about ${h} h left`;
}

/** "3.1 MB/s"; '' when the speed is unknown or nothing is arriving. */
export function formatRate(bytesPerSec) {
  if (typeof bytesPerSec !== 'number' || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  return `${formatBytes(bytesPerSec)}/s`;
}

/** "3.1 MB/s · about 2 min left" for a job's { bytesPerSec, etaSeconds }; '' when neither is known. */
export function rateText(rate) {
  if (!rate) return '';
  return [formatRate(rate.bytesPerSec), formatEta(rate.etaSeconds)].filter(Boolean).join(' · ');
}

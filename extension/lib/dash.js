// DASH (.mpd) manifest parser -> concrete per-representation segment lists.
import { parseXML, child, childrenOf, findAll } from './xml.js';
import { resolveUrl } from './util.js';

/** ISO-8601 duration ("PT1H2M3.5S", "P1DT2H") -> seconds. */
export function parseIsoDuration(str) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(str || '').trim());
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + mi * 60 + s;
}

/** Expand a SegmentTemplate URL ($RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$). */
export function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (m, name, width) => {
    if (name === '') return '$';
    const map = { RepresentationID: vars.id, Number: vars.number, Time: vars.time, Bandwidth: vars.bandwidth };
    let v = map[name];
    if (v == null) return m;
    v = String(v);
    return width ? v.padStart(Number(width), '0') : v;
  });
}

function baseUrlOf(el, parentBase) {
  const b = child(el, 'BaseURL');
  return b && b.text ? resolveUrl(b.text, parentBase) : parentBase;
}

function parseRange(r) {
  const m = /^(\d+)-(\d+)$/.exec(String(r || '').trim());
  return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1, end: Number(m[2]) } : null;
}

function mergedTemplate(...els) {
  // Later elements override earlier ones (AdaptationSet -> Representation).
  let attrs = null;
  let timeline = null;
  for (const el of els) {
    const t = child(el, 'SegmentTemplate');
    if (!t) continue;
    attrs = { ...(attrs || {}), ...t.attrs };
    const tl = child(t, 'SegmentTimeline');
    if (tl) timeline = tl;
  }
  return attrs ? { attrs, timeline } : null;
}

function classify(as, rep) {
  const ct = (as.attrs.contentType || '').toLowerCase();
  const mime = (rep.attrs.mimeType || as.attrs.mimeType || '').toLowerCase();
  const codecs = (rep.attrs.codecs || as.attrs.codecs || '').toLowerCase();
  if (ct === 'text' || mime.startsWith('text/') || mime.includes('ttml') || /stpp|wvtt/.test(codecs)) return 'subtitle';
  if (ct === 'audio' || mime.startsWith('audio/')) return 'audio';
  if (ct === 'video' || mime.startsWith('video/')) return 'video';
  if (ct === 'image' || mime.startsWith('image/')) return 'image';
  return 'video';
}

// Stands in for $Number$ / $Time$ while the shape of a segment address is worked out.
const PLACE = '7730077300773';

function segmentsFromTemplate(tpl, rep, base, periodDuration) {
  const a = tpl.attrs;
  const timescale = Number(a.timescale) || 1;
  const startNumber = a.startNumber != null ? Number(a.startNumber) : 1;
  const vars = { id: rep.attrs.id, bandwidth: rep.attrs.bandwidth };
  const init = a.initialization ? { url: resolveUrl(fillTemplate(a.initialization, vars), base), range: null } : null;
  const segments = [];
  if (!a.media) return { init, segments };
  // The shape of every segment's address: what comes before and after its number (or time). A live stream
  // lists no segments and a long one lists thousands: the shape names them all (lib/parts.js).
  const shaped = (resolveUrl(fillTemplate(a.media, { ...vars, number: PLACE, time: PLACE }), base) || '').split(PLACE);
  const pattern = shaped.length === 2 ? shaped : null;

  if (tpl.timeline) {
    let number = startNumber;
    let time = 0;
    const ss = childrenOf(tpl.timeline, 'S');
    const periodEnd = periodDuration ? periodDuration * timescale : Infinity;
    ss.forEach((s, idx) => {
      if (s.attrs.t != null) time = Number(s.attrs.t);
      const d = Number(s.attrs.d) || 0;
      let r = s.attrs.r != null ? Number(s.attrs.r) : 0;
      if (r < 0) {
        // Repeat until the next S@t or the end of the period.
        const next = ss[idx + 1]?.attrs.t;
        const until = next != null ? Number(next) : periodEnd;
        r = Number.isFinite(until) && d > 0 ? Math.max(0, Math.ceil((until - time) / d) - 1) : 0;
      }
      for (let k = 0; k <= r; k++) {
        segments.push({ url: resolveUrl(fillTemplate(a.media, { ...vars, number, time }), base), duration: d / timescale });
        time += d;
        number++;
      }
    });
  } else {
    const dur = Number(a.duration) || 0;
    const count = dur > 0 && periodDuration > 0 ? Math.ceil((periodDuration * timescale) / dur) : 0;
    for (let k = 0; k < count; k++) {
      const number = startNumber + k;
      segments.push({
        url: resolveUrl(fillTemplate(a.media, { ...vars, number, time: k * dur }), base),
        duration: dur / timescale,
      });
    }
  }
  return { init, segments, pattern };
}

function segmentsFromList(list, base) {
  const initEl = child(list, 'Initialization');
  const init = initEl
    ? { url: resolveUrl(initEl.attrs.sourceURL || '', base), range: parseRange(initEl.attrs.range) }
    : null;
  const segments = childrenOf(list, 'SegmentURL').map((s) => ({
    url: resolveUrl(s.attrs.media || '', base),
    range: parseRange(s.attrs.mediaRange),
  }));
  return { init, segments };
}

/**
 * @returns {{dynamic:boolean, duration:number, protected:boolean, video:any[], audio:any[], subtitles:any[]}}
 */
export function parseMPD(text, mpdUrl) {
  const mpd = parseXML(text);
  if (mpd.name !== 'MPD') throw new Error('Not a DASH manifest (root is not <MPD>)');
  const dynamic = (mpd.attrs.type || 'static') === 'dynamic';
  const duration = parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const isProtected = findAll(mpd, 'ContentProtection').length > 0;
  const mpdBase = baseUrlOf(mpd, mpdUrl);
  const out = { dynamic, duration, protected: isProtected, video: [], audio: [], subtitles: [] };

  const periods = childrenOf(mpd, 'Period');
  const period = periods[0];
  if (!period) return out;
  const periodDuration = parseIsoDuration(period.attrs.duration) || duration;
  const periodBase = baseUrlOf(period, mpdBase);

  for (const as of childrenOf(period, 'AdaptationSet')) {
    const asBase = baseUrlOf(as, periodBase);
    for (const rep of childrenOf(as, 'Representation')) {
      const base = baseUrlOf(rep, asBase);
      const kind = classify(as, rep);
      if (kind === 'image') continue;
      let init = null;
      let segments = [];
      let pattern = null; // [before, after] the number in a templated segment address
      const tpl = mergedTemplate(period, as, rep);
      const list = child(rep, 'SegmentList') || child(as, 'SegmentList');
      if (tpl) ({ init, segments, pattern = null } = segmentsFromTemplate(tpl, rep, base, periodDuration));
      else if (list) ({ init, segments } = segmentsFromList(list, base));
      else segments = [{ url: base }]; // SegmentBase or plain BaseURL: one whole file.

      const entry = {
        id: rep.attrs.id || `${kind}${out[kind === 'subtitle' ? 'subtitles' : kind].length}`,
        kind,
        bandwidth: Number(rep.attrs.bandwidth) || 0,
        width: Number(rep.attrs.width || as.attrs.width) || 0,
        height: Number(rep.attrs.height || as.attrs.height) || 0,
        codecs: rep.attrs.codecs || as.attrs.codecs || '',
        mimeType: rep.attrs.mimeType || as.attrs.mimeType || '',
        lang: as.attrs.lang || rep.attrs.lang || '',
        label: child(as, 'Label')?.text || '',
        init,
        segments,
        pattern,
      };
      (kind === 'subtitle' ? out.subtitles : out[kind]).push(entry);
    }
  }
  out.video.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
  out.audio.sort((x, y) => y.bandwidth - x.bandwidth);
  return out;
}

export function dashExt(rep) {
  const mime = rep.mimeType.toLowerCase();
  if (rep.kind === 'subtitle') return mime.includes('vtt') ? 'vtt' : mime.includes('ttml') ? 'ttml' : 'mp4';
  if (mime.includes('webm')) return rep.kind === 'audio' ? 'weba' : 'webm';
  return rep.kind === 'audio' ? 'm4a' : 'mp4';
}

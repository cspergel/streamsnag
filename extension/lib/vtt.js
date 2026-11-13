// Subtitle helpers: merge HLS WebVTT segments, convert SRT -> VTT, and flatten to plain text
// (for AI summaries).

/** Join WebVTT segment files into one file, keeping a single header and dropping duplicate cues. */
export function mergeVttSegments(texts) {
  const seen = new Set();
  const cues = [];
  for (const t of texts) {
    const body = String(t || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const blocks = body.split(/\n{2,}/);
    for (const block of blocks) {
      const b = block.trim();
      if (!b || /^WEBVTT/.test(b) || /^(NOTE|STYLE|REGION)\b/.test(b) || /^X-TIMESTAMP-MAP/.test(b)) continue;
      if (!/-->/.test(b)) continue;
      const key = b.replace(/^\S+\n(?=.*-->)/, ''); // ignore cue ids when de-duplicating
      if (seen.has(key)) continue;
      seen.add(key);
      cues.push(b);
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export function srtToVtt(srt) {
  const body = String(srt || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  return `WEBVTT\n\n${body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}\n`;
}

function toSeconds(ts) {
  const parts = ts.replace(',', '.').split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function stamp(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * Flatten VTT/SRT into "[m:ss] text" lines, one per ~`everySec` seconds, removing the rolling
 * duplicate lines that auto-captions produce.
 */
export function captionsToText(vttOrSrt, everySec = 30) {
  const body = String(vttOrSrt || '').replace(/\r\n?/g, '\n');
  const lines = [];
  let bucketStart = -Infinity;
  let bucket = [];
  let last = '';
  const flush = () => {
    if (bucket.length) lines.push(`[${stamp(bucketStart)}] ${bucket.join(' ')}`);
    bucket = [];
  };
  for (const block of body.split(/\n{2,}/)) {
    const m = /(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->/.exec(block);
    if (!m) continue;
    const start = toSeconds(m[0].replace(/\s*-->$/, '').trim());
    const nl = block.indexOf('\n', block.indexOf('-->'));
    const after = nl < 0 ? '' : block.slice(nl + 1);
    const text = after
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // A machine-made cue identifier copied into the text by a converter is not something that was said.
      .filter((l) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+)?$/i.test(l));
    for (const t of text) {
      if (t === last) continue;
      last = t;
      if (start - bucketStart >= everySec) {
        flush();
        bucketStart = start;
      }
      bucket.push(t);
    }
  }
  flush();
  return lines.join('\n');
}

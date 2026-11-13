// Offscreen document: downloads stream segments in parallel, joins them into one Blob and hands a
// blob: URL back to the service worker (which cannot create object URLs itself).
import { parseM3U8, liveStart } from './lib/hls.js';
import { mergeVttSegments } from './lib/vtt.js';

const active = new Map(); // jobId -> { controller, stopController, stopLive }

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url.slice(0, 200)}`);
    this.status = status;
  }
}

async function fetchPart(part, signal, asText = false, retries = 4) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = {};
      if (part.range) headers.Range = `bytes=${part.range.offset}-${part.range.end}`;
      const res = await fetch(part.url, { signal, headers, credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new HttpError(res.status, part.url);
      return asText ? await res.text() : await res.blob();
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      // 4xx other than 408/429 will not get better by retrying.
      if (e.status && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) break;
      await sleep(500 * 2 ** attempt, signal);
    }
  }
  throw lastErr;
}

async function pool(items, concurrency, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

function progressReporter(jobId, trackIndex) {
  let lastAt = 0;
  return (state, force = false) => {
    const now = Date.now();
    if (!force && now - lastAt < 400) return;
    lastAt = now;
    send({ type: 'trackProgress', jobId, trackIndex, ...state });
  };
}

async function runVod(job, plan, report) {
  const { signal } = job.controller;
  const asText = plan.merge === 'vtt';
  const parts = new Array(plan.segments.length);
  let done = 0;
  let bytes = 0;
  const total = plan.segments.length + (plan.init ? 1 : 0);
  let initPart = null;
  if (plan.init) {
    initPart = await fetchPart(plan.init, signal);
    bytes += initPart.size;
    done++;
  }
  await pool(plan.segments, plan.concurrency || 6, async (seg, i) => {
    const p = await fetchPart(seg, signal, asText);
    parts[i] = p;
    done++;
    bytes += asText ? p.length : p.size;
    report({ done, total, bytes });
  });
  report({ done, total, bytes }, true);
  if (asText) return new Blob([mergeVttSegments(parts)], { type: 'text/vtt' });
  return new Blob(initPart ? [initPart, ...parts] : parts, { type: plan.mime || 'video/mp2t' });
}

/** Live HLS: keep polling the media playlist and append new segments until stopped or ENDLIST. */
async function runLive(job, plan, report) {
  const { signal } = job.controller;
  const parts = [];
  let initPart = null;
  let lastSeq = -1;
  let started = false; // the first playlist has been read
  let bytes = 0;
  let ended = false;
  let failures = 0;
  while (!job.stopLive && !ended) {
    let media;
    try {
      const res = await fetch(plan.live.playlistUrl, { signal, credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new HttpError(res.status, plan.live.playlistUrl);
      media = parseM3U8(await res.text(), plan.live.playlistUrl);
      failures = 0;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (++failures > 5) throw e;
      await sleep(2000, signal);
      continue;
    }
    if (media.type !== 'media') throw new Error('Live playlist is not a media playlist');
    if (!initPart && media.init) initPart = await fetchPart(media.init, signal);
    // A recording starts from now: of the window of the past a live playlist holds, only its last pieces.
    if (!started) {
      started = true;
      lastSeq = liveStart(media.segments);
    }
    const fresh = media.segments.filter((s) => s.sequence > lastSeq);
    for (const seg of fresh) {
      if (signal.aborted) break;
      try {
        const b = await fetchPart(seg, signal);
        parts.push(b);
        bytes += b.size;
      } catch (e) {
        if (e.name === 'AbortError') throw e; // segment expired; skip it
      }
      lastSeq = seg.sequence;
      report({ done: parts.length, total: 0, bytes, live: true });
    }
    ended = media.endList;
    if (!ended && !job.stopLive) {
      // The stop controller only interrupts this wait, so "Stop recording" keeps what we have.
      await sleep(Math.max(1000, (media.targetDuration || 4) * 500), job.stopController.signal).catch(() => {});
    }
  }
  report({ done: parts.length, total: parts.length, bytes, live: true }, true);
  if (!parts.length) throw new Error('No live segments were recorded');
  return new Blob(initPart ? [initPart, ...parts] : parts, { type: plan.mime || 'video/mp2t' });
}

async function runTrack(msg) {
  const { jobId, trackIndex, plan } = msg;
  const job = active.get(jobId) || { controller: new AbortController(), stopController: new AbortController(), stopLive: false };
  active.set(jobId, job);
  const report = progressReporter(jobId, trackIndex);
  try {
    const blob = plan.live ? await runLive(job, plan, report) : await runVod(job, plan, report);
    const blobUrl = URL.createObjectURL(blob);
    send({ type: 'trackDone', jobId, trackIndex, blobUrl, size: blob.size });
  } catch (e) {
    const canceled = e.name === 'AbortError';
    send({ type: 'trackError', jobId, trackIndex, error: canceled ? 'Canceled' : e.message, status: e.status || 0, canceled });
  }
}

// Only the extension's own pages and its worker may ask this page for anything (a content script may not): it
// fetches and reads files with the extension's rights. (Security review, 2026-11-12.)
const fromExtension = (sender) => sender?.id === chrome.runtime.id && String(sender?.url || '').startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || !fromExtension(sender)) return;
  if (msg.type === 'runTrack') {
    runTrack(msg);
    sendResponse({ ok: true });
  } else if (msg.type === 'cancel') {
    const job = active.get(msg.jobId);
    job?.controller.abort();
    active.delete(msg.jobId);
    sendResponse({ ok: true });
  } else if (msg.type === 'stopLive') {
    const job = active.get(msg.jobId);
    if (job) {
      job.stopLive = true;
      job.stopController.abort();
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'jobFinished') {
    active.delete(msg.jobId);
    sendResponse({ ok: true });
  } else if (msg.type === 'revoke') {
    try { URL.revokeObjectURL(msg.url); } catch { /* ignore */ }
    sendResponse({ ok: true });
  } else if (msg.type === 'ping') {
    sendResponse({ ok: true });
  }
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || !fromExtension(sender)) return false;
  if (msg.type === 'textBlob') {
    const type = msg.mime === 'text/html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
    sendResponse({ ok: true, blobUrl: URL.createObjectURL(new Blob([String(msg.text ?? '')], { type })) });
  }
  return false;
});

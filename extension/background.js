// StreamSnag service worker: sniffs media, runs download jobs, talks to the AI and the local helper.
import { classifyResponse, classifyUrl, dedupeKey, sameMedia, streamFingerprint, mediaExtFromUrl } from './lib/detect.js';
import { parseM3U8, outputExtForMedia } from './lib/hls.js';
import { parseMPD, dashExt } from './lib/dash.js';
import { mergeVttSegments, captionsToText, srtToVtt } from './lib/vtt.js';
import { runRecipe, selectorsFor, normalizeRecipe } from './lib/recipes.js';
import {
  buildFindPrompt, buildDiagnosePrompt, buildSummaryPrompt, buildFilenamePrompt,
  normalizeFindResult, normalizeSummary, summaryToMarkdown,
} from './lib/ai.js';
import { callAI, helperRequest } from './lib/ai-transport.js';
import { getSettings } from './lib/settings.js';
import { findInLibrary, nameKey, serviceId, leadNumber, sameItem } from './lib/match.js';
import { applyRefererRules, installLocalGuard, allowLocal } from './lib/headers.js';

// Settings (with the API key) and history are for StreamSnag's own pages, not for scripts running in web pages.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
// Block the extension's own requests to local-network addresses unless a host is let through (headers.js).
const guardReady = installLocalGuard().catch(() => {});
import {
  buildFilename, sanitizeFilename, formatBytes, formatBitrate, formatDuration, hostOf, siteKey,
  shortId, extFromUrl, isHttpUrl, resolveFolder, rulesFor, registrableDomain, isPrivateHost, pickPlaying,
} from './lib/util.js';

// ---------------------------------------------------------------- settings

// ---------------------------------------------------------------- per-tab state

const tabs = new Map(); // tabId -> {media: [], log: [], pageUrl, pageTitle, masters: Set, aiResult}
const tabLoads = new Map();
const persistTimers = new Map();

async function getTab(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  if (!tabLoads.has(tabId)) {
    tabLoads.set(tabId, (async () => {
      const key = `tab:${tabId}`;
      const stored = (await chrome.storage.session.get(key))[key];
      const t = stored
        ? { ...stored, childKeys: new Set(stored.childKeys || []) }
        : { media: [], log: [], pageUrl: '', pageTitle: '', childKeys: new Set(), aiResult: null };
      if (!tabs.has(tabId)) tabs.set(tabId, t);
      return tabs.get(tabId);
    })());
  }
  return tabLoads.get(tabId);
}

function persistTab(tabId) {
  clearTimeout(persistTimers.get(tabId));
  persistTimers.set(tabId, setTimeout(() => {
    const t = tabs.get(tabId);
    if (!t) return;
    chrome.storage.session.set({ [`tab:${tabId}`]: { ...t, childKeys: [...t.childKeys] } }).catch(() => {});
  }, 300));
  updateBadge(tabId);
  if (tabs.get(tabId)?.media?.length) debugSnapshot(tabId);
}

function visibleMedia(t) {
  return t.media.filter((m) => !m.hidden && !m.covered);
}

function updateBadge(tabId) {
  const t = tabs.get(tabId);
  const n = t ? visibleMedia(t).filter((m) => m.kind !== 'subtitle').length : 0;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#e8590c' }).catch(() => {});
}

async function refreshTabInfo(tabId, t) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && isHttpUrl(tab.url)) t.pageUrl = tab.url;
    if (tab.title) t.pageTitle = tab.title;
  } catch { /* tab gone */ }
}

function describe(m) {
  const kindLabel = m.kind === 'embed'
    ? `${PROVIDER_NAMES[m.provider] || 'Embedded'} player`
    : { hls: 'HLS', dash: 'DASH', subtitle: 'Subtitles' }[m.kind] || (m.ext || 'file').toUpperCase();
  const bits = [kindLabel];
  if (m.info?.live) bits.push('LIVE');
  if (m.info?.maxHeight) bits.push(`up to ${m.info.maxHeight}p`);
  if (m.info?.variantCount > 1) bits.push(`${m.info.variantCount} qualities`);
  if (m.info?.duration) bits.push(formatDuration(m.info.duration));
  if (m.size && (m.kind === 'direct' || m.kind === 'subtitle')) bits.push(formatBytes(m.size));
  if (m.lang) bits.push(m.lang);
  if (m.protected) bits.push('DRM/encrypted');
  return bits.join(' · ');
}

async function fetchText(url, { maxBytes = 5_000_000 } = {}) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} fetching ${url.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

/** Fetch an HLS/DASH manifest once to learn what it is (master vs. variant, live, DRM, qualities). */
/**
 * May StreamSnag fetch this URL on its own (to read a size or a stream), without a click? Not into a private
 * network (router, NAS, localhost) from a public page: that would let any page make your browser poke them.
 */
function autoFetchAllowed(url, pageUrl) {
  const target = hostOf(url);
  if (!isPrivateHost(target)) return true;
  return !!pageUrl && isPrivateHost(hostOf(pageUrl)); // a page that is itself local (a dev server, a NAS UI)
}

/** A preview image the popup may load: a web address, and not a local-network one unless the page is local. */
function safePoster(url, pageUrl) {
  return isHttpUrl(url) && autoFetchAllowed(url, pageUrl) ? url : '';
}

async function probeStream(tabId, m) {
  const t = await getTab(tabId);
  if (!autoFetchAllowed(m.url, m.pageUrl || t.pageUrl)) return;
  try {
    await applyRefererRules([m.url], m.pageUrl || t.pageUrl);
    const text = await fetchText(m.url);
    if (m.kind === 'hls' || /^\s*#EXTM3U/.test(text)) {
      m.kind = 'hls';
      const pl = parseM3U8(text, m.url);
      if (pl.type === 'master') {
        const keys = [...pl.variants.map((v) => v.url), ...pl.audio.map((a) => a.url), ...pl.subtitles.map((s) => s.url)]
          .filter(Boolean).map(dedupeKey);
        keys.forEach((k) => t.childKeys.add(k));
        for (const other of t.media) if (other !== m && t.childKeys.has(other.key) && !other.dismissed) other.hidden = true;
        m.fingerprint = streamFingerprint(pl.variants.map((v) => v.url), 'hls-master');
        m.info = {
          master: true,
          variantCount: pl.variants.length,
          maxHeight: pl.variants[0]?.height || 0,
          hasSubtitles: pl.subtitles.length > 0,
          hasAltAudio: pl.audio.some((a) => a.url),
        };
        m.protected = pl.protected;
        // The length (from one quality's playlist) lets us recognise the saved file later, even renamed.
        if (pl.variants[0]?.url && !pl.protected) {
          try {
            const vpl = parseM3U8(await fetchText(pl.variants[0].url), pl.variants[0].url);
            if (vpl.endList) m.info.duration = vpl.totalDuration;
            else m.info.live = true;
          } catch { /* length is optional */ }
        }
      } else {
        m.info = { master: false, live: !pl.endList, duration: pl.totalDuration, segments: pl.segments.length };
        if (pl.endList) m.fingerprint = streamFingerprint(pl.segments.map((x) => x.url), 'hls-media');
        m.protected = pl.protected;
        if (pl.segmentExt === 'vtt' || pl.segmentExt === 'webvtt') m.mediaType = 'subtitle';
      }
    } else if (m.kind === 'dash' || /<MPD[\s>]/.test(text)) {
      m.kind = 'dash';
      const mpd = parseMPD(text, m.url);
      m.protected = mpd.protected;
      m.fingerprint = mpd.dynamic ? '' : streamFingerprint([...mpd.video, ...mpd.audio].map((r) => r.segments?.[0]?.url || r.initUrl || r.baseUrl || r.id), `dash|${Math.round(mpd.duration || 0)}`);
      m.info = {
        live: mpd.dynamic,
        duration: mpd.duration,
        maxHeight: mpd.video[0]?.height || 0,
        variantCount: mpd.video.length,
        hasSubtitles: mpd.subtitles.length > 0,
      };
    }
  } catch (e) {
    m.probeError = e.message;
  }
  m.label = describe(m);
  mergeDuplicates(t, m);
  persistTab(tabId);
}

// ---------------------------------------------------------------- embedded players
// Vimeo/Wistia players in tabs or accordions that were never opened don't load anything, so nothing
// shows up in network traffic. Their public player config says where the stream is and what it's called.

const PROVIDER_NAMES = {
  'vimeo-showcase': 'Vimeo showcase',
  'vimeo-event': 'Vimeo live event',
  vimeo: 'Vimeo', wistia: 'Wistia', youtube: 'YouTube', loom: 'Loom', dailymotion: 'Dailymotion',
  jwplayer: 'JW Player', brightcove: 'Brightcove', kaltura: 'Kaltura',
};

async function fetchJson(url, pageUrl) {
  await applyRefererRules([url], pageUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Vimeo's player config → its HLS stream (all qualities), or the best progressive MP4. */
async function vimeoMedia({ id, hash }, pageUrl) {
  const cfg = await fetchJson(`https://player.vimeo.com/video/${id}/config${hash ? `?h=${encodeURIComponent(hash)}` : ''}`, pageUrl);
  const v = cfg.video || {};
  const files = cfg.request?.files || {};
  const meta = { title: v.title || '', duration: v.duration || 0, poster: v.thumbs?.base || v.thumbs?.['640'] || '' };
  const hls = files.hls?.cdns && (files.hls.cdns[files.hls.default_cdn] || Object.values(files.hls.cdns)[0]);
  const hlsUrl = hls?.avc_url || hls?.url;
  if (hlsUrl) return [{ ...meta, url: hlsUrl, info: { kind: 'hls', mediaType: 'stream', ext: 'm3u8', size: null, contentType: '' } }];
  const best = [...(files.progressive || [])].filter((f) => f.url).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (best) return [{ ...meta, url: best.url, info: { kind: 'direct', mediaType: 'video', ext: 'mp4', size: null, contentType: 'video/mp4' } }];
  return [];
}

/** Wistia's media JSON → the best MP4 rendition. */
async function wistiaMedia({ id }, pageUrl) {
  const j = await fetchJson(`https://fast.wistia.net/embed/medias/${id}.json`, pageUrl);
  const media = j.media || {};
  const mp4s = (media.assets || []).filter((a) => a.url && /mp4|hd_|md_|sd_|iphone/i.test(`${a.type} ${a.container || ''}`) && a.width);
  const best = mp4s.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  if (!best) return [];
  const still = (media.assets || []).find((a) => a.type === 'still_image')?.url || '';
  return [{
    title: media.name || '', duration: media.duration || 0, poster: still,
    url: best.url.replace(/\.bin(\?|$)/, '.mp4$1'),
    info: { kind: 'direct', mediaType: 'video', ext: 'mp4', size: best.size || null, contentType: 'video/mp4' },
  }];
}

const EMBED_RESOLVERS = { vimeo: vimeoMedia, wistia: wistiaMedia };

async function resolveEmbed(tabId, it) {
  const t = await getTab(tabId);
  const { provider, id } = it.embed || {};
  if (!provider || !id) return;
  const ekey = `${provider}:${id}`;
  t.embeds = t.embeds || {};
  if (t.embeds[ekey]) return; // already handled on this page
  t.embeds[ekey] = Date.now();
  const fallbackName = it.label || it.section || '';
  let found = [];
  try {
    if (EMBED_RESOLVERS[provider]) found = await EMBED_RESOLVERS[provider](it.embed, t.pageUrl);
  } catch (e) {
    t.embedErrors = { ...(t.embedErrors || {}), [ekey]: e.message };
  }
  const tag = (m, title) => {
    if (!m) return;
    if (!m.title && title) {
      m.title = title;
      m.nameSource = 'embed';
    }
    m.provider = provider;
    m.embedUrl = it.url;
    if (provider !== 'vimeo-showcase' && provider !== 'vimeo-event') m.embedId = m.embedId || id;
    if (it.section) m.section = it.section;
    m.label = describe(m);
  };
  if (found.length) {
    for (const f of found) {
      const m = await addMedia(tabId, { ...f.info, url: f.url, source: 'embed', duration: f.duration, poster: f.poster });
      tag(m, f.title || fallbackName);
    }
  } else {
    // Can't see inside this player (YouTube, private video...): offer it to yt-dlp instead.
    const pageUrl = provider === 'vimeo-showcase' ? `https://vimeo.com/showcase/${id}`
      : provider === 'vimeo-event' ? `https://vimeo.com/event/${id}` : it.url;
    const m = await addMedia(tabId, { url: pageUrl, kind: 'embed', mediaType: 'video', ext: '', size: null, contentType: '', source: 'embed' });
    tag(m, fallbackName || `${PROVIDER_NAMES[provider] || 'Embedded'} ${provider === 'vimeo-showcase' ? id : 'video'}`);
    if (m) m.playlist = provider === 'vimeo-showcase';
  }
  persistTab(tabId);
}

// ---------------------------------------------------------------- duplicates
// The same video often shows up under several URLs: re-signed CDN links, a page URL that redirects to
// the real file, the same stream listed again with a fresh token. Merge those into one item.

/** Diagnostics: what was merged into what, and why (kept short; see debugSnapshot). */
function noteMerge(t, keep, dup, why) {
  t.merges = [...(t.merges || []), { at: Date.now(), why, keep: [keep.title || '', keep.key], dup: [dup.title || '', dup.key || dup.url] }].slice(-60);
}

// A compact picture of the last active tab, saved where it survives a service-worker restart, so a
// detection problem on a real site can be looked at afterwards.
let debugTimer = null;
function debugSnapshot(tabId) {
  clearTimeout(debugTimer);
  debugTimer = setTimeout(async () => {
    const t = tabs.get(tabId);
    if (!t?.pageUrl || !(await cachedSettings()).debugMode) return; // only when "Diagnostic snapshots" is on
    const short = (u) => String(u || '').slice(0, 260);
    const snap = {
      at: Date.now(),
      page: t.pageUrl,
      media: t.media.map((m) => ({
        title: m.title || '', kind: m.kind, key: short(m.key), aliases: (m.aliases || []).map(short).slice(-6), seen: m.seen || 1,
        hidden: !!m.hidden, dismissed: !!m.dismissed, frameId: m.frameId || 0, detectedAt: m.detectedAt, duration: m.info?.duration || 0,
        fingerprint: short(m.fingerprint), nameSource: m.nameSource || '', provider: m.provider || '',
      })),
      merges: t.merges || [],
      log: t.log.filter((x) => /m3u8|\.mpd|master\.json|playlist\.json|\/config|vimeo/i.test(x.url)).slice(-120)
        .map((x) => ({ url: short(x.url), type: x.type, ct: x.contentType, status: x.status })),
      redirects: Object.entries(t.redirects || {}).slice(-40).map(([a, b]) => [short(a), short(b)]),
      childKeys: [...(t.childKeys || [])].slice(-40).map(short),
    };
    chrome.storage.local.set({ debugTab: snap }).catch(() => {});
  }, 1500);
}

function canonicalKey(t, key) {
  let k = key;
  for (let i = 0; i < 6 && t.redirects?.[k]; i++) k = t.redirects[k];
  return k;
}

function keysOf(m) {
  return [m.key, ...(m.aliases || [])];
}

/** Fold `dup` into `keep`: one card, newest usable URL, every URL it was seen under. */
function absorb(t, keep, dup, why = 'same file') {
  noteMerge(t, keep, dup, why);
  const preferDup = dup.source === 'network' && (keep.source !== 'network' || dup.detectedAt > keep.detectedAt);
  const allKeys = [...new Set([...keysOf(keep), ...keysOf(dup)])];
  if (preferDup) {
    keep.url = dup.url; // the freshest signed link is the one most likely to still work
    keep.key = dup.key;
  }
  keep.aliases = allKeys.filter((k) => k !== keep.key).slice(-30);
  for (const f of ['size', 'poster', 'title', 'course', 'nameSource', 'customName', 'fingerprint', 'contentType']) {
    if (!keep[f] && dup[f]) keep[f] = dup[f];
  }
  if (dup.info && !keep.info) keep.info = dup.info;
  if (dup.info?.duration && !keep.info?.duration) keep.info = { ...(keep.info || {}), duration: dup.info.duration };
  if (dup.source === 'ai' || dup.alsoAi) keep.alsoAi = true;
  keep.seen = (keep.seen || 1) + (dup.seen || 1);
  keep.hidden = keep.hidden && dup.hidden;
  keep.label = describe(keep);
  t.media = t.media.filter((x) => x !== dup);
}

/** Merge `m` with anything already listed that is the same file. Returns the item that survives. */
function mergeDuplicates(t, m) {
  if (!t.media.includes(m)) return m;
  const canon = canonicalKey(t, m.key);
  const twin = t.media.find((x) => x !== m && !x.dismissed && x.kind !== 'subtitle'
    && (keysOf(x).some((k) => k === m.key || canonicalKey(t, k) === canon) || sameMedia(x, m)));
  if (!twin) return m;
  // Keep the card that was listed first so the popup doesn't jump around.
  const [keep, dup] = twin.detectedAt <= m.detectedAt ? [twin, m] : [m, twin];
  const why = keysOf(twin).some((k) => k === m.key) ? 'same link' : keysOf(twin).some((k) => canonicalKey(t, k) === canon) ? 'redirect' : 'same size or stream';
  absorb(t, keep, dup, why);
  return keep;
}

function rememberRedirect(t, from, to) {
  t.redirects = t.redirects || {};
  t.redirects[dedupeKey(from)] = dedupeKey(to);
  const ks = Object.keys(t.redirects);
  if (ks.length > 300) delete t.redirects[ks[0]];
}

/** Direct files found in the page (not the network) have no size yet: ask the server, following redirects. */
async function probeDirect(tabId, m) {
  const t = await getTab(tabId);
  if (!autoFetchAllowed(m.url, m.pageUrl || t.pageUrl)) return;
  try {
    await applyRefererRules([m.url], m.pageUrl || t.pageUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(m.url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal: ctrl.signal });
    clearTimeout(timer);
    if (res.url && res.url !== m.url) rememberRedirect(t, m.url, res.url);
    const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1];
    const size = Number(total || (res.status === 200 ? res.headers.get('content-length') : 0)) || null;
    ctrl.abort(); // only the headers were needed
    if (size && !m.size) m.size = size;
    m.label = describe(m);
  } catch { /* the size is only used for matching duplicates */ }
  mergeDuplicates(t, m);
  persistTab(tabId);
}

/**
 * Add (or merge) a media item for a tab.
 * @param item {url, kind, mediaType, ext, size, contentType, source, poster?, duration?, lang?, label?, frameUrl?}
 */
async function addMedia(tabId, item) {
  if (tabId < 0 || !isHttpUrl(item.url)) return null;
  const t = await getTab(tabId);
  if (!t.pageUrl) await refreshTabInfo(tabId, t);
  item = { ...item, poster: safePoster(item.poster, t.pageUrl) };
  if (item.poster) { await guardReady; await allowLocal([item.poster], t.pageUrl).catch(() => {}); }
  const key = dedupeKey(item.url);
  const canon = canonicalKey(t, key);
  let m = t.media.find((x) => keysOf(x).some((k) => k === key || canonicalKey(t, k) === canon));
  if (m) {
    if (!keysOf(m).includes(key)) {
      noteMerge(t, m, { key, url: item.url, title: '' }, 'redirect (on arrival)');
      // Matched through a redirect: count it as one more link for the same video.
      m.aliases = [...(m.aliases || []), key].slice(-30);
      m.seen = (m.seen || 1) + 1;
    }
    if (item.source === 'network' && m.url !== item.url && !m.dismissed) {
      m.aliases = [...new Set(keysOf(m))].filter((k) => k !== key);
      m.url = item.url; // fresher signed URL for the same file
      m.key = key;
    }
    if (item.size && !m.size) m.size = item.size;
    if (item.poster && !m.poster) m.poster = item.poster;
    if (item.duration && !m.info?.duration) m.info = { ...(m.info || {}), duration: item.duration };
    if (item.source === 'ai' && m.source !== 'ai') m.alsoAi = true;
    m.label = describe(m);
    persistTab(tabId);
    // The page may not have been ready to say what the video is called the first time.
    if (!m.title && m.kind !== 'subtitle' && (m.nameTries = (m.nameTries || 0) + 1) <= 3) setTimeout(() => nameFromPage(tabId, m.id), 400);
    return m;
  }
  m = {
    id: shortId(`${tabId}:${key}`),
    key,
    url: item.url,
    kind: item.kind,
    mediaType: item.mediaType,
    ext: item.ext,
    size: item.size ?? null,
    contentType: item.contentType || '',
    source: item.source || 'network',
    poster: item.poster || '',
    lang: item.lang || '',
    hint: item.label || '',
    pageUrl: t.pageUrl,
    frameUrl: item.frameUrl || '',
    frameId: item.frameId || 0,
    detectedAt: Date.now(),
    hidden: t.childKeys.has(key),
    info: item.duration ? { duration: item.duration } : null,
  };
  m.label = describe(m);
  t.media.push(m);
  if (t.media.length > 200) t.media.splice(0, t.media.length - 200);
  persistTab(tabId);
  if (m.kind !== 'subtitle' && !m.hidden) setTimeout(() => nameFromPage(tabId, m.id), 400);
  if (m.kind === 'hls' || m.kind === 'dash') probeStream(tabId, m);
  else if (m.kind === 'direct' && !m.size) probeDirect(tabId, m);
  else m = mergeDuplicates(t, m);
  return m;
}

/** Ask the page what the video playing right now is called (lecture/episode name, not the site title). */
async function readVideoName(tabId, frameId = 0, url = '') {
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'videoName', frame: frameId > 0, url }, { frameId }),
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);
    return res && !res.error && res.name ? res : null;
  } catch {
    return null; // no content script (chrome:// page, PDF, not injected yet)
  }
}

/**
 * Name a media item when it is detected, so each lecture keeps the name it had while it was playing,
 * even if the site switches lectures without reloading the page.
 */
async function nameFromPage(tabId, mediaId) {
  const t = await getTab(tabId);
  const m = t.media.find((x) => x.id === mediaId);
  if (!m || (m.title && m.course)) return;
  // A stream requested from inside a player iframe (e.g. one video of a Vimeo showcase): that player
  // knows which clip it is playing; the page around it only knows the page.
  let fromFrame = m.frameId > 0 ? await readVideoName(tabId, m.frameId, m.url) : null;
  const top = await readVideoName(tabId, 0, m.url);
  // The player is already showing another video (its length is not this stream's): its title isn't ours.
  const playerElsewhere = fromFrame && playerLength(m, fromFrame) === 'other';
  if (playerElsewhere) fromFrame = null;
  const info = fromFrame || top;
  if (!info) return;
  if (!m.title) {
    m.title = info.name;
    m.nameSource = fromFrame ? 'player' : info.source;
    // Players update their title a few seconds after the next video starts (a Vimeo showcase keeps showing
    // the previous lecture's title card), so look again once the player has caught up.
    if (m.frameId > 0) {
      m.playerName = true;
      for (const ms of [2500, 6000, 12000, 25000]) setTimeout(() => recheckName(tabId, m.id).catch(() => {}), ms);
    }
  }
  // For an embedded video with its own title, the lecture name on the page is the better "course".
  const ownTitle = m.nameSource === 'embed' || !!fromFrame;
  if (!m.course && top) {
    // The page's main heading is the best "course" for a video that brings its own title.
    const pick = [top.heading, top.name].find((x) => x && x !== m.title);
    m.course = (ownTitle && pick ? pick : top.course) || '';
  }
  persistTab(tabId);
}

/**
 * Re-read a player's title shortly after its stream started. Only while this is still the newest stream
 * from that player: once the next video loads, the player's title belongs to that one.
 */
async function recheckName(tabId, mediaId) {
  const t = await getTab(tabId);
  const m = t.media.find((x) => x.id === mediaId);
  if (!m || m.customName || !m.playerName || !(m.frameId > 0)) return;
  const newer = t.media.some((x) => x !== m && x.frameId === m.frameId && x.kind === m.kind && !x.hidden && x.detectedAt > m.detectedAt);
  if (newer) return;
  const info = await readVideoName(tabId, m.frameId, m.url);
  if (!info?.name || info.name === m.title) return;
  // Only when the player is provably on this video (same length): a click on the next lecture changes the
  // title before that lecture's stream even starts.
  if (playerLength(m, info) !== 'same') return;
  m.title = info.name;
  m.nameSource = 'player';
  m.label = describe(m);
  persistTab(tabId);
}

/** Is the player showing this stream? 'same' / 'other' by the length of the video in it, or 'unknown'. */
function playerLength(m, info) {
  const want = m.info?.duration;
  if (!(want > 0) || !(info?.duration > 0)) return 'unknown';
  return Math.abs(want - info.duration) <= 2 ? 'same' : 'other';
}

/** Work out what an unknown URL is (AI candidates, recipe results). */
async function probeUnknown(url, pageUrl = '') {
  const byUrl = classifyUrl(url);
  if (byUrl) return byUrl;
  if (!autoFetchAllowed(url, pageUrl)) return null;
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-2047' }, credentials: 'include' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const head = await res.text().catch(() => '');
    if (/^\s*#EXTM3U/.test(head)) return { kind: 'hls', mediaType: 'stream', ext: 'm3u8', size: null, contentType: ct };
    if (/<MPD[\s>]/.test(head)) return { kind: 'dash', mediaType: 'stream', ext: 'mpd', size: null, contentType: ct };
    const r = classifyResponse(
      { url, contentType: ct, contentRange: res.headers.get('content-range'), contentLength: res.headers.get('content-length'), status: 200 },
      { minSizeBytes: 0 },
    );
    return r;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- network sniffing

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const h = {};
    for (const { name, value } of details.responseHeaders || []) h[name.toLowerCase()] = value;
    const r = {
      url: details.url,
      status: details.statusCode,
      contentType: h['content-type'] || '',
      contentLength: h['content-length'],
      contentRange: h['content-range'],
    };
    handleResponse(details.tabId, r, details).catch(() => {});
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders'],
);

// Remember redirects so a page's <video src> and the file it redirects to count as one video.
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.tabId < 0 || !details.redirectUrl) return;
    getTab(details.tabId).then((t) => {
      rememberRedirect(t, details.url, details.redirectUrl);
      const m = t.media.find((x) => keysOf(x).includes(dedupeKey(details.url)));
      if (m) {
        mergeDuplicates(t, m);
        persistTab(details.tabId);
      }
    }).catch(() => {});
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
);

const settingsCache = { value: null, at: 0 };
async function cachedSettings() {
  if (!settingsCache.value || Date.now() - settingsCache.at > 5000) {
    settingsCache.value = await getSettings();
    settingsCache.at = Date.now();
  }
  return settingsCache.value;
}

async function handleResponse(tabId, r, details) {
  const t = await getTab(tabId);
  t.log.push({ url: r.url.slice(0, 800), status: r.status, contentType: r.contentType.split(';')[0], type: details.type });
  if (t.log.length > 400) t.log.splice(0, t.log.length - 400);
  const settings = await cachedSettings();
  const info = classifyResponse(r, { minSizeBytes: settings.minSizeKB * 1024 });
  if (!info) {
    persistTab(tabId);
    return;
  }
  await addMedia(tabId, { url: r.url, ...info, source: 'network', frameId: details.frameId || 0, frameUrl: details.frameId ? details.initiator || '' : '' });
}

/** Every frame's id in a tab (webNavigation is optional; fall back to the top frame). */
/**
 * Which listed video is playing in the tab right now? Every frame is asked about its player; a frame
 * that doesn't answer quickly (or has no StreamSnag script, like a browser page) is simply left out.
 */
async function playingIn(tabId, media) {
  const ask = (frameId) => Promise.race([
    chrome.tabs.sendMessage(tabId, { type: 'playing' }, { frameId }).then((r) => (r ? { ...r, frameId } : null)).catch(() => null),
    new Promise((resolve) => { setTimeout(() => resolve(null), 400); }),
  ]);
  const reports = (await Promise.all((await frameIdsOf(tabId)).map(ask))).filter(Boolean);
  return pickPlaying(media, reports);
}

async function frameIdsOf(tabId) {
  const frames = await chrome.webNavigation?.getAllFrames({ tabId }).catch(() => null);
  return frames?.length ? frames.map((f) => f.frameId) : [0];
}

/** Ask every frame for a fresh report. After a same-document URL change the DOM may be unchanged, so the
 *  content script's own change detection would otherwise never send the list back. */
async function askFramesToReport(tabId) {
  await Promise.all((await frameIdsOf(tabId)).map((frameId) =>
    chrome.tabs.sendMessage(tabId, { type: 'rescan' }, { frameId }).catch(() => {})));
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.url) {
    const t = await getTab(tabId);
    const prevUrl = t.pageUrl;
    t.pageUrl = isHttpUrl(change.url) ? change.url : '';
    if (prevUrl && prevUrl.split('#')[0] !== change.url.split('#')[0]) {
      // New page: drop old media except what arrived in the last few seconds (SPA navigations
      // often start loading the next video just before the URL changes).
      const cutoff = Date.now() - 4000;
      t.media = t.media.filter((m) => m.detectedAt > cutoff);
      t.log = t.log.slice(-40);
      t.childKeys = new Set();
      t.redirects = {};
      t.embeds = {};
      t.aiResult = null;
      persistTab(tabId);
      // Tabs and SPA routes change the URL without touching the DOM: without this the items that are
      // still on the page never come back, and the last tab's player is the one that goes missing.
      askFramesToReport(tabId);
    }
  }
  if (change.title) {
    const t = await getTab(tabId);
    t.pageTitle = change.title;
    persistTab(tabId);
  }
  if (change.status === 'complete' && isHttpUrl(tab.url)) {
    scanLibrary({ force: true }).catch(() => {}); // a (re)loaded page re-checks the folder
    const settings = await getSettings();
    if (settings.autoRecipes) setTimeout(() => runSavedRecipe(tabId, { quiet: true }).catch(() => {}), 1500);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  tabLoads.delete(tabId);
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
});

// ---------------------------------------------------------------- recipes

async function getRecipes() {
  const { recipes } = await chrome.storage.local.get('recipes');
  return recipes || {};
}

async function recipeForUrl(url) {
  const recipes = await getRecipes();
  const key = siteKey(url);
  return recipes[key] || recipes[registrableDomain(key)] || null;
}

async function pageSnapshot(tabId, selectors = []) {
  try {
    const snap = await chrome.tabs.sendMessage(tabId, { type: 'snapshot', selectors }, { frameId: 0 });
    if (snap?.error) throw new Error(snap.error);
    return snap;
  } catch (e) {
    throw new Error(`Could not read this page (${e.message}). Reload the tab and try again.`);
  }
}

async function addFoundUrls(tabId, urls, source) {
  const added = [];
  for (const url of urls.slice(0, 30)) {
    const info = await probeUnknown(url, (await getTab(tabId)).pageUrl);
    if (!info) continue;
    const m = await addMedia(tabId, { url, ...info, source });
    if (m) added.push(m.id);
  }
  return added;
}

async function runSavedRecipe(tabId, { quiet = false } = {}) {
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const recipe = await recipeForUrl(t.pageUrl);
  if (!recipe) {
    if (quiet) return null;
    throw new Error('No saved recipe for this site.');
  }
  const snap = await pageSnapshot(tabId, selectorsFor(recipe));
  const result = await runRecipe(recipe, { ...snap, network: t.log.map((l) => l.url) }, (u) => fetchText(u, { maxBytes: 2_000_000 }));
  const added = await addFoundUrls(tabId, result.urls, 'recipe');
  return { ...result, added: added.length };
}

// ---------------------------------------------------------------- download options

function hlsVariantLabel(v) {
  const res = v.height ? `${v.height}p` : v.width ? `${v.width}w` : 'Auto';
  return [res, formatBitrate(v.bandwidth), v.frameRate > 30 ? `${Math.round(v.frameRate)}fps` : ''].filter(Boolean).join(' · ');
}

/** Turn one detected media item into concrete download choices. */
async function inspectMedia(tabId, mediaId) {
  const t = await getTab(tabId);
  const m = t.media.find((x) => x.id === mediaId);
  if (!m) throw new Error('That media item is gone — reload the page.');
  await applyRefererRules([m.url], m.pageUrl || t.pageUrl, true); // you opened this item's qualities
  if (m.kind === 'direct') return { options: [{ id: 'file', label: `${(m.ext || 'file').toUpperCase()}${m.size ? ` · ${formatBytes(m.size)}` : ''}` }] };
  if (m.kind === 'subtitle') return { options: [{ id: 'file', label: `Subtitles (${m.ext})` }] };

  const text = await fetchText(m.url);
  if (m.kind === 'hls') {
    const pl = parseM3U8(text, m.url);
    if (pl.protected) return { options: [], protected: true };
    if (pl.type === 'media') {
      return {
        options: [{ id: 'media', label: pl.endList ? `Download · ${formatDuration(pl.totalDuration)}` : 'Record live stream' }],
        live: !pl.endList,
      };
    }
    const options = pl.variants.map((v, i) => ({ id: `v${i}`, label: hlsVariantLabel(v), height: v.height || 0, bandwidth: v.bandwidth || 0 }));
    pl.audio.filter((a) => a.url).forEach((a, i) => options.push({ id: `a${i}`, label: `Audio only · ${a.name || a.language || a.groupId}`, audio: true }));
    pl.subtitles.filter((s) => s.url).forEach((s, i) => options.push({ id: `s${i}`, label: `Subtitles · ${s.name || s.language}`, subtitle: true }));
    return { options };
  }
  const mpd = parseMPD(text, m.url);
  if (mpd.protected) return { options: [], protected: true };
  if (mpd.dynamic) return { options: [], live: true, note: 'Live DASH is not supported in-browser — try the yt-dlp helper.' };
  const options = mpd.video.map((v, i) => ({
    id: `v${i}`,
    label: [v.height ? `${v.height}p` : v.id, formatBitrate(v.bandwidth), mpd.audio.length ? '+ audio' : ''].filter(Boolean).join(' · '),
    height: v.height || 0,
    bandwidth: v.bandwidth || 0,
  }));
  mpd.audio.forEach((a, i) => options.push({ id: `a${i}`, label: `Audio only · ${[a.lang, formatBitrate(a.bandwidth)].filter(Boolean).join(' · ')}`, audio: true }));
  mpd.subtitles.forEach((s, i) => options.push({ id: `s${i}`, label: `Subtitles · ${s.lang || s.label || s.id}`, subtitle: true }));
  return { options };
}

// The popup reads the newest stream's qualities each time it opens: remember the answer briefly so that
// doesn't fetch the manifest again and again. Downloads always read a fresh manifest.
const INSPECT_TTL = 60000;
const inspectCache = new Map(); // "tabId:mediaId" -> {at, url, result: Promise}
async function inspectCached(tabId, mediaId) {
  const t = await getTab(tabId);
  const url = t.media.find((x) => x.id === mediaId)?.url;
  const key = `${tabId}:${mediaId}`;
  const hit = inspectCache.get(key);
  if (hit && hit.url === url && Date.now() - hit.at < INSPECT_TTL) return hit.result;
  for (const [k, v] of inspectCache) if (Date.now() - v.at >= INSPECT_TTL) inspectCache.delete(k);
  const entry = { at: Date.now(), url, result: inspectMedia(tabId, mediaId) };
  inspectCache.set(key, entry);
  // A failure (expired link, network) or a live stream is never kept: the next look reads it again.
  entry.result.then((r) => { if (r.live && inspectCache.get(key) === entry) inspectCache.delete(key); },
    () => { if (inspectCache.get(key) === entry) inspectCache.delete(key); });
  return entry.result;
}

function hlsPlanFromMedia(pl, settings, role) {
  if (pl.protected) throw new Error(`This stream is encrypted (${pl.keyMethod || 'DRM'}) and cannot be downloaded.`);
  const ext = role === 'subtitle' ? 'vtt' : outputExtForMedia(pl, role);
  const mime = { ts: 'video/mp2t', mp4: 'video/mp4', m4a: 'audio/mp4', aac: 'audio/aac', vtt: 'text/vtt' }[ext] || 'application/octet-stream';
  return {
    ext,
    plan: {
      segments: pl.segments.map((s) => ({ url: s.url, range: s.range || null })),
      init: pl.init,
      mime,
      merge: ext === 'vtt' ? 'vtt' : 'binary',
      concurrency: settings.concurrency,
    },
  };
}

async function loadHlsMedia(url) {
  const pl = parseM3U8(await fetchText(url), url);
  if (pl.type !== 'media') throw new Error('Expected a media playlist');
  return pl;
}

/** Build the list of tracks (files) a job needs to produce. */
async function planTracks(m, optionId, settings) {
  if (m.kind === 'direct' || m.kind === 'subtitle') {
    return [{ role: m.kind === 'subtitle' ? 'subtitle' : 'file', kind: 'direct', url: m.url, ext: m.ext || extFromUrl(m.url) || 'mp4', quality: '' }];
  }
  const text = await fetchText(m.url);
  if (m.kind === 'hls') {
    const top = parseM3U8(text, m.url);
    if (top.protected) throw new Error('This stream uses DRM/encryption and cannot be downloaded.');
    if (top.type === 'media') {
      if (top.protected) throw new Error('This stream is encrypted and cannot be downloaded.');
      const role = m.mediaType === 'subtitle' ? 'subtitle' : 'video';
      const { ext, plan } = hlsPlanFromMedia(top, settings, role);
      if (!top.endList) plan.live = { playlistUrl: m.url };
      return [{ role, kind: 'stream', ext, plan, quality: top.endList ? '' : 'live' }];
    }
    const idx = Number(optionId.slice(1));
    if (optionId.startsWith('a')) {
      const a = top.audio.filter((x) => x.url)[idx];
      const { ext, plan } = hlsPlanFromMedia(await loadHlsMedia(a.url), settings, 'audio');
      return [{ role: 'audio', kind: 'stream', ext, plan, quality: a.name || a.language || 'audio' }];
    }
    if (optionId.startsWith('s')) {
      const s = top.subtitles.filter((x) => x.url)[idx];
      const { plan } = hlsPlanFromMedia(await loadHlsMedia(s.url), settings, 'subtitle');
      return [{ role: 'subtitle', kind: 'stream', ext: 'vtt', plan, quality: s.language || s.name || 'subs', lang: s.language }];
    }
    const v = top.variants[idx] || top.variants[0];
    const vpl = await loadHlsMedia(v.url);
    const tracks = [];
    const vt = hlsPlanFromMedia(vpl, settings, 'video');
    if (!vpl.endList) vt.plan.live = { playlistUrl: v.url };
    const quality = v.height ? `${v.height}p` : '';
    tracks.push({ role: 'video', kind: 'stream', ext: vt.ext, plan: vt.plan, quality: vpl.endList ? quality : `${quality} live` });
    const group = top.audio.filter((a) => a.groupId === v.audioGroup && a.url);
    const audio = group.find((a) => a.isDefault) || group[0];
    if (audio && vpl.endList) {
      const at = hlsPlanFromMedia(await loadHlsMedia(audio.url), settings, 'audio');
      tracks.push({ role: 'audio', kind: 'stream', ext: at.ext, plan: at.plan, quality });
    }
    if (settings.includeSubtitles && vpl.endList) {
      for (const s of top.subtitles.filter((x) => x.url && (!v.subtitleGroup || x.groupId === v.subtitleGroup)).slice(0, 4)) {
        try {
          const st = hlsPlanFromMedia(await loadHlsMedia(s.url), settings, 'subtitle');
          tracks.push({ role: 'subtitle', kind: 'stream', ext: 'vtt', plan: st.plan, quality, lang: s.language || s.name });
        } catch { /* subtitles are optional */ }
      }
    }
    return tracks;
  }
  // DASH
  const mpd = parseMPD(text, m.url);
  if (mpd.protected) throw new Error('This stream uses DRM and cannot be downloaded.');
  if (mpd.dynamic) throw new Error('Live DASH is not supported in-browser. Try "Download with yt-dlp".');
  const repPlan = (rep) => ({
    segments: rep.segments.map((s) => ({ url: s.url, range: s.range || null })),
    init: rep.init,
    mime: rep.kind === 'audio' ? 'audio/mp4' : rep.kind === 'subtitle' ? 'text/vtt' : 'video/mp4',
    merge: dashExt(rep) === 'vtt' && rep.segments.length > 1 ? 'vtt' : 'binary',
    concurrency: settings.concurrency,
  });
  const idx = Number(optionId.slice(1));
  if (optionId.startsWith('a')) {
    const a = mpd.audio[idx];
    return [{ role: 'audio', kind: 'stream', ext: dashExt(a), plan: repPlan(a), quality: a.lang || formatBitrate(a.bandwidth) }];
  }
  if (optionId.startsWith('s')) {
    const s = mpd.subtitles[idx];
    return [{ role: 'subtitle', kind: 'stream', ext: dashExt(s), plan: repPlan(s), quality: 'subs', lang: s.lang }];
  }
  const v = mpd.video[idx] || mpd.video[0];
  if (!v) throw new Error('No video tracks in this manifest.');
  const quality = v.height ? `${v.height}p` : v.id;
  const tracks = [{ role: 'video', kind: 'stream', ext: dashExt(v), plan: repPlan(v), quality }];
  const a = mpd.audio[0];
  if (a) tracks.push({ role: 'audio', kind: 'stream', ext: dashExt(a), plan: repPlan(a), quality });
  if (settings.includeSubtitles) {
    mpd.subtitles.slice(0, 4).forEach((s) => tracks.push({ role: 'subtitle', kind: 'stream', ext: dashExt(s), plan: repPlan(s), quality, lang: s.lang }));
  }
  return tracks;
}

// ---------------------------------------------------------------- jobs

const jobs = new Map();
let jobsLoaded = null;
let jobsPersistTimer = null;

function loadJobs() {
  if (!jobsLoaded) {
    jobsLoaded = chrome.storage.session.get('jobs').then(({ jobs: stored }) => {
      for (const j of Object.values(stored || {})) if (!jobs.has(j.id)) jobs.set(j.id, j);
    });
  }
  return jobsLoaded;
}

function persistJobs(immediate = false) {
  clearTimeout(jobsPersistTimer);
  const write = () => {
    // Don't persist big segment lists for finished tracks.
    const obj = {};
    for (const [id, j] of jobs) obj[id] = j;
    chrome.storage.session.set({ jobs: obj }).catch(() => {});
  };
  if (immediate) write();
  else jobsPersistTimer = setTimeout(write, 250);
}

function publicJob(j) {
  return {
    id: j.id, tabId: j.tabId, title: j.title, filename: j.filename, status: j.status, error: j.error, optionId: j.optionId || 'file',
    progress: j.progress, startedAt: j.startedAt, finishedAt: j.finishedAt, live: j.live, kind: j.kind,
    outputs: j.outputs || [], note: j.note || '', mediaUrl: j.mediaUrl, diagnosis: j.diagnosis || null,
    mediaId: j.mediaId || '', mediaKeys: j.mediaKeys || [], mediaSize: j.mediaSize || null, fingerprint: j.fingerprint || '',
    trackCount: j.tracks?.length || 0,
    trackIndex: j.tracks ? j.tracks.findIndex((t) => t.status === 'running' || t.status === 'saving') : -1,
  };
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Join downloaded video stream segments into a single file',
  }).catch((e) => {
    if (!/single offscreen/i.test(e.message)) throw e;
  });
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg });

async function aiFilename(settings, names, pageUrl, quality) {
  if (!settings.aiFilenames || settings.aiProvider === 'off') return null;
  try {
    const p = buildFilenamePrompt({ ...names, pageUrl, quality });
    const res = await Promise.race([
      callAI(settings, { ...p, maxTokens: 2000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
    ]);
    return res.data?.filename ? sanitizeFilename(res.data.filename, 110) : null;
  } catch {
    return null;
  }
}

function trackFilename(base, track, multiAV, folder) {
  let name = base;
  if (track.role === 'subtitle') name = `${base}${track.lang ? `.${sanitizeFilename(track.lang, 20)}` : ''}`;
  else if (multiAV) name = `${base}.${track.role}`;
  const file = `${name}.${track.ext}`;
  return folder ? `${folder}/${file}` : file; // folder is already resolveFolder()-safe
}

async function startDownload(tabId, mediaId, optionId = 'file') {
  await loadJobs();
  const settings = await getSettings();
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const m = t.media.find((x) => x.id === mediaId);
  if (!m) throw new Error('That media item is gone — reload the page.');
  if (m.kind === 'embed') return startYtdlp(tabId, { mediaId });
  if (m.protected) throw new Error('This media is DRM/encrypted and cannot be downloaded.');
  const pageUrl = m.pageUrl || t.pageUrl;
  await applyRefererRules([m.url], pageUrl, true); // you clicked Download

  const tracks = await planTracks(m, optionId, settings);
  const allUrls = new Set();
  for (const tr of tracks) {
    if (tr.url) allUrls.add(tr.url);
    if (tr.plan?.init) allUrls.add(tr.plan.init.url);
    tr.plan?.segments.forEach((s) => allUrls.add(s.url));
  }
  await applyRefererRules([...allUrls], pageUrl);

  const quality = tracks[0].quality || '';
  // Your own name > the lecture/episode name read from the page > the tab title.
  if (!m.customName && !m.title) {
    const info = await readVideoName(tabId, 0, m.url);
    if (info) Object.assign(m, { title: info.name, course: info.course || '', nameSource: info.source });
  }
  const rawTitle = m.customName || m.title || t.pageTitle || m.hint || hostOf(m.url);
  const title = m.customName
    || (await aiFilename(settings, { pageTitle: t.pageTitle, videoName: m.title, course: m.course }, pageUrl, quality))
    || rawTitle;
  const course = sanitizeFilename(m.course || '', 80);
  const date = new Date().toISOString().slice(0, 10);
  const rules = rulesFor(settings, pageUrl || m.url); // a site rule beats the general settings
  const base = buildFilename(rules.filenameTemplate, {
    title, quality, course, page: t.pageTitle || '', host: siteKey(pageUrl || m.url), date, kind: m.kind,
  }, '');
  const multiAV = tracks.filter((x) => x.role === 'video' || x.role === 'audio').length > 1;
  const folder = resolveFolder(rules.subfolder, { site: siteKey(pageUrl || m.url), course, date, kind: m.kind });
  tracks.forEach((tr) => {
    tr.filename = trackFilename(base, tr, multiAV, folder);
    tr.status = 'pending';
  });

  const job = {
    id: crypto.randomUUID(),
    tabId,
    mediaId,
    optionId,
    mediaUrl: m.url,
    mediaKeys: keysOf(m),
    mediaSize: m.kind === 'direct' ? m.size || null : null,
    fingerprint: m.fingerprint || '',
    pageUrl,
    kind: m.kind,
    title,
    base,
    folder,
    filename: tracks[0].filename,
    status: 'running',
    live: tracks.some((x) => x.plan?.live),
    progress: { done: 0, total: 0, bytes: 0 },
    tracks,
    outputs: [],
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  persistJobs(true);
  runNextTrack(job.id).catch((e) => failJob(job.id, e.message));
  return publicJob(job);
}

async function runNextTrack(jobId) {
  await loadJobs();
  const job = jobs.get(jobId);
  if (!job || ['canceled', 'error', 'done'].includes(job.status)) return;
  const idx = job.tracks.findIndex((x) => x.status === 'pending');
  if (idx < 0) return finalizeJob(jobId);
  const tr = job.tracks[idx];
  tr.status = 'running';
  job.status = job.live ? 'recording' : 'running';
  job.progress = { done: 0, total: tr.plan ? tr.plan.segments.length : 0, bytes: 0 };
  persistJobs();
  if (tr.kind === 'direct') {
    const downloadId = await chrome.downloads.download({ url: tr.url, filename: tr.filename, conflictAction: 'uniquify' });
    tr.downloadId = downloadId;
    tr.status = 'saving';
    persistJobs(true);
    return;
  }
  await ensureOffscreen();
  await toOffscreen({ type: 'runTrack', jobId, trackIndex: idx, plan: tr.plan });
}

function failJob(jobId, error, extra = {}) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = extra.canceled ? 'canceled' : 'error';
  job.error = error;
  job.httpStatus = extra.status || 0;
  job.finishedAt = Date.now();
  persistJobs(true);
  toOffscreen({ type: 'jobFinished', jobId }).catch(() => {});
  pumpQueue();
}

async function finalizeJob(jobId) {
  const job = jobs.get(jobId);
  const settings = await getSettings();
  job.outputs = job.tracks.map((x) => ({ role: x.role, path: x.path, filename: x.filename, downloadId: x.downloadId }));
  const av = job.tracks.filter((x) => x.role === 'video' || x.role === 'audio');
  const hasVideo = av.some((x) => x.role === 'video');
  const subs = settings.embedSubtitles && hasVideo
    ? job.tracks.filter((x) => x.role === 'subtitle' && x.path && /\.(vtt|srt)$/i.test(x.path))
    : [];
  const needsMux = av.length > 1 || (av.length === 1 && av[0].ext === 'ts') || (av.length >= 1 && subs.length > 0);
  if (settings.useFfmpeg && needsMux && av.every((x) => x.path)) {
    // Fresh check: the cached status may predate installing ffmpeg.
    const helper = await helperStatus(true);
    if (helper.ok && helper.tools?.ffmpeg) {
      job.status = 'muxing';
      persistJobs(true);
      try {
        const video = av.find((x) => x.role === 'video') || av[0];
        const outExt = !hasVideo ? 'm4a' : (video.ext === 'webm' ? 'mkv' : 'mp4');
        const res = await helperRequest({
          type: 'mux',
          inputs: av.map((x) => x.path),
          subtitles: subs.map((s) => ({ path: s.path, lang: s.lang || '' })),
          outputName: `${job.base}.${outExt}`,
          deleteInputs: true,
          deleteSubtitles: !settings.keepSubtitleFiles,
        }, { timeoutMs: 30 * 60 * 1000 });
        const keptSubs = res.subsEmbedded && !settings.keepSubtitleFiles
          ? job.outputs.filter((o) => o.role === 'subtitle' && !subs.some((s) => s.path === o.path))
          : job.outputs.filter((o) => o.role === 'subtitle');
        job.outputs = [{ role: hasVideo ? 'video' : 'audio', path: res.output, filename: res.output }, ...keptSubs];
        const did = [];
        if (av.length > 1) did.push('merged video + audio');
        else if (av[0].ext === 'ts') did.push(`converted to ${outExt.toUpperCase()}`);
        if (res.subsEmbedded) did.push(`embedded ${subs.length} subtitle track${subs.length > 1 ? 's' : ''}`);
        else if (subs.length) did.push('subtitles kept as separate files');
        job.note = `ffmpeg: ${did.join(', ')}`;
      } catch (e) {
        job.note = `ffmpeg merge failed (${e.message}); kept separate files.`;
      }
    } else if (av.length > 1) {
      job.note = 'Video and audio saved as separate files (install the helper + ffmpeg to merge automatically).';
    }
  } else if (av.length > 1) {
    job.note = 'Video and audio saved as separate files.';
  }
  if (settings.saveFolder) await moveToSaveFolder(job, settings);
  job.status = 'done';
  job.finishedAt = Date.now();
  job.progress = { ...job.progress, done: job.progress.total || job.progress.done };
  persistJobs(true);
  toOffscreen({ type: 'jobFinished', jobId }).catch(() => {});
  pumpQueue();
  await addHistory(job);
  if (settings.notify) {
    chrome.notifications.create(`done:${jobId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Download complete',
      message: job.title.slice(0, 120),
    }).catch?.(() => {});
  }
}

/** Move finished files from Chrome's Downloads folder to the user's chosen folder (via the helper). */
async function moveToSaveFolder(job, settings) {
  const files = job.outputs.filter((o) => o.path);
  if (!files.length) return;
  const helper = await helperStatus(true);
  if (!helper.ok) {
    job.note = [job.note, 'Saved in Downloads: moving to your chosen folder needs the local helper.'].filter(Boolean).join(' · ');
    return;
  }
  try {
    const res = await helperRequest({ type: 'move', files: files.map((o) => o.path), dest: settings.saveFolder, subfolder: job.folder || '' }, { timeoutMs: 10 * 60 * 1000 });
    files.forEach((o, i) => {
      if (!res.moved[i]) return;
      o.path = res.moved[i];
      o.filename = res.moved[i];
      delete o.downloadId; // Chrome's entry now points at the old location
    });
    job.savedTo = res.dir;
    job.note = [job.note, `Saved to ${res.dir}`].filter(Boolean).join(' · ');
  } catch (e) {
    job.note = [job.note, `Couldn't move to ${settings.saveFolder} (${e.message}); left in Downloads.`].filter(Boolean).join(' · ');
  }
}

/** Size of each saved file: the fingerprint that survives renaming. */
async function statOutputs(outputs) {
  const out = outputs.map((o) => ({ path: o.path || o.filename || '', size: 0 }));
  for (const [i, o] of outputs.entries()) {
    if (o.downloadId == null) continue;
    const [d] = await chrome.downloads.search({ id: o.downloadId }).catch(() => []);
    if (d?.fileSize > 0 || d?.totalBytes > 0) out[i].size = d.fileSize || d.totalBytes;
  }
  const missing = out.filter((o) => !o.size && o.path);
  if (missing.length && helperCache.value?.ok) {
    try {
      const res = await helperRequest({ type: 'stat', paths: missing.map((o) => o.path) }, { timeoutMs: 8000 });
      res.stats.forEach((st, i) => { if (st) missing[i].size = st.size; });
    } catch { /* sizes are a bonus */ }
  }
  return out;
}

async function addHistory(job) {
  const outputs = await statOutputs(job.outputs || []).catch(() => []);
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({
    title: job.title,
    files: job.outputs.map((o) => o.path || o.filename),
    outputs,
    mediaUrl: job.mediaUrl,
    mediaKeys: job.mediaKeys || [],
    mediaSize: job.mediaSize || null,
    fingerprint: job.fingerprint || '',
    pageUrl: job.pageUrl,
    at: Date.now(),
    bytes: (job.tracks?.length || 0) > 1 ? 0 : job.progress?.bytes || 0, // multi-track counters only cover the last track
    note: job.note || '',
  });
  await chrome.storage.local.set({ history: history.slice(0, 300) });
  setTimeout(() => scanLibrary({ force: true }).catch(() => {}), 500);
}

// ---------------------------------------------------------------- library: what's already in the folder
// The helper lists the media files in the save folder(s) with their size and length. A detected video
// counts as downloaded when its content matches a file there, whatever the file is called now.

let library = null;
let libraryScan = null;
let libraryRescanQueued = false;

async function loadLibrary() {
  if (!library) library = (await chrome.storage.local.get('library')).library || { at: 0, files: [], dirs: [] };
  return library;
}

const parentDir = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');

function markKeys(m) {
  const id = serviceId(m);
  return [m.key, ...(m.aliases || []), m.fingerprint ? `fp:${m.fingerprint}` : '', id ? `id:${id}` : ''].filter(Boolean);
}

function markFor(m, marks) {
  for (const k of markKeys(m)) if (marks[k]) return marks[k].as;
  return null;
}

/** Match every item on the page against the folder scan (and your own marks). */
function attachLibrary(t, history, marks) {
  const names = new Map();
  for (const m of visibleMedia(t)) {
    const k = nameKey(m.customName || m.title);
    if (k) names.set(k, (names.get(k) || 0) + 1);
  }
  for (const m of t.media) {
    m.mark = markFor(m, marks);
    if (m.mark) {
      m.library = m.mark === 'done' ? { path: '', how: 'manual' } : null;
      continue;
    }
    const unique = (names.get(nameKey(m.customName || m.title)) || 0) <= 1;
    m.library = library.at ? findInLibrary(m, history, library.files, library.dirs, library.at, { nameIsUnique: unique }) : null;
  }
}

async function scanLibrary({ force = false } = {}) {
  await loadLibrary();
  if (libraryScan) {
    // Something changed while a scan was running (a refresh, a finished download): scan again after it.
    if (force) libraryRescanQueued = true;
    return libraryScan;
  }
  if (!force && Date.now() - library.at < 60000) return library;
  const startedAt = Date.now();
  libraryScan = (async () => {
    const settings = await getSettings();
    const helper = await helperStatus();
    if (!helper.ok) {
      library = { ...library, at: Date.now(), error: 'Install the local helper to check your folder for videos you already have.' };
      return library;
    }
    const { history = [] } = await chrome.storage.local.get('history');
    const dirs = new Set();
    if (settings.saveFolder) dirs.add(settings.saveFolder);
    for (const d of settings.libraryFolders || []) if (d) dirs.add(d);
    for (const h of history.slice(0, 300)) for (const o of h.outputs || []) if (o.path) dirs.add(parentDir(o.path));
    // Chrome's own download folder (wherever the user pointed it).
    const recent = await chrome.downloads.search({ limit: 40, orderBy: ['-startTime'] }).catch(() => []);
    const MEDIA = /\.(mp4|m4v|mkv|webm|mov|ts|m4a|mp3)$/i;
    for (const d of recent) if (d.state === 'complete' && MEDIA.test(d.filename || '')) dirs.add(parentDir(d.filename));
    const res = await helperRequest({
      // Nothing saved yet: fall back to the usual Downloads folder.
      type: 'scanFolder', dirs: [...dirs].filter(Boolean).slice(0, 60), includeDownloads: settings.checkDownloads !== false || !dirs.size, durations: true, maxProbe: 150,
    }, { timeoutMs: 180000 });
    // Big libraries arrive in pages (the helper may send at most 1 MB at a time).
    let files = res.files || [];
    while (res.scanId && files.length < res.total) {
      const page = await helperRequest({ type: 'scanPage', scanId: res.scanId, offset: files.length }, { timeoutMs: 60000 });
      if (!page.files?.length) break;
      files = files.concat(page.files);
    }
    for (const f of files) if (!f.name) f.name = String(f.path).replace(/^.*[\\/]/, '');
    library = { at: startedAt, files, dirs: res.dirs || [], pending: res.pending || 0, error: '' };
    await chrome.storage.local.set({ library });
    // Measuring lengths happens in batches; keep going in the background until every file is known.
    if (res.pending > 0) setTimeout(() => scanLibrary({ force: true }).catch(() => {}), 1500);
    return library;
  })().catch((e) => {
    library = { ...library, at: Date.now(), error: e.message };
    return library;
  }).finally(() => {
    libraryScan = null;
    if (libraryRescanQueued) {
      libraryRescanQueued = false;
      scanLibrary({ force: true }).catch(() => {});
    }
  });
  return libraryScan;
}

function findTrackByDownload(downloadId) {
  for (const job of jobs.values()) {
    const idx = job.tracks?.findIndex((x) => x.downloadId === downloadId) ?? -1;
    if (idx >= 0) return { job, idx };
  }
  return null;
}

chrome.downloads.onChanged.addListener(async (delta) => {
  await loadJobs();
  const hit = findTrackByDownload(delta.id);
  if (!hit) return;
  const { job, idx } = hit;
  const tr = job.tracks[idx];
  if (delta.filename?.current) tr.path = delta.filename.current;
  if (delta.state?.current === 'complete') {
    if (!tr.path) {
      const [item] = await chrome.downloads.search({ id: delta.id });
      tr.path = item?.filename || '';
    }
    tr.status = 'done';
    if (tr.blobUrl) {
      toOffscreen({ type: 'revoke', url: tr.blobUrl }).catch(() => {});
      delete tr.blobUrl;
    }
    if (tr.plan) tr.plan = { ...tr.plan, segments: [] }; // free memory/storage
    persistJobs(true);
    runNextTrack(job.id).catch((e) => failJob(job.id, e.message));
  } else if (delta.state?.current === 'interrupted') {
    const [item] = await chrome.downloads.search({ id: delta.id });
    const reason = item?.error || 'interrupted';
    failJob(job.id, reason === 'USER_CANCELED' ? 'Canceled' : `Download failed: ${reason}`, { canceled: reason === 'USER_CANCELED' });
  }
});

/** Ask Chrome for progress of direct downloads (called when the popup refreshes). */
async function refreshDirectProgress() {
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue;
    const tr = job.tracks.find((x) => x.kind === 'direct' && x.status === 'saving' && x.downloadId != null);
    if (!tr) continue;
    const [item] = await chrome.downloads.search({ id: tr.downloadId });
    if (item) job.progress = { done: item.bytesReceived, total: item.totalBytes > 0 ? item.totalBytes : 0, bytes: item.bytesReceived, isBytes: true };
  }
}

async function cancelJob(jobId) {
  await loadJobs();
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.status === 'queued') {
    Object.assign(job, { status: 'canceled', error: 'Canceled', finishedAt: Date.now() });
    persistJobs(true);
    return;
  }
  for (const tr of job.tracks || []) {
    if (tr.downloadId != null && tr.status === 'saving') chrome.downloads.cancel(tr.downloadId).catch(() => {});
  }
  await toOffscreen({ type: 'cancel', jobId }).catch(() => {});
  job.helperPort?.disconnect?.();
  failJob(jobId, 'Canceled', { canceled: true });
}

// ---------------------------------------------------------------- download queue
// At most `maxParallel` downloads run at once (live recordings don't count); the rest wait as "queued"
// jobs and start, oldest first, as running ones finish.

const ACTIVE = ['running', 'muxing'];
const activeDownloads = () => [...jobs.values()].filter((j) => ACTIVE.includes(j.status) && !j.live).length;

async function enqueueDownload(tabId, mediaId, optionId = 'file') {
  await loadJobs();
  const settings = await getSettings();
  const already = [...jobs.values()].find((j) => j.mediaId === mediaId && j.tabId === tabId && (j.status === 'queued' || ACTIVE.includes(j.status)));
  if (already) return publicJob(already); // one click too many
  if (activeDownloads() < Math.max(1, Number(settings.maxParallel) || 2)) return startDownload(tabId, mediaId, optionId);
  const t = await getTab(tabId);
  const m = t.media.find((x) => x.id === mediaId);
  if (!m) throw new Error('That media item is gone — reload the page.');
  const job = {
    id: crypto.randomUUID(), tabId, mediaId, optionId, kind: m.kind, mediaUrl: m.url, mediaKeys: keysOf(m),
    mediaSize: m.kind === 'direct' ? m.size || null : null, fingerprint: m.fingerprint || '', pageUrl: m.pageUrl || t.pageUrl,
    title: m.customName || m.title || t.pageTitle || hostOf(m.url), filename: '', status: 'queued',
    progress: { done: 0, total: 0, bytes: 0 }, tracks: [], outputs: [], startedAt: Date.now(), queuedAt: Date.now(),
  };
  jobs.set(job.id, job);
  persistJobs(true);
  return publicJob(job);
}

let pumping = false;
async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    await loadJobs();
    const max = Math.max(1, Number((await getSettings()).maxParallel) || 2);
    for (;;) {
      const next = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt)[0];
      if (!next || activeDownloads() >= max) break;
      jobs.delete(next.id); // the real job takes its place
      persistJobs(true);
      try {
        await startDownload(next.tabId, next.mediaId, next.optionId);
      } catch (e) {
        jobs.set(next.id, { ...next, status: 'error', error: e.message, finishedAt: Date.now() });
        persistJobs(true);
      }
    }
  } finally {
    pumping = false;
  }
}

// ---------------------------------------------------------------- playlists (showcases): every video, not just the played ones

/** Ask yt-dlp for the playlist's videos and list each one; already-downloaded ones show as such. */
async function listPlaylist(tabId, mediaId) {
  const t = await getTab(tabId);
  const p = t.media.find((x) => x.id === mediaId);
  if (!p?.playlist) throw new Error('That item is not a playlist.');
  const helper = await helperStatus(true);
  if (!helper.ok) throw new Error(helper.error);
  if (!helper.tools?.ytdlp) throw new Error('Listing a playlist needs yt-dlp (winget install yt-dlp.yt-dlp).');
  const res = await helperRequest({ type: 'ytdlpList', url: p.url, referer: t.pageUrl }, { timeoutMs: 4 * 60 * 1000 });
  const entries = res.entries || [];
  for (const e of entries) {
    const m = await addMedia(tabId, { url: e.url, kind: 'embed', mediaType: 'video', ext: '', size: null, contentType: '', source: 'playlist', duration: e.duration });
    if (!m) continue;
    if (!m.title) Object.assign(m, { title: e.title || `Video ${e.index}`, nameSource: 'embed' });
    Object.assign(m, {
      provider: /vimeo/i.test(e.url) ? 'vimeo' : /youtu/i.test(e.url) ? 'youtube' : m.provider || '',
      parentId: p.id, playlistUrl: p.url, playlistIndex: e.index, section: m.section || p.section || '',
      course: m.course || p.course || res.title || p.title || '',
    });
    m.label = describe(m);
  }
  p.listed = { at: Date.now(), count: entries.length, title: res.title || '' };
  coverEntries(t);
  persistTab(tabId);
  return { count: entries.length, title: res.title || '' };
}

/**
 * A playlist entry you already played is the same video as its stream card: hide the entry (the stream card
 * has the real stream and its status). Same length (±2 s), and the names don't say otherwise.
 */
function coverEntries(t) {
  const streams = t.media.filter((m) => (m.kind === 'hls' || m.kind === 'dash') && !m.hidden && !m.dismissed && m.info?.duration > 20);
  for (const e of t.media.filter((m) => m.parentId)) {
    const d = e.info?.duration;
    const lead = leadNumber(e.title);
    const cover = d > 20 && streams.find((s) => Math.abs(s.info.duration - d) <= 2
      && (lead == null || leadNumber(s.title) == null || leadNumber(s.title) === lead));
    e.covered = cover ? cover.id : '';
  }
}

/** "Download missing": every video of the playlist that isn't downloaded, queued, or running. */
async function downloadMissing(tabId, mediaId) {
  await loadJobs();
  const t = await getTab(tabId);
  const p = t.media.find((x) => x.id === mediaId);
  if (!p?.listed) throw new Error('List the playlist\'s videos first.');
  const { history = [], marks = {} } = await chrome.storage.local.get(['history', 'marks']);
  attachLibrary(t, history, marks);
  const isDone = (m) => m.mark === 'done' || (m.mark !== 'new' && ((m.library?.path && !m.library.missing) || history.some((h) => sameItem(m, h))));
  const busy = (m) => [...jobs.values()].some((j) => j.mediaId === m.id && (j.status === 'queued' || ACTIVE.includes(j.status)));
  const entries = t.media.filter((m) => m.parentId === p.id && !m.dismissed).sort((a, b) => a.playlistIndex - b.playlistIndex);
  let queued = 0;
  let skipped = 0;
  for (const e of entries) {
    const target = e.covered ? t.media.find((x) => x.id === e.covered) || e : e; // a played lecture downloads from its stream
    if (isDone(target) || isDone(e) || busy(target)) {
      skipped++;
      continue;
    }
    await enqueueDownload(tabId, target.id, target === e ? 'file' : 'best');
    queued++;
  }
  return { queued, skipped };
}

// ---------------------------------------------------------------- local helper

let helperCache = { at: 0, value: null };
async function helperStatus(force = false) {
  if (!force && helperCache.value && Date.now() - helperCache.at < 60000) return helperCache.value;
  try {
    const res = await helperRequest({ type: 'ping' }, { timeoutMs: 8000 });
    helperCache = { at: Date.now(), value: { ok: true, version: res.version, tools: res.tools || {} } };
  } catch (e) {
    helperCache = { at: Date.now(), value: { ok: false, error: e.message } };
  }
  return helperCache.value;
}

async function startYtdlp(tabId, { url, mediaId } = {}) {
  await loadJobs();
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const item = mediaId ? t.media.find((x) => x.id === mediaId) : null;
  // A video listed from a playlist downloads through that playlist (domain-restricted showcases need it).
  const viaPlaylist = item?.parentId && item.playlistUrl && item.playlistIndex;
  const target = viaPlaylist ? item.playlistUrl : item?.url || (isHttpUrl(url || '') ? url : t.pageUrl);
  const helper = await helperStatus(true);
  if (!helper.ok) throw new Error(helper.error);
  if (!helper.tools?.ytdlp) throw new Error('yt-dlp was not found on your PATH. Install it (winget install yt-dlp) and try again.');
  const settings = await getSettings();
  const [dl] = await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] });
  const job = {
    // Recorded under the video itself, not the playlist it was fetched through (or the playlist would count as saved).
    id: crypto.randomUUID(), tabId, kind: 'ytdlp', mediaUrl: item?.url || target, pageUrl: t.pageUrl,
    mediaId: item?.id || '', mediaKeys: item ? keysOf(item) : [], optionId: 'file',
    title: item?.customName || item?.title || t.pageTitle || t.pageUrl, filename: 'yt-dlp', status: 'running', tracks: [], outputs: [],
    progress: { done: 0, total: 100, bytes: 0, percent: true }, startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  persistJobs(true);
  const rules = rulesFor(settings, t.pageUrl);
  const date = new Date().toISOString().slice(0, 10);
  const course = sanitizeFilename(item?.course || '', 80);
  // One video with a known name: name it like every other download (template, {number}, {name}).
  const name = item && !item.playlist && (item.customName || item.title)
    ? buildFilename(rules.filenameTemplate, { title: item.customName || item.title, quality: '', course, page: t.pageTitle || '', host: siteKey(t.pageUrl || target), date, kind: 'ytdlp' }, '')
    : '';
  helperRequest({
    type: 'ytdlp',
    url: target,
    playlist: !!item?.playlist && !viaPlaylist, // a showcase: download every video in it
    items: viaPlaylist ? String(item.playlistIndex) : undefined,
    name: name || undefined,
    referer: t.pageUrl,
    subfolder: resolveFolder(rules.subfolder, { site: siteKey(t.pageUrl), course, date, kind: 'ytdlp' }),
    dir: settings.saveFolder || '',
    downloadsHint: dl?.filename || '',
  }, {
    timeoutMs: 6 * 60 * 60 * 1000,
    onProgress: (p) => {
      if (Number.isFinite(p.percent)) job.progress = { done: p.percent, total: 100, bytes: 0, percent: true };
      if (p.line) job.note = p.line.slice(0, 160);
      persistJobs();
    },
  }).then(async (res) => {
    job.status = 'done';
    job.finishedAt = Date.now();
    job.outputs = (res.files || []).map((f) => ({ role: 'file', path: f, filename: f }));
    job.note = res.files?.length > 1 ? `Saved ${res.files.length} videos to ${parentDir(res.files[0])}`
      : res.files?.length ? `Saved to ${res.files[0]}` : 'yt-dlp finished';
    if (res.warning) job.note += ` · some videos failed: ${res.warning.slice(0, 160)}`;
    persistJobs(true);
    pumpQueue();
    await addHistory(job);
  }).catch((e) => failJob(job.id, e.message));
  return publicJob(job);
}

// ---------------------------------------------------------------- AI features

async function aiFind(tabId) {
  const settings = await getSettings();
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const snap = await pageSnapshot(tabId);
  const lastErr = [...jobs.values()].filter((j) => j.tabId === tabId && j.status === 'error').pop()?.error || '';
  const prompt = buildFindPrompt({
    pageUrl: t.pageUrl || snap.url,
    pageTitle: t.pageTitle || snap.title,
    detected: visibleMedia(t).map((m) => ({ kind: m.kind, url: m.url })),
    network: t.log,
    dom: snap.dom,
    snippets: snap.snippets,
    previousError: lastErr,
  });
  const res = await callAI(settings, prompt);
  const result = normalizeFindResult(res.data, t.pageUrl || snap.url);
  const mediaUrls = result.candidates.filter((c) => c.kind !== 'page').map((c) => c.url);
  const added = await addFoundUrls(tabId, mediaUrls, 'ai');
  let recipeTest = null;
  if (result.recipe) {
    // Dry-run the recipe right away so the user can see whether it works before saving it.
    const snap2 = await pageSnapshot(tabId, selectorsFor(result.recipe)).catch(() => snap);
    recipeTest = await runRecipe(result.recipe, { ...snap2, network: t.log.map((l) => l.url) }, (u) => fetchText(u, { maxBytes: 2_000_000 }))
      .catch((e) => ({ urls: [], log: [e.message] }));
    const fromRecipe = await addFoundUrls(tabId, recipeTest.urls, 'recipe');
    added.push(...fromRecipe);
  }
  t.aiResult = { ...result, recipeTest, added: [...new Set(added)].length, via: res.via, at: Date.now() };
  persistTab(tabId);
  return t.aiResult;
}

async function aiDiagnose(jobId) {
  await loadJobs();
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found');
  const settings = await getSettings();
  let status = job.httpStatus || 0;
  let headers = null;
  try {
    const res = await fetch(job.mediaUrl, { method: 'GET', headers: { Range: 'bytes=0-0' }, credentials: 'include' });
    status = status || res.status;
    headers = Object.fromEntries([...res.headers].slice(0, 30));
  } catch (e) {
    headers = { fetchError: e.message };
  }
  const res = await callAI(settings, buildDiagnosePrompt({
    job, error: job.error, pageUrl: job.pageUrl, mediaUrl: job.mediaUrl, status, headers,
  }));
  job.diagnosis = {
    cause: String(res.data?.cause || ''),
    fixes: Array.isArray(res.data?.fixes) ? res.data.fixes.map(String).slice(0, 8) : [],
    tryYtdlp: !!res.data?.try_ytdlp,
  };
  persistJobs(true);
  return job.diagnosis;
}

/** Fetch captions for a media item (subtitle file, HLS subtitle playlist, or HLS master's first sub track). */
async function captionsFor(m) {
  if (m.kind === 'subtitle') {
    const text = await fetchText(m.url);
    return m.ext === 'srt' ? srtToVtt(text) : text;
  }
  if (m.kind === 'hls') {
    const pl = parseM3U8(await fetchText(m.url), m.url);
    let subUrl = null;
    if (pl.type === 'master') {
      const subs = pl.subtitles.filter((s) => s.url);
      subUrl = (subs.find((s) => /^en/i.test(s.language)) || subs[0])?.url;
    } else if (m.mediaType === 'subtitle') subUrl = m.url;
    if (!subUrl) return null;
    const sp = await loadHlsMedia(subUrl);
    const texts = [];
    for (const seg of sp.segments.slice(0, 600)) texts.push(await fetchText(seg.url).catch(() => ''));
    return mergeVttSegments(texts);
  }
  if (m.kind === 'dash') {
    const mpd = parseMPD(await fetchText(m.url), m.url);
    const s = mpd.subtitles.find((x) => /^en/i.test(x.lang)) || mpd.subtitles[0];
    if (!s || !/vtt/i.test(s.mimeType)) return null;
    const texts = [];
    for (const seg of s.segments.slice(0, 600)) texts.push(await fetchText(seg.url).catch(() => ''));
    return s.segments.length > 1 ? mergeVttSegments(texts) : texts[0];
  }
  return null;
}

async function aiSummarize(tabId, mediaId) {
  const settings = await getSettings();
  const t = await getTab(tabId);
  const candidates = mediaId
    ? t.media.filter((x) => x.id === mediaId)
    : [...t.media.filter((x) => x.kind === 'subtitle'), ...t.media.filter((x) => x.info?.hasSubtitles)];
  let vtt = null;
  let used = null;
  for (const m of candidates) {
    vtt = await captionsFor(m).catch(() => null);
    if (vtt && vtt.length > 50) {
      used = m;
      break;
    }
  }
  if (!vtt) throw new Error('No captions found on this page. Turn on the player\'s captions (CC) so they load, then try again.');
  const captionsText = captionsToText(vtt);
  const res = await callAI(settings, buildSummaryPrompt({ title: t.pageTitle, captionsText }));
  const summary = normalizeSummary(res.data);
  const markdown = summaryToMarkdown(summary, t.pageUrl);
  return { summary, markdown, via: res.via, from: used?.url };
}

async function saveTextFile(filename, text, mime = 'text/markdown') {
  const settings = await getSettings();
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
  const folder = resolveFolder(settings.subfolder, { site: '', date: new Date().toISOString().slice(0, 10), kind: 'text' });
  const name = folder ? `${folder}/${filename}` : filename;
  return chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify' });
}

// ---------------------------------------------------------------- messages

const handlers = {
  async getTabState({ tabId, panel = false }) {
    await loadJobs();
    await refreshDirectProgress();
    const t = await getTab(tabId);
    await refreshTabInfo(tabId, t);
    const settings = await getSettings();
    const recipe = t.pageUrl ? await recipeForUrl(t.pageUrl) : null;
    const allJobs = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    await loadLibrary();
    if (Date.now() - library.at > 60000) scanLibrary().catch(() => {});
    const { history = [], marks = {} } = await chrome.storage.local.get(['history', 'marks']);
    coverEntries(t);
    attachLibrary(t, history, marks);
    pumpQueue(); // in case the worker restarted with downloads waiting
    // The sidebar lists what is in your folders (newest first), marking the files this page's videos matched.
    const matched = new Set(t.media.map((m) => m.library?.path?.toLowerCase()).filter(Boolean));
    const files = panel
      ? [...(library.files || [])].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0)).slice(0, 2000)
        .map((f) => ({ path: f.path, name: f.name, size: f.size, duration: f.duration || 0, at: f.mtimeMs || 0, here: matched.has(f.path.toLowerCase()) }))
      : undefined;
    const media = visibleMedia(t).sort((a, b) => rank(a) - rank(b) || (b.size || 0) - (a.size || 0));
    return {
      playing: media.length > 1 ? await playingIn(tabId, media.filter((m) => !m.dismissed)).catch(() => null) : null,
      library: {
        at: library.at, count: library.files?.length || 0, dirs: library.dirs || [], scanning: !!libraryScan,
        pending: library.pending || 0, error: library.error || '', extra: settings.libraryFolders || [],
        downloads: settings.checkDownloads !== false, files,
      },
      page: { url: t.pageUrl, title: t.pageTitle, site: t.pageUrl ? siteKey(t.pageUrl) : '' },
      media,
      removedCount: t.media.filter((m) => m.dismissed).length,
      // Playlist entries shown through the stream card you played (for the playlist's counts).
      coveredEntries: t.media.filter((m) => m.covered && !m.dismissed).map((m) => ({ id: m.id, parentId: m.parentId, covered: m.covered, title: m.title })),
      jobs: allJobs.filter((j) => j.tabId === tabId || ['running', 'recording', 'muxing', 'queued'].includes(j.status)).slice(0, 40).map(publicJob),
      aiResult: t.aiResult,
      recipe,
      ai: { provider: settings.aiProvider, configured: settings.aiProvider === 'subscription' || (settings.aiProvider === 'api' && !!settings.apiKey) },
      helper: helperCache.value,
    };
  },
  inspect: ({ tabId, mediaId }) => inspectCached(tabId, mediaId),
  download: ({ tabId, mediaId, optionId }) => enqueueDownload(tabId, mediaId, optionId),
  listPlaylist: ({ tabId, mediaId }) => listPlaylist(tabId, mediaId),
  downloadMissing: ({ tabId, mediaId }) => downloadMissing(tabId, mediaId),
  toolVersions: () => helperRequest({ type: 'toolVersions' }, { timeoutMs: 60000 }),
  updateYtdlp: () => helperRequest({ type: 'updateYtdlp' }, { timeoutMs: 6 * 60 * 1000 }),
  cancelJob: ({ jobId }) => cancelJob(jobId),
  async stopLive({ jobId }) {
    await toOffscreen({ type: 'stopLive', jobId });
    return { ok: true };
  },
  async clearJobs() {
    await loadJobs();
    for (const [id, j] of jobs) if (['done', 'error', 'canceled'].includes(j.status)) jobs.delete(id);
    persistJobs(true);
    return { ok: true };
  },
  async openFile({ downloadId, path: filePath }) {
    if (downloadId != null) {
      chrome.downloads.show(downloadId);
      return { ok: true };
    }
    if (filePath) {
      // A file Chrome downloaded? Then Chrome can reveal it itself.
      const [d] = await chrome.downloads.search({ filename: filePath, limit: 1 }).catch(() => []);
      if (d && d.exists !== false) {
        chrome.downloads.show(d.id);
        return { ok: true };
      }
      // Otherwise (ffmpeg output) ask the helper to open Explorer on it.
      try {
        await helperRequest({ type: 'reveal', path: filePath }, { timeoutMs: 8000 });
        return { ok: true };
      } catch { /* fall through */ }
    }
    chrome.downloads.showDefaultFolder();
    return { ok: true };
  },
  aiFind: ({ tabId }) => aiFind(tabId),
  aiDiagnose: ({ jobId }) => aiDiagnose(jobId),
  aiSummarize: ({ tabId, mediaId }) => aiSummarize(tabId, mediaId),
  async saveSummary({ markdown, title }) {
    await saveTextFile(`${sanitizeFilename(title || 'summary', 100)} - summary.md`, markdown);
    return { ok: true };
  },
  async saveRecipe({ recipe }) {
    const r = normalizeRecipe(recipe);
    const recipes = await getRecipes();
    recipes[r.site] = { ...r, savedAt: Date.now() };
    await chrome.storage.local.set({ recipes });
    return r;
  },
  runRecipe: ({ tabId }) => runSavedRecipe(tabId),
  async rescan({ tabId }) {
    const t = await getTab(tabId);
    const before = new Set(visibleMedia(t).map((m) => m.id));
    // Frames opened before StreamSnag was (re)loaded have no content script yet: add it (it ignores repeats).
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
    // Look at every embedded player again (fresh signed links, players added since).
    t.embeds = {};
    t.media.filter((m) => !m.title).forEach((m) => { m.nameTries = 0; });
    const ids = await frameIdsOf(tabId);
    await Promise.all(ids.map((frameId) => chrome.tabs.sendMessage(tabId, { type: 'rescan' }, { frameId }).catch(() => {})));
    runSavedRecipe(tabId, { quiet: true }).catch(() => {});
    scanLibrary({ force: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500)); // reports are debounced; embeds resolve over the network
    const after = visibleMedia(await getTab(tabId));
    return { added: after.filter((m) => !before.has(m.id)).length, total: after.length, frames: ids.length };
  },
  helperStatus: ({ force }) => helperStatus(!!force),
  // "Remove from list" for anything that is still a duplicate or just not wanted.
  async dismissMedia({ tabId, mediaId }) {
    const t = await getTab(tabId);
    const m = t.media.find((x) => x.id === mediaId);
    if (m) Object.assign(m, { dismissed: true, hidden: true });
    persistTab(tabId);
    return { ok: true };
  },
  async restoreMedia({ tabId }) {
    const t = await getTab(tabId);
    for (const m of t.media) {
      if (m.dismissed) {
        m.dismissed = false;
        m.hidden = t.childKeys.has(m.key);
      }
    }
    persistTab(tabId);
    return { ok: true };
  },
  async renameMedia({ tabId, mediaId, name }) {
    const t = await getTab(tabId);
    const m = t.media.find((x) => x.id === mediaId);
    if (!m) throw new Error('That item is gone. Reload the page.');
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    if (clean) m.customName = clean;
    else delete m.customName;
    persistTab(tabId);
    return { name: m.customName || m.title || '' };
  },
  // "Mark as downloaded" / "Mark as not downloaded" when the folder check gets an item wrong; null clears it.
  async markMedia({ tabId, mediaId, as }) {
    const t = await getTab(tabId);
    const m = t.media.find((x) => x.id === mediaId);
    if (!m) throw new Error('That item is no longer on the list.');
    const { marks = {} } = await chrome.storage.local.get('marks');
    for (const k of markKeys(m)) {
      if (as === 'done' || as === 'new') marks[k] = { as, at: Date.now() };
      else delete marks[k];
    }
    const keys = Object.keys(marks);
    if (keys.length > 4000) keys.sort((a, b) => marks[a].at - marks[b].at).slice(0, keys.length - 4000).forEach((k) => delete marks[k]);
    await chrome.storage.local.set({ marks });
    return { ok: true };
  },
  // "Check folder now": scan again and wait for the answer.
  async checkLibrary() {
    const lib = await scanLibrary({ force: true });
    return { count: lib.files?.length || 0, dirs: lib.dirs || [], error: lib.error || '' };
  },
  // Extra folders to look in for videos you already have (Settings or the popup's "Add folder…").
  async addLibraryFolder({ path: given }) {
    const picked = given || (await helperRequest({ type: 'pickFolder', start: '' }, { timeoutMs: 10 * 60 * 1000 })).path;
    if (!picked) return { path: '' };
    const ok = await helperRequest({ type: 'checkFolder', path: picked }, { timeoutMs: 10000 });
    const folder = ok.path || picked;
    const { settings = {} } = await chrome.storage.local.get('settings');
    const list = [...new Set([...(settings.libraryFolders || []), folder])].slice(0, 30);
    await chrome.storage.local.set({ settings: { ...settings, libraryFolders: list } });
    scanLibrary({ force: true }).catch(() => {});
    return { path: folder, folders: list };
  },
  async removeLibraryFolder({ path: folder }) {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const list = (settings.libraryFolders || []).filter((d) => d !== folder);
    await chrome.storage.local.set({ settings: { ...settings, libraryFolders: list } });
    scanLibrary({ force: true }).catch(() => {});
    return { folders: list };
  },
  // Folder picker + validation for Settings → Downloads → "Save to".
  pickFolder: ({ start }) => helperRequest({ type: 'pickFolder', start: start || '' }, { timeoutMs: 10 * 60 * 1000 }).then((r) => ({ path: r.path || '' })),
  checkFolder: ({ path: p }) => helperRequest({ type: 'checkFolder', path: p }, { timeoutMs: 10000 }),
  ytdlp: ({ tabId, url, mediaId }) => startYtdlp(tabId, { url, mediaId }),
  async testAI() {
    const settings = await getSettings();
    const res = await callAI(settings, {
      system: 'You are a connectivity check. Respond with JSON only.',
      user: 'Reply with {"ok": true, "message": "<a 3-word greeting>"}',
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false },
      maxTokens: 2000,
    });
    return { ...res.data, via: res.via };
  },
};

function rank(m) {
  return { hls: 0, dash: 0, direct: 1, embed: 1.5, subtitle: 2 }[m.kind] ?? 3;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  // Web pages (through content scripts) may only report what they found. Everything else — downloads, the
  // helper, folders, settings — is for StreamSnag's own pages (popup, sidebar, settings, offscreen).
  const fromExtension = sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));

  // Content script reports.
  if (msg.type === 'contentMedia' && sender.tab) {
    const tabId = sender.tab.id;
    (async () => {
      const t = await getTab(tabId);
      const isTop = sender.frameId === 0; // from Chrome, not from what the page claims
      if (isTop && msg.pageTitle) t.pageTitle = msg.pageTitle;
      for (const it of msg.items || []) {
        if (it.embed) {
          resolveEmbed(tabId, it).catch(() => {});
          continue;
        }
        let info = classifyUrl(it.url);
        if (!info && it.mediaType === 'subtitle') info = { kind: 'subtitle', mediaType: 'subtitle', ext: 'vtt', size: null, contentType: '' };
        if (!info && /mpegurl/i.test(it.contentType || '')) info = { kind: 'hls', mediaType: 'stream', ext: 'm3u8', size: null, contentType: it.contentType };
        if (!info) continue;
        // One unreadable item must not stop the rest of the report: the last item is often the one that
        // matters, and it used to be dropped whenever an earlier addMedia threw.
        try {
          await addMedia(tabId, { ...info, url: it.url, source: 'page', poster: it.poster, duration: it.duration, lang: it.lang, label: it.label, frameUrl: isTop ? '' : msg.frameUrl });
        } catch { /* skip this item, keep the rest */ }
      }
    })().catch(() => {});
    return false;
  }

  // Offscreen progress/results.
  if ((msg.type === 'trackProgress' || msg.type === 'trackDone' || msg.type === 'trackError') && fromExtension) {
    (async () => {
      await loadJobs();
      const job = jobs.get(msg.jobId);
      if (!job || ['canceled', 'error'].includes(job.status)) {
        if (msg.blobUrl) toOffscreen({ type: 'revoke', url: msg.blobUrl }).catch(() => {});
        return;
      }
      const tr = job.tracks[msg.trackIndex];
      if (msg.type === 'trackProgress') {
        job.progress = { done: msg.done, total: msg.total, bytes: msg.bytes, live: !!msg.live };
        persistJobs();
      } else if (msg.type === 'trackError') {
        failJob(job.id, msg.error, { canceled: msg.canceled, status: msg.status });
      } else {
        tr.blobUrl = msg.blobUrl;
        tr.status = 'saving';
        job.progress = { ...job.progress, bytes: msg.size };
        const downloadId = await chrome.downloads.download({ url: msg.blobUrl, filename: tr.filename, conflictAction: 'uniquify' });
        tr.downloadId = downloadId;
        persistJobs(true);
      }
    })().catch((e) => failJob(msg.jobId, e.message));
    return false;
  }

  if (!fromExtension) return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

// ---------------------------------------------------------------- context menus & install

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ss-media', title: 'Download this media with StreamSnag', contexts: ['video', 'audio'] });
    chrome.contextMenus.create({ id: 'ss-ai', title: 'Find videos on this page with AI', contexts: ['page', 'video', 'frame'] });
    chrome.contextMenus.create({ id: 'ss-ytdlp', title: 'Download this page with yt-dlp (local helper)', contexts: ['page', 'video'] });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: String(message).slice(0, 200) });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || tab.id < 0) return;
  try {
    if (info.menuItemId === 'ss-media') {
      if (!info.srcUrl || !isHttpUrl(info.srcUrl)) {
        notify('Streamed video', 'This player streams in chunks. Open the StreamSnag popup and pick a quality from the list.');
        chrome.action.openPopup?.().catch(() => {});
        return;
      }
      const kind = (await probeUnknown(info.srcUrl, info.pageUrl || tab.url)) || { kind: 'direct', mediaType: info.mediaType || 'video', ext: mediaExtFromUrl(info.srcUrl), size: null };
      const m = await addMedia(tab.id, { url: info.srcUrl, ...kind, source: 'page' });
      if (m.kind === 'direct') {
        await startDownload(tab.id, m.id, 'file');
      } else {
        chrome.action.openPopup?.().catch(() => notify('Stream found', 'Open the StreamSnag popup to choose a quality.'));
      }
    } else if (info.menuItemId === 'ss-ai') {
      notify('Analyzing page…', 'Claude is looking for downloadable media. Open the popup to see results.');
      const r = await aiFind(tab.id);
      notify('AI analysis done', `${r.added} media item(s) added. ${r.summary}`.trim());
    } else if (info.menuItemId === 'ss-ytdlp') {
      await startYtdlp(tab.id);
      notify('yt-dlp started', 'Progress is shown in the StreamSnag popup.');
    }
  } catch (e) {
    notify('StreamSnag', e.message);
  }
});

chrome.notifications?.onClicked.addListener((id) => {
  if (id.startsWith('done:')) chrome.downloads.showDefaultFolder();
});

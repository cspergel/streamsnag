// StreamSnag service worker: sniffs media, runs download jobs, talks to the AI and the local helper.
import { classifyResponse, classifyUrl, dedupeKey, sameMedia, sameNamedFile, streamFingerprint, mediaExtFromUrl, manifestKind, streamInData, isImageTrack, playerPiece, /* @site-edition */ youTubeWatchId, youTubeTitle /* @end-site-edition */ } from './lib/detect.js';
import { parseM3U8, outputExtForMedia } from './lib/hls.js';
import { parseMPD, dashExt } from './lib/dash.js';
import { mergeVttSegments, captionsToText, srtToVtt } from './lib/vtt.js';
import { runRecipe, selectorsFor, normalizeRecipe, recipeFor, provenRecipe } from './lib/recipes.js';
import { BUILTIN_RECIPES } from './lib/builtin-recipes.js';
import { findConfirm, summaryConfirm, whyConfirm, namedHosts, refusedAddress, looksLikeCaptions, ruleName, titledByRule } from './lib/rescue.js';
import {
  buildFindPrompt, buildDiagnosePrompt, buildSummaryPrompt, buildFilenamePrompt,
  normalizeFindResult, normalizeSummary, summaryToMarkdown, CONDENSED_NOTE, PROVIDER_LABELS,
} from './lib/ai.js';
import { callAI, helperRequest } from './lib/ai-transport.js';
import { getSettings, sttModelOf } from './lib/settings.js';
import { findInLibrary, nameKey, serviceId, leadNumber, sameItem, savedPathsOf } from './lib/match.js';
import { applyRefererRules, installLocalGuard, allowLocal } from './lib/headers.js';
import { DOC_EXTS, frameDocs, mergeDocs, docLabel, docFilename, docStatus, isWebPageMime, WEB_PAGE_NOT_FILE, inDocsBulk } from './lib/files.js';
import { mediaSnapshot, docSnapshot, plainError, skippedNote, leftoverTracks, installHint, savedBytes, NOT_A_STREAM } from './lib/jobs.js';
import { readSegments, coverageNote, captionFiles, orderSubtitles, langOfFile, wordChecks, WORD_CHECKS } from './lib/captions.js';
import { pickPreferred, canBulkDownload, variantLabel, audioOnly, uniqueChoices } from './lib/quality.js';
import { cleanName, downloadName, mergedExt, plannedFile, saveRoot, mapLimit, pathRoom, keptSuffix, PATH_LIMIT } from './lib/plan.js';
import { hlsParts, dashParts, isPart, addParts, ownCaption } from './lib/parts.js';
import { chooseName, fileTitle, weakName, fileLikeName, pageNameWins } from './lib/naming.js';
import { playerAt, playerFrames, playerVideo, playerPlaceholder, joinPlayer } from './lib/players.js';
import { graceStart, splitAtChange, comeBack, leftBehind } from './lib/pagechange.js';
import { noteLinks, linksWaiting, linksLeftOut, linkName, listSort, sameLecture, formatTwins, talkName } from './lib/linked.js';
import { groupVariants, variantOptions, variantChoice, heightOf, pagePlaylists } from './lib/variants.js';
import { LIVE_DASH, noCaptions } from './lib/wording.js';
import { newRate, feedRate, readRate } from './lib/rate.js';
import { buildTranscript, hasWords, imageCues } from './lib/transcript.js';
import { companionFilename } from './lib/study.js';
import { parseCues, cleanCues } from './lib/transcript.js';
import { keepAlive } from './lib/keepalive.js';
import { flagItems, foldedIds } from './lib/review.js';
import { LEFT_OUT_KEY, lectureKeys, leaveOut, includeAgain, leftOutAuto, isLeftOut } from './lib/leftout.js';

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
  // One video offered in several files is one item with choices (lib/variants.js): kept true on every change.
  if (tabs.get(tabId)) {
    groupVariants(tabs.get(tabId).media);
    for (const m of tabs.get(tabId).media) if (m.kind === 'direct') m.label = describe(m); // "MP4 · 4 qualities · 1.2 GB"
  }
  updateBadge(tabId);
  if (tabs.get(tabId)?.media?.length) debugSnapshot(tabId);
}

function visibleMedia(t) {
  return t.media.filter((m) => !m.hidden && !m.covered && !m.variantOf);
}

/** What the tab's streams are made of (lib/parts.js), kept on the tab so a restarted worker still knows. */
function streamParts(t) {
  t.childPatterns = t.childPatterns || [];
  t.childFolders = t.childFolders || [];
  return { keys: t.childKeys, patterns: t.childPatterns, folders: t.childFolders };
}

/**
 * Is this address one of a stream's own files (a playlist, an init file, a segment, a whole-track file),
 * or a caption file kept with the stream's own subtitles? See lib/parts.js.
 */
function isStreamPart(t, key) {
  const parts = streamParts(t);
  return isPart(parts, key) || ownCaption(parts, key);
}

/**
 * The files of a stream that were listed before its manifest was read are taken off the list: they are
 * the stream's, never videos of their own (and never offered when the stream is protected).
 */
function hideStreamParts(t, stream) {
  for (const other of t.media) {
    if (other === stream || other.dismissed || other.hidden) continue;
    if (!keysOf(other).some((k) => isStreamPart(t, k))) continue;
    other.hidden = true;
    other.part = true;
    noteMerge(t, stream, other, 'part of the stream');
  }
}

/** The languages subtitles and captions are picked by: the browser's own, and the page's (lib/captions.js). */
const subPrefs = (t) => ({ langs: [...(globalThis.navigator?.languages || [])], pageLang: t?.pageLang || '' });

/**
 * What the popup's list folds away on this tab (a second copy, the same lecture as sound only, a preview or
 * ad, a short clip: lib/review.js), worked out from the same facts the popup goes by. Empty when "Show" was
 * chosen on this page or Settings says "Always show everything".
 */
function foldedOn(t, list, showAll = false) {
  if (showAll || t.foldOpen) return new Set();
  const order = new Map(t.media.map((m, i) => [m.id, i]));
  const items = list.filter((m) => m.kind !== 'subtitle').map((m) => ({
    id: m.id, name: m.customName || m.title || '', borrowed: !m.customName && (m.nameSource === 'title' || !m.title), url: m.url,
    duration: m.info?.duration || m.duration || 0, kind: m.kind, mediaType: m.mediaType, playlist: !!m.playlist, protected: !!m.protected,
    live: !!m.info?.live, height: m.info?.maxHeight || 0, linked: !!m.linked, size: m.size || 0, ext: m.ext || '', order: order.get(m.id) ?? 1e9, status: 'new',
  }));
  return foldedIds(items, flagItems(items, { site: hostOf(t.pageUrl || '') }));
}

let showEverything = false; // Settings: "Always show everything" (kept here for the toolbar's count)
getSettings().then((s) => { showEverything = s.showEverything === true; }).catch(() => {});

function updateBadge(tabId) {
  const t = tabs.get(tabId);
  // The toolbar's count is what the list shows: not what it folds away.
  const shown = t ? visibleMedia(t).filter((m) => m.kind !== 'subtitle') : [];
  const n = t ? shown.length - foldedOn(t, shown, showEverything).size : 0;
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
  if (m.variants?.length > 1) bits.push(`${m.variants.length} ${m.variants.some((v) => v.height) ? 'qualities' : 'formats'}`);
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
  // What the stream is made of (lib/parts.js): its files are never listed as videos of their own.
  const own = (parts) => {
    addParts(streamParts(t), parts);
    hideStreamParts(t, m);
  };
  let playlists = []; // an HLS master's other playlists, read below for the files behind them
  try {
    await applyRefererRules([m.url], m.pageUrl || t.pageUrl);
    const asked = m.url;
    const text = await fetchText(asked);
    const is = manifestKind(text);
    if (!is && m.url !== asked) return; // it has another address by now, which is being read (addMedia)
    // An address that ends like a stream's, an answer that is no playlist or manifest (a player's question
    // answered with data, a sign-in page). What the page was sent under a stream's own type stays listed
    // (the page may have been given what we were refused), and says why it cannot be read.
    if (!is && notStream(tabId, t, m, text)) return;
    if (!is) throw new Error(NOT_A_STREAM);
    delete m.probeError;
    if (is === 'hls') {
      m.kind = 'hls';
      const pl = parseM3U8(text, m.url);
      own(hlsParts(pl, m.url));
      if (pl.type === 'master') {
        // Every quality and every sound track, and the subtitles most likely to be switched on (a talk can have sixty).
        playlists = [...pl.variants.slice(1, 16), ...pl.audio.slice(0, 8), ...orderSubtitles(pl.subtitles, subPrefs(t)).slice(0, 8)].map((x) => x.url).filter(Boolean);
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
        if (pl.variants[0]?.url) {
          try {
            const vpl = parseM3U8(await fetchText(pl.variants[0].url), pl.variants[0].url);
            own(hlsParts(vpl));
            if (pl.protected) { /* its length is not needed: nothing of it is offered */ } else if (vpl.endList) m.info.duration = vpl.totalDuration;
            else m.info.live = true;
          } catch { /* length is optional */ }
        }
      } else {
        m.info = { master: false, live: !pl.endList, duration: pl.totalDuration, segments: pl.segments.length };
        if (pl.endList) m.fingerprint = streamFingerprint(pl.segments.map((x) => x.url), 'hls-media');
        m.protected = pl.protected;
        if (pl.segmentExt === 'vtt' || pl.segmentExt === 'webvtt') m.mediaType = 'subtitle';
      }
    } else {
      m.kind = 'dash';
      const mpd = parseMPD(text, m.url);
      own(dashParts(mpd));
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
  // The files behind the other qualities and tracks (a player may switch to any of them) are in playlists
  // of their own. Those are only read when it matters: when a file turns up that might be one of theirs
  // (readOtherPlaylists). A playlist the player itself loads is read as it arrives, like any stream.
  if (playlists.length) m.unread = playlists;
  persistTab(tabId);
  if (t.media.some((x) => x !== m && !x.hidden && !x.dismissed && (x.kind === 'direct' || x.kind === 'subtitle'))) await readOtherPlaylists(tabId, t);
}

const STREAM_TYPE = /mpegurl|dash\+xml|vnd\.mpeg\.dash/i;

/**
 * A listed "stream" whose answer is no playlist or manifest: when the page's own request was answered
 * under another type too (JSON, a web page), it is taken off the list for good (its address is not
 * looked at again on this page), and the stream address its data plainly holds, if any, is listed in its
 * place. Returns false when it stays listed: found in the page's markup, or sent to the page as a stream.
 */
function notStream(tabId, t, m, text) {
  if (m.source !== 'network' || STREAM_TYPE.test(m.contentType || '')) return false;
  const instead = streamInData(text, m.url);
  t.media = t.media.filter((x) => x !== m);
  const skipped = Object.entries({ ...(t.skip || {}), ...Object.fromEntries(keysOf(m).map((k) => [k, 1])) });
  t.skip = Object.fromEntries(skipped.slice(-200));
  noteMerge(t, { title: '', key: instead }, m, 'not a stream');
  persistTab(tabId);
  if (instead && autoFetchAllowed(instead, m.pageUrl || t.pageUrl)) {
    addMedia(tabId, { ...classifyUrl(instead), url: instead, source: 'network', frameId: m.frameId, frameUrl: m.frameUrl }).catch(() => {});
  }
  return true;
}

const trackLooks = new Map(); // "tabId:key" -> the look in progress

/**
 * Is a caption file the page has loaded a thumbnail index (a player's seek-bar pictures: every cue
 * points at a picture)? Read once per page; a file that cannot be read is taken for captions.
 */
async function pictureTrack(tabId, t, url) {
  const key = dedupeKey(url);
  t.tracks = t.tracks || {};
  if (Object.hasOwn(t.tracks, key)) return t.tracks[key];
  if (t.media.some((m) => keysOf(m).includes(key)) || !autoFetchAllowed(url, t.pageUrl)) return false;
  const id = `${tabId}:${key}`;
  if (!trackLooks.has(id)) {
    const look = (async () => {
      let pictures = false;
      try {
        await applyRefererRules([url], t.pageUrl);
        pictures = imageCues(await fetchText(url, { maxBytes: 300_000 }));
      } catch { /* not readable from here: listed as it was */ }
      if (Object.keys(t.tracks).length < 200) t.tracks[key] = pictures;
      return pictures;
    })();
    trackLooks.set(id, look);
    look.finally(() => trackLooks.delete(id));
  }
  return trackLooks.get(id);
}

const partReads = new Map(); // tabId -> the reading in progress

/**
 * Before a file is listed on a page that has an HLS stream: read the stream's playlists that have not
 * been read yet, so a file that is one of its qualities or sound tracks is known as the stream's own.
 * Once per stream, a few playlists at a time; files already listed are taken off again (hideStreamParts).
 */
async function readOtherPlaylists(tabId, t) {
  const todo = t.media.filter((m) => m.unread?.length && !m.dismissed);
  if (!todo.length) return partReads.get(tabId);
  const reading = (async () => {
    await partReads.get(tabId)?.catch(() => {});
    for (const m of todo) {
      const urls = m.unread.filter((u) => autoFetchAllowed(u, m.pageUrl || t.pageUrl));
      m.unread = [];
      await applyRefererRules(urls, m.pageUrl || t.pageUrl).catch(() => {});
      await mapLimit(urls, 4, async (url) => {
        try {
          addParts(streamParts(t), hlsParts(parseM3U8(await fetchText(url, { maxBytes: 2_000_000 }), url)));
        } catch { /* a playlist that can't be read hides nothing */ }
      });
      hideStreamParts(t, m);
    }
    persistTab(tabId);
  })();
  partReads.set(tabId, reading);
  reading.finally(() => { if (partReads.get(tabId) === reading) partReads.delete(tabId); });
  return reading;
}

// ---------------------------------------------------------------- embedded players
// Vimeo/Wistia players in tabs or accordions that were never opened don't load anything, so nothing
// shows up in network traffic. Their public player config says where the stream is and what it's called.

const PROVIDER_NAMES = {
  'vimeo-showcase': 'Vimeo showcase',
  'vimeo-event': 'Vimeo live event',
  vimeo: 'Vimeo', wistia: 'Wistia', /* @site-edition */ youtube: 'YouTube', /* @end-site-edition */ loom: 'Loom', dailymotion: 'Dailymotion',
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

const embedTurns = new Map(); // "tabId:provider:id" -> the last look at that player, so two never overlap

/**
 * One embedded player the page reported. A player whose stream is learned from its own site's data (Vimeo,
 * Wistia) is not looked up before StreamSnag is opened on the tab (`ask`): its data is at an address the
 * page itself may never have asked for (a player in a tab that was never opened loads nothing). Until then
 * it is listed, and counted on the toolbar, as the player it is (a placeholder, `pending`), named from
 * what the page says of it; askHeld looks it up, and the placeholder becomes the video in place.
 */
function resolveEmbed(tabId, it, opts = {}) {
  const { provider, id } = it.embed || {};
  if (!provider || !id) return Promise.resolve();
  const turn = `${tabId}:${provider}:${id}`;
  const run = (embedTurns.get(turn) || Promise.resolve()).then(() => lookAtEmbed(tabId, it, opts)).catch(() => {});
  embedTurns.set(turn, run);
  run.finally(() => { if (embedTurns.get(turn) === run) embedTurns.delete(turn); });
  return run;
}

async function lookAtEmbed(tabId, it, { ask = false } = {}) {
  const t = await getTab(tabId);
  const { provider, id } = it.embed;
  const ekey = `${provider}:${id}`;
  t.embeds = t.embeds || {};
  if (t.embeds[ekey]) return; // already handled on this page
  // @site-edition
  // @store-edition
  // // A player StreamSnag cannot look inside is not listed: nothing here could save its video.
  // if (!EMBED_RESOLVERS[provider]) return;
  // @end-site-edition
  // (What a player's control says, "Play", or "Play: " before its title, is not what the video is called.)
  const label = String(it.label || '').replace(/^(?:play|watch|listen to)\s*:\s*/i, '');
  const fallbackName = (label && !weakName(label, 'embed') ? label : '') || it.section || '';
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
  // The player itself, as an item: what is listed while a player that can be looked up has not been.
  // @site-edition
  // (And when StreamSnag can't see inside it (YouTube, a private video): yt-dlp is offered instead.)
  // @end-site-edition
  const asPlayer = async () => {
    const pageUrl = provider === 'vimeo-showcase' ? `https://vimeo.com/showcase/${id}`
      : provider === 'vimeo-event' ? `https://vimeo.com/event/${id}` : it.url;
    const m = await addMedia(tabId, { url: pageUrl, kind: 'embed', mediaType: 'video', ext: '', size: null, contentType: '', source: 'embed' });
    // A player that says nothing of its video takes the lecture's name from the page around it
    // (nameFromPage), not a placeholder like "Vimeo video". A showcase is many videos: it keeps its own label.
    tag(m, fallbackName || (provider === 'vimeo-showcase' ? `${PROVIDER_NAMES[provider]} ${id}` : ''));
    if (m) m.playlist = provider === 'vimeo-showcase';
    return m;
  };
  // The video this player has loaded itself (seen from inside its own frame), when it is listed: the player
  // is then never listed beside it, whichever of the two was seen first (playedPlaceholder is the other order).
  const loaded = async () => {
    if (!EMBED_RESOLVERS[provider]) return null;
    const own = playerVideo(t.media, await framesOf(tabId), it.url);
    if (!own) return null;
    t.media = joinPlayer(t.media, playerPlaceholder(t.media, it.url), own);
    tag(own, '');
    return own;
  };
  if (EMBED_RESOLVERS[provider] && !ask && !t.opened) {
    t.embedHeld = { ...(t.embedHeld || {}), [ekey]: it };
    if (!(await loaded())) {
      const m = await asPlayer();
      if (m?.kind === 'embed') m.pending = ekey; // not looked up yet: "Download all" leaves it alone until it is (lib/quality.js)
      await loaded(); // (its stream may have been listed while the placeholder was)
    }
    persistTab(tabId);
    updateBadge(tabId);
    return;
  }
  if (t.embedHeld) delete t.embedHeld[ekey];
  t.embeds[ekey] = Date.now();
  let found = [];
  try {
    if (EMBED_RESOLVERS[provider]) found = await EMBED_RESOLVERS[provider](it.embed, t.pageUrl);
  } catch (e) {
    t.embedErrors = { ...(t.embedErrors || {}), [ekey]: e.message };
  }
  // The player has loaded its video itself: that one is the video, whatever address the lookup gives for it
  // (a player's own stream is often at another address than the one its site's data names).
  if (await loaded()) {
    persistTab(tabId);
    updateBadge(tabId);
    return;
  }
  const waiting = t.media.find((x) => x.pending === ekey) || null;
  if (found.length) {
    for (const [i, f] of found.entries()) {
      const m = i === 0 && waiting ? await becomeVideo(tabId, t, waiting, f) : await addMedia(tabId, { ...f.info, url: f.url, source: 'embed', duration: f.duration, poster: f.poster });
      // (Its own site's name for it comes before what the page around the player was read to say.)
      // (Unless that name is only the file's the uploader left, "Deconstruct_DanAbramov_V3": then the page's is the name,
      // and the file's stands in only where the page has none.)
      const own = fileLikeName(f.title) ? '' : f.title;
      if (m === waiting && own && !m.customName) Object.assign(m, { title: '', course: '' });
      tag(m, own || fallbackName);
      if (m && !m.title && f.title) {
        await nameFromPage(tabId, m.id).catch(() => {});
        if (!m.title) Object.assign(m, { title: f.title, nameSource: 'embed' });
      } else if (m === waiting && !m.course) setTimeout(() => nameFromPage(tabId, m.id).catch(() => {}), 0);
    }
  } else {
    // @site-edition
    // Can't see inside this player (YouTube, a private video, a lookup that failed): it stays listed as the
    // player, and yt-dlp is offered for it.
    const m = await asPlayer();
    if (m) delete m.pending;
    if (waiting) delete waiting.pending;
    // @store-edition
    // // Nothing could be seen inside this player (a private video, a lookup that failed): nothing here could
    // // save its video, so its placeholder leaves the list.
    // if (waiting) t.media = t.media.filter((x) => x !== waiting);
    // @end-site-edition
  }
  persistTab(tabId);
}

/**
 * The placeholder of a player becomes the video the lookup found, in place: the same item (its id, its
 * place in the list, a name you gave it), now with the video's address and kind, so the list never shows
 * the player and its video side by side. When that video is listed already (its stream was seen as the
 * player started), the placeholder simply goes.
 */
async function becomeVideo(tabId, t, waiting, f) {
  const key = dedupeKey(f.url);
  const canon = canonicalKey(t, key);
  const listed = t.media.find((x) => x !== waiting && keysOf(x).some((k) => k === key || canonicalKey(t, k) === canon));
  if (listed) {
    if (waiting.customName && !listed.customName) listed.customName = waiting.customName;
    t.media = t.media.filter((x) => x !== waiting);
    return addMedia(tabId, { ...f.info, url: f.url, source: 'embed', duration: f.duration, poster: f.poster });
  }
  const poster = safePoster(f.poster, t.pageUrl);
  Object.assign(waiting, {
    key, url: f.url, aliases: [], kind: f.info.kind, mediaType: f.info.mediaType, ext: f.info.ext, size: f.info.size ?? null,
    contentType: f.info.contentType || '', source: 'embed', info: f.duration ? { duration: f.duration } : null,
    ...(poster ? { poster } : {}),
  });
  delete waiting.pending;
  delete waiting.playlist;
  waiting.label = describe(waiting);
  persistTab(tabId);
  // (What addMedia does for an item it has just listed.)
  if (waiting.kind === 'hls' || waiting.kind === 'dash') probeStream(tabId, waiting);
  else if (waiting.kind === 'direct' && !waiting.size) probeDirect(tabId, waiting);
  else return mergeDuplicates(t, waiting);
  return waiting;
}

/**
 * A stream or a file that arrives from inside a frame, on a page with a player still waiting to be looked
 * up: when that frame is the player's own (its address is the player's), the player has been started, and
 * what arrived is its video. The placeholder leaves the list, so the video is not there twice.
 */
async function playedPlaceholder(tabId, t, m) {
  const frames = await framesOf(tabId);
  const held = new Set(Object.values(t.embedHeld || {}).map((it) => playerAt(it.url)));
  // (Only a player whose video StreamSnag lists itself: a player it cannot see inside stays as it is.)
  const ours = (x) => !!x.pending || !!EMBED_RESOLVERS[x.provider] || held.has(playerAt(x.url));
  for (const waiting of t.media.filter((x) => x.kind === 'embed' && !x.playlist && ours(x))) {
    if (!t.media.includes(m) || !playerFrames(frames, waiting.url).has(m.frameId)) continue;
    t.media = joinPlayer(t.media, waiting, m);
    for (const k of ['provider', 'embedUrl', 'embedId']) if (waiting[k] && !m[k]) m[k] = waiting[k];
    persistTab(tabId);
    updateBadge(tabId);
    return;
  }
}

/** The tab's frames as the browser lists them ([{ frameId, parentFrameId, url }]); none when it can't say. */
async function framesOf(tabId) {
  return (await chrome.webNavigation?.getAllFrames({ tabId }).catch(() => null)) || [];
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
  // What the page's playlist calls it beats a name taken from the page as a whole; and which video's file
  // it is, its picture height, and whether a player has loaded it, hold whichever address said so.
  // (The course worked out around the name it had goes with that name: a lecture is not "of" the site.)
  if (dup.nameSource === 'playlist' && keep.nameSource !== 'playlist' && !keep.customName) Object.assign(keep, { title: dup.title, nameSource: 'playlist', course: dup.course || '' });
  for (const f of ['set', 'height', 'quality']) if (!keep[f] && dup[f]) keep[f] = dup[f];
  if (!keep.linked || !dup.linked) delete keep.linked;
  if (!keep.listed || !dup.listed) delete keep.listed;
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
    && (keysOf(x).some((k) => k === m.key || canonicalKey(t, k) === canon) || sameMedia(x, m) || sameNamedFile(x, m)));
  if (!twin) return m;
  // Keep the card that was listed first so the popup doesn't jump around.
  const [keep, dup] = twin.detectedAt <= m.detectedAt ? [twin, m] : [m, twin];
  const why = keysOf(twin).some((k) => k === m.key) ? 'same link' : keysOf(twin).some((k) => canonicalKey(t, k) === canon) ? 'redirect'
    : sameNamedFile(twin, m) ? 'the file a playlist or a link on the page names' : 'same size or stream';
  absorb(t, keep, dup, why);
  return keep;
}

function rememberRedirect(t, from, to) {
  t.redirects = t.redirects || {};
  t.redirects[dedupeKey(from)] = dedupeKey(to);
  const ks = Object.keys(t.redirects);
  if (ks.length > 300) delete t.redirects[ks[0]];
}

/** Has the page itself asked for this address (the worker saw its answer go by)? */
function loadedByPage(t, url) {
  const key = dedupeKey(url);
  return t.log.some((l) => l.url === url.slice(0, 800) || dedupeKey(l.url) === key);
}

const asking = new Map(); // tabId -> how many lookups started by opening StreamSnag are still on their way

/**
 * StreamSnag was opened on the tab (its state was asked for). From now on this page's files and players
 * may be asked about; what waited until now is: the players whose stream is learned from their site's
 * data (resolveEmbed: each is listed as a placeholder until then), and the files written into the page
 * that it has not loaded itself, for their size (probeDirect). Returns a promise for the players' lookups
 * (null when there are none): the first answer to the popup waits a moment for it, so a player is already
 * the video it is when the popup first shows it.
 */
function askHeld(tabId, t) {
  t.opened = true;
  const count = (p) => {
    asking.set(tabId, (asking.get(tabId) || 0) + 1);
    return p.catch(() => {}).finally(() => asking.set(tabId, Math.max(0, (asking.get(tabId) || 1) - 1)));
  };
  const players = Object.values(t.embedHeld || {});
  t.embedHeld = {};
  const files = t.media.filter((m) => m.unasked);
  for (const m of files) delete m.unasked;
  const todo = files.filter((m) => !m.dismissed && (m.kind !== 'direct' || !m.size));
  if (todo.length) count(mapLimit(todo, 3, (m) => (m.kind === 'direct' ? probeDirect(tabId, m) : probeStream(tabId, m))));
  // A stream's other playlists that waited to be read (a caption file may be one of the stream's own pieces): read now.
  if (t.media.some((m) => m.unread?.length && !m.dismissed)) count(Promise.resolve(readOtherPlaylists(tabId, t)));
  const words = captionWords(tabId, t);
  const waits = [players.length ? count(Promise.all(players.map((it) => resolveEmbed(tabId, it, { ask: true }).catch(() => {})))) : null, words ? count(words) : null].filter(Boolean);
  return waits.length ? Promise.all(waits) : null;
}

const wordRuns = new Map(); // tabId -> the reading in progress

/**
 * StreamSnag was opened on the tab: the caption file "Save transcript" would read for each video is read
 * now (a few files at most: lib/captions.js, wordChecks), so the button is only offered over a file with
 * words in it. A file that has none (a header and no cues) is not a caption file: it leaves the list, and
 * the next one is tried. One that cannot be read stays as it was. Null when there is nothing to read.
 */
function captionWords(tabId, t) {
  if (wordRuns.has(tabId)) return wordRuns.get(tabId);
  const plan = (room) => wordChecks(t.media, visibleMedia(t).filter((m) => m.kind !== 'subtitle' && !m.playlist && !m.dismissed), subPrefs(t),
    { max: room, may: (sub) => !sub.wordsAsked && autoFetchAllowed(sub.url, sub.pageUrl || t.pageUrl) });
  if (!plan(WORD_CHECKS).length) return null;
  const run = (async () => {
    // (A video whose own caption files all turn out to hold nothing falls back on the page's others: those are read next.)
    for (let room = WORD_CHECKS; room > 0;) {
      const runs = plan(room);
      if (!runs.length) break;
      room -= runs.reduce((n, subs) => n + subs.length, 0);
      await mapLimit(runs, 2, async (subs) => {
        for (const sub of subs) {
          sub.wordsAsked = true;
          let text = null;
          try {
            await applyRefererRules([sub.url], sub.pageUrl || t.pageUrl);
            text = await fetchText(sub.url, { maxBytes: 300_000 });
          } catch (e) {
            // A file that is not there (404, 410) is no caption file. One that cannot be reached from here stays
            // offered, and "Save transcript" says what went wrong.
            if (e?.status !== 404 && e?.status !== 410) return;
          }
          sub.words = text !== null && hasWords(text);
          if (sub.words) return;
          sub.hidden = true;
        }
      });
    }
  })().then(() => persistTab(tabId), () => {});
  wordRuns.set(tabId, run);
  run.finally(() => wordRuns.delete(tabId));
  return run;
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
  // @site-edition
  // @store-edition
  // // A piece of a player that fetches its video in parts is never listed, however it was found (the page's
  // // links, a site rule, your AI): see handleResponse.
  // if (playerPiece(item.url)) return null;
  // @end-site-edition
  const t = await getTab(tabId);
  if (!t.pageUrl) await refreshTabInfo(tabId, t);
  item = { ...item, poster: safePoster(item.poster, t.pageUrl) };
  if (item.poster) { await guardReady; await allowLocal([item.poster], t.pageUrl).catch(() => {}); }
  // A file on a page with a stream may be one of the stream's own: its playlists are read before it is listed.
  // (A caption file is not counted on the toolbar: whether it is one of the stream's own is found out when
  // StreamSnag is opened on the tab, askHeld, and no sooner. A video file is counted, so that is settled now.)
  if (item.kind === 'direct' || (item.kind === 'subtitle' && t.opened)) await Promise.resolve(readOtherPlaylists(tabId, t)).catch(() => {});
  const key = dedupeKey(item.url);
  // Looked like a stream and answered with something else (notStream): not looked at again, unless the
  // same address is now answered as a stream (a player's question first, the stream itself after).
  const asStream = STREAM_TYPE.test(item.contentType || '');
  if (t.skip?.[key]) {
    if (!asStream) return null;
    delete t.skip[key];
  }
  // A thumbnail index for a player's seek bar is not captions: by its name, or (a file the page has loaded) by what it holds.
  if (item.kind === 'subtitle' && !isStreamPart(t, key)
    && (isImageTrack(item.url) || (item.source === 'network' && await pictureTrack(tabId, t, item.url)))) return null;
  const canon = canonicalKey(t, key);
  // A video of the page left behind (the address changed without a load) that is seen again is that very
  // item, under the name it had: never a new one that the new page would name.
  const back = t.left?.length ? comeBack(t.left, key, { frameId: item.reportedBy ?? item.frameId ?? 0 }) : null;
  if (back) {
    t.media.push(back);
    if (item.source === 'network') reportSoon(tabId); // its frame says whether a player still has it
  }
  let m = t.media.find((x) => keysOf(x).some((k) => k === key || canonicalKey(t, k) === canon));
  if (m) {
    if (!keysOf(m).includes(key)) {
      noteMerge(t, m, { key, url: item.url, title: '' }, 'redirect (on arrival)');
      // Matched through a redirect: count it as one more link for the same video.
      m.aliases = [...(m.aliases || []), key].slice(-30);
      m.seen = (m.seen || 1) + 1;
    }
    // (One address may answer a player's question with data and give the stream too: of a stream, the
    // address that was answered as a stream is kept, and read again if the data came first.)
    const stream = m.kind === 'hls' || m.kind === 'dash';
    const wasStream = STREAM_TYPE.test(m.contentType || '');
    if (item.source === 'network' && m.url !== item.url && !m.dismissed && !(stream && wasStream && item.contentType && !asStream)) {
      m.aliases = [...new Set(keysOf(m))].filter((k) => k !== key);
      m.url = item.url; // fresher signed URL for the same file
      m.key = key;
    }
    if (item.source === 'network' && stream && asStream && !wasStream && m.contentType) {
      m.contentType = item.contentType;
      delete m.unasked;
      probeStream(tabId, m);
    } else if (item.source === 'network' && m.unasked) {
      // It waited to be asked about (the page had not loaded it): now the page has, so it may be read.
      delete m.unasked;
      if (stream) probeStream(tabId, m);
    }
    if (item.size && !m.size) m.size = item.size;
    if (item.poster && !m.poster) m.poster = item.poster;
    if (item.duration && !m.info?.duration) m.info = { ...(m.info || {}), duration: item.duration };
    if (item.source === 'ai' && m.source !== 'ai') m.alsoAi = true;
    // What the page says of it now: which video's file it is, its picture height, the language of a caption file.
    if (item.group) m.set = item.group;
    if (item.height && !m.height) m.height = item.height;
    if (item.quality && !m.quality) m.quality = item.quality;
    if (item.lang && !m.lang) m.lang = item.lang;
    // A file the page only linked to or listed, now loaded by a player (or seen on the network), is no longer
    // "just a link" or "only listed". And a link to a file that is an entry of the page's playlist is that entry.
    if (item.listed) {
      if (m.linked) {
        delete m.linked;
        m.listed = true;
      }
    } else if (!item.linked) {
      delete m.linked;
      delete m.listed;
    }
    m.label = describe(m);
    persistTab(tabId);
    // The page may not have been ready to say what the video is called the first time.
    if (!m.title && !m.carried && m.kind !== 'subtitle' && (m.nameTries = (m.nameTries || 0) + 1) <= 3) nameSoon(tabId, m.id);
    return m;
  }
  // A stream's own file (a segment, an init file, a whole-track file): never an item of its own. (A
  // stream's playlists still are, hidden: reading them tells which files are theirs.)
  const part = isStreamPart(t, key);
  if (part && item.kind !== 'hls' && item.kind !== 'dash') return null;
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
    hidden: part,
    info: item.duration ? { duration: item.duration } : null,
  };
  if (item.group) m.set = item.group; // the video this file (or caption file) belongs to, as the page has it
  if (item.height) m.height = item.height;
  if (item.quality) m.quality = item.quality;
  if (item.linked) m.linked = true; // only linked to for download, not loaded by a player
  if (item.listed) m.listed = true; // an entry of a playlist written into the page, not (yet) loaded by its player
  m.label = describe(m);
  t.media.push(m);
  if (t.media.length > 400) t.media.splice(0, t.media.length - 400); // (a page may link to 150 files in each of its frames)
  persistTab(tabId);
  if (m.kind !== 'subtitle' && !m.hidden) nameSoon(tabId, m.id);
  // (Seen from inside a frame while a player waits to be looked up: it may be that player's video, started.)
  if (m.frameId > 0 && m.source === 'network' && m.kind !== 'subtitle' && !m.hidden && t.media.some((x) => x.kind === 'embed')) playedPlaceholder(tabId, t, m).catch(() => {});
  // A file or a stream the page's markup names and the page has not loaded (a <source> it never played) is
  // not asked about until StreamSnag is opened on the tab (askHeld): a page that is merely open causes no
  // request it did not make itself.
  const mayAsk = m.source !== 'page' || t.opened || loadedByPage(t, m.url);
  if (m.kind === 'hls' || m.kind === 'dash') {
    if (mayAsk) probeStream(tabId, m);
    else m.unasked = true;
  // (A page may link to dozens of files, or list them in a playlist: those are not each asked for their size.)
  } else if (m.kind === 'direct' && !m.size && !['link', 'list'].includes(m.source)) {
    if (mayAsk) probeDirect(tabId, m);
    else {
      m.unasked = true;
      m = mergeDuplicates(t, m);
    }
  } else m = mergeDuplicates(t, m);
  return m;
}

const LINK_CHECKS = 150; // links to media files looked at on one page (as many as one frame may report: lib/linked.js)
const LINK_PATIENCE = 9000; // the longest one look may take, whatever holds it up
const linkChecks = new Map(); // "tabId:key" -> the look in progress

/**
 * Does a link whose address ends like a video or sound file give a file? A page's address can end in
 * ".webm" too (a wiki's page about a file, a viewer page), and that is not a video. The link is asked for
 * its first byte only, once per page: { ok, size } (`size` when the server said), or null when it was not
 * looked at (too many links on the page, or an address on your own network from a public page). A link
 * that could not be reached at all is left listed: it may still work when clicked.
 * Only ever called once StreamSnag has been opened on the tab (checkLinks): a page that is merely open
 * causes no request to a file it has not loaded itself.
 */
async function linkedFile(tabId, t, url) {
  const key = dedupeKey(url);
  if (t.media.some((m) => keysOf(m).includes(key))) return { ok: true, size: null }; // known as a video already (a playlist entry, a played file)
  // Looked at before the page's address changed without a load, and found to be a file: it is not asked again.
  if (t.left?.some((m) => m.linked && keysOf(m).includes(key))) return { ok: true, size: null };
  t.linkOk = t.linkOk || {};
  if (Object.hasOwn(t.linkOk, key)) return t.linkOk[key];
  const id = `${tabId}:${key}`;
  if (linkChecks.has(id)) return linkChecks.get(id);
  if (Object.keys(t.linkOk).length + linkChecks.size >= LINK_CHECKS || !autoFetchAllowed(url, t.pageUrl)) return null;
  const look = (async () => {
    let verdict = { ok: true, size: null };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      await applyRefererRules([url], t.pageUrl);
      const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal: ctrl.signal });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1];
      // A web page, an error page, or a server that says no: not a file to offer.
      verdict = { ok: res.ok && !/^(?:text\/|application\/(?:xhtml|json|xml))/.test(type), size: Number(total) || null };
    } catch { /* not reachable from here: it stays listed */ }
    clearTimeout(timer);
    ctrl.abort(); // only the headers were needed
    t.linkOk[key] = verdict;
    return verdict;
  })();
  linkChecks.set(id, look);
  look.finally(() => linkChecks.delete(id));
  // (A look that never comes back must not keep the page "looking": the link then stays listed, as one that could not be reached.)
  return Promise.race([look, new Promise((resolve) => { setTimeout(() => resolve({ ok: true, size: null }), LINK_PATIENCE); })]);
}

const linkRuns = new Map(); // tabId -> the looking in progress

/**
 * StreamSnag was opened on the tab (its state was asked for): the media files its page only links to,
 * held until now as candidates (t.links, lib/linked.js), are looked at (linkedFile), and the ones that
 * give a file are listed in the page's order, each under the name its link or its row gives it. Returns
 * how many are still being looked at: the list is worth reading again while that is not 0.
 */
function checkLinks(tabId, t) {
  // (A link that is never asked, an address on your own network from a public page, is not waiting for anything.)
  const never = (it) => !autoFetchAllowed(it.url, t.pageUrl);
  const waiting = linksWaiting(t.links, never);
  if (!Object.values(t.links || {}).some((set) => !set.done) || linkRuns.has(tabId)) return waiting;
  const run = (async () => {
    for (const [frameId, set] of Object.entries(t.links || {})) {
      if (set.done) continue;
      try {
        const files = new Map(await mapLimit(set.items, 3, async (it) => [it.url, await linkedFile(tabId, t, it.url).catch(() => null)]));
        if (t.links?.[frameId] !== set) continue; // the page has other links by now: those are looked at next time
        const ok = set.items.filter((it) => files.get(it.url)?.ok && classifyUrl(it.url));
        const several = ok.length > 1;
        // (Past the page's limit of looks: not looked at, and counted so the popup can say so.)
        set.skipped = set.items.filter((it) => files.get(it.url) === null && !never(it)).length;
        // A file the page links to is called what its link calls it, else what its row does; one of several
        // that say nothing ("download") by its own file name. A lone "Download video" is the page's lecture.
        const names = new Map(ok.map((it) => [it.url, linkName(it, { several })]));
        // A file known only by its own name that holds the name the page gives its talk ("37c3-12142-eng-Breaking DRM
        // in Polish trains" on the talk's page) is that talk: called by it, with the language its name says.
        if ([...names.values()].some((n) => n.source === 'file')) {
          const said = await readPageName(tabId, t);
          for (const [url, n] of names) {
            const talk = n.source === 'file' && said?.name && !said.siteOnly ? talkName(n.title, said.name) : '';
            if (talk) names.set(url, { title: talk, source: 'link' });
          }
        }
        // One recording linked in several formats ("talk.av1.webm" and "talk.mp4") is one video with choices.
        const twins = formatTwins(ok.map((it) => ({ url: it.url, mediaType: classifyUrl(it.url).mediaType, title: names.get(it.url).source === 'link' ? names.get(it.url).title : '' })));
        const groups = new Map();
        for (const it of ok) {
          const info = classifyUrl(it.url);
          const m = await addMedia(tabId, { ...info, size: files.get(it.url).size || info.size, url: it.url, source: 'link', frameUrl: set.frameUrl || '', linked: true, reportedBy: Number(frameId) }).catch(() => null);
          if (m?.linked && !m.title && !m.customName) {
            const named = names.get(it.url);
            if (named.title) Object.assign(m, { title: named.title, nameSource: named.source });
            // A link that names a lecture of the page's playlist is that lecture in another file: one more choice of it.
            const lecture = m.set ? '' : sameLecture(t.media, m);
            if (lecture) m.set = lecture;
          }
          // (The page's one linked file is the page's lecture: it has the page's name for it before the look is
          // called done, so it is never listed for a moment as a video without a name.)
          if (!several && m?.linked && !m.title && !m.customName) await nameFromPage(tabId, m.id).catch(() => {});
          const twin = m ? twins.get(it.url) : '';
          if (twin) groups.set(twin, [...(groups.get(twin) || []), m]);
        }
        for (const [twin, members] of groups) {
          // (Of the video a member already belongs to, a player's or a playlist's, the others are files too.)
          const of = members.map((m) => m.set).find(Boolean) || twin;
          // The recording is called what the link that names it says; where only the files' own names are there,
          // the plainest of them ("lecture0", not "lecture0-4k").
          const told = members.find((m) => m.nameSource === 'link' && m.title);
          const plain = told ? '' : members.filter((m) => m.nameSource === 'file' && m.title).map((m) => m.title).sort((a, b) => a.length - b.length)[0] || '';
          for (const m of members) {
            if (!m.set) m.set = of;
            if (m.customName || !['file', ''].includes(m.nameSource || '')) continue;
            if (told) Object.assign(m, { title: told.title, nameSource: 'link' });
            else if (plain && m.title) m.title = plain;
          }
        }
      } catch { /* a link that cannot be read stops nothing */ } finally {
        if (t.links?.[frameId] === set) set.done = true; // looked at, however it went: it never stays "being looked at"
      }
    }
    persistTab(tabId);
  })().catch(() => {});
  linkRuns.set(tabId, run);
  run.finally(() => linkRuns.delete(tabId));
  return waiting;
}

const LIST_ENTRIES = 60; // lectures taken from a page's playlists (each may come in several files)

/**
 * The lectures of a playlist written into the page (lib/variants.js: pagePlaylists): each one is listed
 * under its own name, its files as one video with choices, its caption files as its own. Nothing is
 * fetched: a page may list a whole course.
 */
async function addPlaylists(tabId, t, texts, base) {
  for (const entry of pagePlaylists(texts, base).slice(0, LIST_ENTRIES)) {
    const group = `list:${dedupeKey(entry.sources[0].url)}`;
    for (const s of entry.sources) {
      const info = classifyUrl(s.url) || { kind: 'direct', mediaType: 'video', ext: mediaExtFromUrl(s.url), size: null, contentType: '' };
      if (info.kind === 'subtitle') continue;
      // (`listed`: named by the page, not loaded by a player. The lecture a player has loaded loses the mark, and has the big card.)
      const m = await addMedia(tabId, { ...info, url: s.url, source: 'list', group, height: s.height, quality: s.label, duration: entry.duration, poster: entry.poster, listed: info.kind === 'direct' }).catch(() => null);
      // The playlist's own name for it beats what the page as a whole is called (never your own rename).
      // (Its course was worked out around the name it had: it is read again around this one.)
      if (m && !m.customName && m.nameSource !== 'playlist') {
        const had = !!m.title;
        Object.assign(m, { title: entry.title, nameSource: 'playlist', ...(had ? { course: '' } : {}) });
        if (had) setTimeout(() => nameFromPage(tabId, m.id).catch(() => {}), 0);
      }
    }
    for (const c of entry.tracks) {
      await addMedia(tabId, { kind: 'subtitle', mediaType: 'subtitle', ext: extFromUrl(c.url) === 'srt' ? 'srt' : 'vtt', size: null, contentType: '', url: c.url, source: 'list', group, lang: c.lang, label: c.label }).catch(() => null);
    }
  }
}

const naming = new Map(); // tabId -> how many listed items are still to be named from the page (and given their course)

/**
 * Name an item from the page a moment after it is listed (the page may not be ready to say sooner). While
 * that is on its way the tab counts as "still being named": the popup holds the course's name and its
 * counts until every item has been asked about, so neither is shown and then changed a second later.
 */
function nameSoon(tabId, mediaId) {
  naming.set(tabId, (naming.get(tabId) || 0) + 1);
  const done = () => naming.set(tabId, Math.max(0, (naming.get(tabId) || 1) - 1));
  setTimeout(() => nameFromPage(tabId, mediaId).catch(() => {}).finally(done), 400);
}

const pageNames = new Map(); // tabId -> { url, at, said }: what the page said last, for the files it only links to or lists

/**
 * What the page says of itself, for a file it only links to or lists: no player has such a file, so the
 * answer is the same for every one of them, and a page of a hundred lectures is asked once, not a hundred times.
 */
function readPageName(tabId, t) {
  const kept = pageNames.get(tabId);
  if (kept && kept.url === t.pageUrl && Date.now() - kept.at < 4000) return kept.said;
  const said = readVideoName(tabId, 0, '');
  pageNames.set(tabId, { url: t.pageUrl, at: Date.now(), said });
  if (pageNames.size > 40) pageNames.delete(pageNames.keys().next().value);
  return said;
}

/** Ask the page what the video playing right now is called (lecture/episode name, not the site title). */
async function readVideoName(tabId, frameId = 0, url = '', rule = '') {
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'videoName', frame: frameId > 0, url }, { frameId }),
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);
    if (!res || res.error) return null;
    // (A page whose video comes from a stream alone reports nothing else: its language is learned here.)
    if (!frameId && typeof res.lang === 'string' && res.lang && tabs.get(tabId)) tabs.get(tabId).pageLang = res.lang.slice(0, 20);
    // The page says what it has (a player's label, a highlighted lesson, headings, its title); which of
    // them names the video is decided here (lib/naming.js). null: the page has no name to give.
    // (`rule`: what a rule for this site says this video is called: the strongest of the names, see chooseName.)
    return res.signals ? chooseName(rule ? { ...res, rule } : res) : res.name ? res : null;
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
  // (A video kept from the page left behind has the name it had there: this page's name is not its.)
  if (!m || m.carried || (m.title && m.course)) return;
  // A file opened in a tab of its own: the "page" is the file, and its name is the file's name.
  const alone = m.kind === 'direct' && !!t.pageUrl && dedupeKey(t.pageUrl) === m.key;
  // A stream requested from inside a player iframe (e.g. one video of a Vimeo showcase): that player
  // knows which clip it is playing; the page around it only knows the page.
  let fromFrame = m.frameId > 0 ? await readVideoName(tabId, m.frameId, m.url) : null;
  // (A player in a frame that knows nothing but the name of the site it comes from: the page around it says what the video is.)
  if (fromFrame?.siteOnly) fromFrame = null;
  // A rule for this site may say what its lecture is called: that names the page's one video (lib/rescue.js).
  const ruled = t.rule && samePageUrl(t.rule.url, t.pageUrl) && titledByRule(t.media) === m ? ruleName(t.rule.title) : '';
  // (A file the page only links to or lists, under a name of its own: the page is asked once for all of them.)
  const shared = !ruled && !!m.title && (m.linked || m.listed) && !(m.frameId > 0);
  const top = alone ? null : shared ? await readPageName(tabId, t) : await readVideoName(tabId, 0, m.url, ruled);
  // The page's address changed while it was asked, and this video was the previous page's: what the page says now is not about it.
  if (!t.media.includes(m) || m.carried) return;
  // The player is already showing another video (its length is not this stream's): its title isn't ours.
  const playerElsewhere = fromFrame && playerLength(m, fromFrame) === 'other';
  if (playerElsewhere) fromFrame = null;
  // A player that only has the uploader's file name for its video ("Deconstruct_DanAbramov_V3"), or its own
  // product name ("EPlayer"), gives way to what the page around it calls the lecture.
  if (fromFrame && pageNameWins(fromFrame, top)) fromFrame = null;
  const info = top?.source === 'rule' ? top : fromFrame || top;
  if (!info) {
    // The page has no name to give (or is the file itself): a file is then called by its own name,
    // never by a bare address.
    const own = !m.title && m.kind === 'direct' ? fileTitle(m.url) : '';
    if (own) {
      Object.assign(m, { title: own, nameSource: 'file' });
      persistTab(tabId);
    }
    return;
  }
  if (!m.title) {
    m.title = info.name;
    m.nameSource = info === fromFrame ? 'player' : info.source;
    // Players update their title a few seconds after the next video starts (a Vimeo showcase keeps showing
    // the previous lecture's title card), so look again once the player has caught up.
    if (m.frameId > 0 && m.nameSource !== 'rule') {
      m.playerName = true;
      for (const ms of [2500, 6000, 12000, 25000]) setTimeout(() => recheckName(tabId, m.id).catch(() => {}), ms);
    }
  }
  // For an embedded video with its own title, the lecture name on the page is the better "course".
  const ownTitle = ['embed', 'playlist', 'link', 'rule'].includes(m.nameSource) || (!!fromFrame && info === fromFrame);
  if (!m.course && top) {
    // The page's main heading is the best "course" for a video that brings its own title.
    // (For a file the page only links to or lists: the page's own heading, else what its title calls the page,
    // before whatever else the page offered as a name: a highlighted entry of its menu is no course.)
    const pick = [top.heading, shared ? top.page : '', top.name].find((x) => x && x !== m.title);
    m.course = (ownTitle && pick ? pick : top.course) || '';
  }
  applyRuleTitle(tabId, t); // (a video that already had a name by the time the rule spoke)
  persistTab(tabId);
}

/**
 * Re-read a player's title shortly after its stream started. Only while this is still the newest stream
 * from that player: once the next video loads, the player's title belongs to that one.
 */
async function recheckName(tabId, mediaId) {
  const t = await getTab(tabId);
  const m = t.media.find((x) => x.id === mediaId);
  if (!m || m.customName || !m.playerName || !(m.frameId > 0) || m.nameSource === 'rule') return;
  const newer = t.media.some((x) => x !== m && x.frameId === m.frameId && x.kind === m.kind && !x.hidden && x.detectedAt > m.detectedAt);
  if (newer) return;
  const info = await readVideoName(tabId, m.frameId, m.url);
  // (A player that only knows the name of the site it comes from has no name for the video: see nameFromPage.
  // Nor has one that only knows a file's name or its own product's, where the page gave a name.)
  if (!info?.name || info.siteOnly || info.name === m.title) return;
  if (m.title && pageNameWins(info, { name: m.title })) return;
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

/** The first `max` bytes of an answer as text; the rest is never downloaded. */
async function readHead(res, max = 4096) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let got = 0;
  try {
    while (got < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder('utf-8').decode(all.subarray(0, max));
}

/**
 * Is an address that a rule or an AI answer gave really a video, a sound file, a stream or a caption file?
 * It is asked for its first bytes, once: { ok, info }. `ok`: 'yes' (it answered as one), 'no' (it answered
 * with something else: a web page, an error, a thumbnail index, or it may not be asked for from this page),
 * 'unknown' (it could not be reached from here). `info`: what it is, as addMedia takes it.
 * `captions`: the address is meant to be a caption file, so it is judged by what it holds, not by its type.
 * Never asks an address on your own network from a public page.
 */
async function verifyFound(url, pageUrl, { captions = false } = {}) {
  if (!isHttpUrl(url) || !autoFetchAllowed(url, pageUrl)) return { ok: 'no', info: null };
  const byUrl = classifyUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    await applyRefererRules([url], pageUrl);
    const wantsText = captions || byUrl?.kind === 'subtitle';
    const res = await fetch(url, { headers: { Range: `bytes=0-${wantsText ? 65535 : 4095}` }, credentials: 'include', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return { ok: 'no', info: null };
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const head = await readHead(res, wantsText ? 65536 : 4096);
    const stream = manifestKind(head);
    if (stream && !captions) return { ok: 'yes', info: { kind: stream, mediaType: 'stream', ext: stream === 'hls' ? 'm3u8' : 'mpd', size: null, contentType: type } };
    if (wantsText) {
      // (A whole cue at the end: what was cut off in the middle is left out.)
      const whole = head.length >= 65536 ? head.slice(0, head.lastIndexOf('\n\n') + 1 || head.length) : head;
      if (!looksLikeCaptions(whole)) return { ok: 'no', info: null };
      return { ok: 'yes', info: { kind: 'subtitle', mediaType: 'subtitle', ext: /^\uFEFF?\s*WEBVTT/.test(whole) ? 'vtt' : 'srt', size: null, contentType: type } };
    }
    // An address that ends like a stream's and answers with something else; a web page; data.
    if (byUrl?.kind === 'hls' || byUrl?.kind === 'dash') return { ok: 'no', info: null };
    if (/^(?:text\/|application\/(?:xhtml|json|xml|javascript))/.test(type)) return { ok: 'no', info: null };
    const info = classifyResponse({ url, contentType: type, contentRange: res.headers.get('content-range'), contentLength: res.headers.get('content-length'), status: 200 }, { minSizeBytes: 0 });
    return info && info.kind === 'direct' ? { ok: 'yes', info } : { ok: 'no', info: null };
  } catch {
    // Not reachable from here (a server that only answers the page itself): what its address says it is.
    return { ok: 'unknown', info: captions ? null : byUrl };
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // only the first bytes were needed
  }
}

/** Work out what an unknown URL is (the context menu's "Download this media"). */
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
  // A piece of a player that fetches its video in parts (the picture or the sound): never listed as a file
  // of its own (lib/detect.js).
  if (playerPiece(r.url)) {
    // @site-edition
    // On a YouTube watch page the video is listed once, as the page's (see youTubeWatch).
    if (!details.frameId) await youTubeWatch(tabId, t).catch(() => {});
    // @store-edition
    // // Nothing on this page can be saved from such a player: the popup then says what it says of any
    // // page with no video (state.page.inPieces), not that something is playing that it did not find.
    // t.inPieces = true;
    // @end-site-edition
    persistTab(tabId);
    return;
  }
  const settings = await cachedSettings();
  const info = classifyResponse(r, { minSizeBytes: settings.minSizeKB * 1024 });
  if (!info) {
    persistTab(tabId);
    return;
  }
  await addMedia(tabId, { url: r.url, ...info, source: 'network', frameId: details.frameId || 0, frameUrl: details.frameId ? details.initiator || '' : '' });
}

// @site-edition
/**
 * A YouTube watch page whose player is playing: its video, listed once, as the page's own (an item for
 * yt-dlp, named after the page), whatever pieces the player fetches. When YouTube moves on to the next video
 * without loading a page, the item of the one before leaves (see the address change below): it is never
 * kept under the new video's name.
 */
async function youTubeWatch(tabId, t) {
  const v = youTubeWatchId(t.pageUrl);
  if (!v || t.media.some((m) => m.ytWatch === v)) return;
  const url = `https://www.youtube.com/watch?v=${v}`;
  const m = await addMedia(tabId, { url, kind: 'embed', mediaType: 'video', ext: '', size: null, contentType: '', source: 'page' });
  if (!m) return;
  m.ytWatch = v;
  m.provider = 'youtube';
  m.embedId = v;
  m.embedUrl = url;
  if (!m.title && !m.customName && youTubeTitle(t.pageTitle)) Object.assign(m, { title: youTubeTitle(t.pageTitle), nameSource: 'title' });
  m.label = describe(m);
  persistTab(tabId);
  updateBadge(tabId);
}
// @end-site-edition

/** Every frame's id in a tab (webNavigation is optional; fall back to the top frame). */
/**
 * Which listed video is playing in the tab right now? Every frame is asked about its player; a frame
 * that doesn't answer quickly (or has no StreamSnag script, like a browser page) is simply left out.
 */
async function playingIn(tabId, media) {
  return pickPlaying(media, await playersIn(tabId));
}

/** What each frame's player is doing right now: [{ frameId, src, page, playing, duration, at }]. */
async function playersIn(tabId) {
  const ask = (frameId) => Promise.race([
    chrome.tabs.sendMessage(tabId, { type: 'playing' }, { frameId }).then((r) => (r ? { ...r, frameId } : null)).catch(() => null),
    new Promise((resolve) => { setTimeout(() => resolve(null), 400); }),
  ]);
  return (await Promise.all((await frameIdsOf(tabId)).map(ask))).filter(Boolean);
}

/**
 * What the page's own script says when the tab's address has changed: { moved, at }, or null when it does
 * not answer at once. `moved`: it has seen the page under another address, so the page was not loaded
 * anew (a single-page app went on to its next page); `at`: when the page was last clicked.
 */
async function pageScript(tabId) {
  const said = await Promise.race([
    chrome.tabs.sendMessage(tabId, { type: 'clickedAt' }, { frameId: 0 }).catch(() => null),
    new Promise((resolve) => { setTimeout(() => resolve(null), 300); }),
  ]);
  return said ? { moved: said.moved === true, at: Number(said.at) || 0 } : null;
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

const reportTimers = new Map(); // tabId -> a report asked for, about to be sent for

/** Have a tab's frames report again in a moment (once, however often that is asked meanwhile). */
function reportSoon(tabId, ms = 1200) {
  if (reportTimers.has(tabId)) return;
  reportTimers.set(tabId, setTimeout(() => {
    reportTimers.delete(tabId);
    askFramesToReport(tabId).catch(() => {});
  }, ms));
}

/**
 * A moment after a page's address changed without a load: a player that still has what it had before
 * (the same source, playing or paused) has a stream of the page left behind, and that stream is listed
 * again, as itself and under its own name. It goes when no player has that source any more (leftBehind).
 * (A file a player still has comes back by the page's own report; a stream plays from a source of the
 * player's making, which says nothing.)
 */
async function stillPlaying(tabId, changedAt, before) {
  const t = await getTab(tabId);
  if (t.changedAt !== changedAt || !t.left?.length) return;
  for (const r of await playersIn(tabId)) {
    if (!r.src || !before.some((b) => b.frameId === r.frameId && b.src === r.src)) continue;
    const streams = t.left.filter((m) => m.kind === 'hls' || m.kind === 'dash');
    const hit = pickPlaying(streams, [r]);
    const m = hit ? comeBack(t.left, streams.find((x) => x.id === hit.id).key, { frameId: r.frameId, src: /^blob:/i.test(r.src) ? r.src : '' }) : null;
    if (!m) continue;
    t.media.push(m);
    probeStream(tabId, m); // (what it is made of was forgotten with its page)
  }
  persistTab(tabId);
}

// The browser itself says when a tab's address changed without a load (a page's script moved it on: a
// single-page app going to its next lecture). The page's own script says so too (pageScript), but only when
// it answers at once, and a busy page or a busy computer does not.
const movedOn = new Map(); // tabId -> { url, at }: the last such change
chrome.webNavigation?.onHistoryStateUpdated?.addListener((d) => {
  if (d.frameId !== 0) return;
  movedOn.set(d.tabId, { url: String(d.url || '').split('#')[0], at: Date.now() });
  if (movedOn.size > 60) movedOn.delete(movedOn.keys().next().value);
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.url) {
    const t = await getTab(tabId);
    const prevUrl = t.pageUrl;
    t.pageUrl = isHttpUrl(change.url) ? change.url : '';
    if (prevUrl && prevUrl.split('#')[0] !== change.url.split('#')[0]) {
      // Without a load (a single-page app went on to its next page) the page's own script is still
      // there: it has seen the page under its old address, and says when the page was last clicked
      // and what its players have. (The browser reports both kinds of change alike.)
      const at = Date.now();
      const wasTitle = t.pageTitle;
      const [script, before] = await Promise.all([pageScript(tabId), playersIn(tabId)]);
      // (Without a load: the page's script says so, or the browser has said so of this very address just now.)
      const hist = movedOn.get(tabId);
      const inPage = !!script?.moved || (!!hist && hist.url === change.url.split('#')[0] && Math.abs(Date.now() - hist.at) < 5000);
      // New page: the old media leave, except what was found since the click that changed the address,
      // or in the last few seconds without one (an app often starts loading the next video just before
      // it changes the address). See lib/pagechange.js.
      const split = splitAtChange(t.media, graceStart(at, inPage ? script?.at || 0 : 0));
      // @site-edition
      // A YouTube watch page's video is the page's own: on to the next video, the one before leaves for
      // good, even when its player fetched a last piece just now (it never takes the new video's name).
      const nowV = youTubeWatchId(change.url);
      const stay = split.stay.filter((m) => !m.ytWatch || m.ytWatch === nowV);
      const left = split.left.filter((m) => !m.ytWatch);
      // @store-edition
      // const { stay, left } = split;
      // @end-site-edition
      t.media = stay;
      // What left is remembered while the document is the same: a video that is seen again (its player
      // stays across pages) comes back as itself, under the name it had (addMedia, stillPlaying), and
      // never takes the new page's name.
      for (const m of left) if (!m.title && !m.customName) m.pageTitle = wasTitle;
      t.left = inPage ? left.filter((m) => !m.dismissed).slice(-60) : [];
      t.changedAt = at;
      t.log = t.log.slice(-40);
      t.childKeys = new Set();
      t.childPatterns = [];
      t.childFolders = [];
      t.pageLang = '';
      t.linkOk = {};
      t.links = {}; // the frames report their links again, like their documents
      t.skip = {};
      t.tracks = {};
      t.redirects = {};
      t.embeds = {};
      t.embedHeld = {};
      t.lectures = 0;
      t.inPieces = false;
      t.foldOpen = false; // "Show" (what the list folds away) was for the page left behind
      t.opened = false; // StreamSnag has not been opened on this page yet (an open popup asks again in a moment)
      t.docs = {}; // the frames report their documents again (askFramesToReport below)
      t.aiResult = null;
      t.rule = null; // what a rule said of the page left behind (its title, addresses not looked at yet)
      t.ruleHeld = [];
      persistTab(tabId);
      // Tabs and SPA routes change the URL without touching the DOM: without this the items that are
      // still on the page never come back, and the last tab's player is the one that goes missing.
      askFramesToReport(tabId);
      if (inPage && before.length) setTimeout(() => stillPlaying(tabId, at, before).catch(() => {}), 2500);
    }
  }
  if (change.title) {
    const t = await getTab(tabId);
    t.pageTitle = change.title;
    // @site-edition
    // A YouTube watch page names its video once its title has caught up with the address.
    const yt = t.media.find((m) => m.ytWatch && m.ytWatch === youTubeWatchId(t.pageUrl) && !m.customName && (m.nameSource === 'title' || !m.title));
    if (yt && youTubeTitle(change.title)) Object.assign(yt, { title: youTubeTitle(change.title), nameSource: 'title' });
    // @end-site-edition
    persistTab(tabId);
  }
  if (change.status === 'complete' && isHttpUrl(tab.url)) {
    scanLibrary({ force: true }).catch(() => {}); // a (re)loaded page re-checks the folder
    const settings = await getSettings();
    // A rule for this site (your own, or a built-in one) runs by itself once the page has loaded, unless that
    // is switched off in Settings. What it may ask for on a page that is merely open: see useRuleResult.
    if (settings.autoRecipes) setTimeout(() => runSavedRecipe(tabId, { quiet: true, auto: true }).catch(() => {}), 1500);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  tabLoads.delete(tabId);
  movedOn.delete(tabId);
  asking.delete(tabId);
  pageNames.delete(tabId);
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
});

// ---------------------------------------------------------------- recipes

async function getRecipes() {
  const { recipes } = await chrome.storage.local.get('recipes');
  return recipes || {};
}

/** The rule for a page: your own for its site wins; else one that ships with StreamSnag (marked `builtin`). */
async function recipeForUrl(url) {
  return recipeFor(await getRecipes(), url, BUILTIN_RECIPES);
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

const FOUND_MAX = 30; // addresses of one rule run (or one AI answer) that are looked at

/**
 * Is an address the same file as one that is listed, apart from what follows its "?" (a player's own
 * request for a stream carries a session number that the page's markup does not)? Only for an address
 * that ends like a media file, a stream or a caption file: there the path names the file.
 */
function listedTwin(t, url) {
  const bare = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return ''; } };
  const key = dedupeKey(url);
  const mine = classifyUrl(bare(url)) ? bare(url) : '';
  // (The very address that is listed, or one it was seen under, is that item too: it is not asked for a second time.)
  return t.media.find((m) => !m.dismissed && (keysOf(m).includes(key) || (!!mine && bare(m.url) === mine))) || null;
}

/**
 * List what a rule or an AI answer found. Every address is checked first (verifyFound): one that answers
 * with a web page or an error is not listed, and (`strict`, for what an AI named itself) neither is one
 * that could not be reached. `finds`: [{ url, captions? }] (`captions`: meant to be a caption file).
 * Returns { added: ids listed, real: ids of the videos among them that answered as real ones, captions: n,
 * realUrls, captionUrls: the addresses that answered as real videos and as caption files; realIds: the
 * item each of realUrls is listed as }.
 */
async function addFoundUrls(tabId, finds, source, { strict = false } = {}) {
  const t = await getTab(tabId);
  const pageUrl = t.pageUrl;
  const out = { added: [], real: [], captions: 0, realUrls: [], realIds: [], captionUrls: [] };
  const seen = new Set();
  const list = finds.map((f) => (typeof f === 'string' ? { url: f } : f)).filter((f) => f?.url && !seen.has(f.url) && seen.add(f.url)).slice(0, FOUND_MAX);
  // (What is listed already under the same file's address is that item: it is not asked for again, nor listed twice.)
  const checked = await mapLimit(list, 3, async (f) => [f, listedTwin(t, f.url) ? { twin: true } : await verifyFound(f.url, pageUrl, { captions: !!f.captions }).catch(() => ({ ok: 'unknown', info: null }))]);
  for (const [f, v] of checked) {
    if (t.pageUrl !== pageUrl) break; // the tab has gone on to another page: this is not that page's
    const twin = v.twin ? listedTwin(t, f.url) : null;
    if (twin?.hidden) continue; // (a piece of a stream that is listed as the stream: nothing of its own to count)
    if (twin) {
      if (source === 'recipe' && twin.source !== 'recipe') twin.byRule = true;
      if (source === 'ai' && twin.source !== 'ai') twin.alsoAi = true;
      if (!out.added.includes(twin.id)) out.added.push(twin.id);
      if (twin.kind === 'subtitle') out.captionUrls.push(f.url);
      else {
        if (!out.real.includes(twin.id)) out.real.push(twin.id);
        out.realUrls.push(f.url);
        out.realIds.push(twin.id);
      }
      continue;
    }
    if (v.twin) continue; // (it was listed a moment ago and is gone: left to the next look)
    if (v.ok === 'no' || !v.info || (strict && v.ok !== 'yes')) continue;
    const m = await addMedia(tabId, { url: f.url, ...v.info, source, ...(v.info.kind === 'subtitle' ? { lang: langOfFile(f.url) } : {}) }).catch(() => null);
    if (!m) continue;
    if (source === 'recipe' && m.source !== 'recipe') m.byRule = true; // found the ordinary way too: the rule's title still names it
    out.added.push(m.id);
    if (m.kind === 'subtitle') {
      out.captions += 1;
      out.captionUrls.push(f.url);
    } else if (v.ok === 'yes') {
      out.real.push(m.id);
      out.realUrls.push(f.url);
      out.realIds.push(m.id);
    }
  }
  return out;
}

/** A server this page already has to do with: one of its own site, or one it has asked for something. */
function contactedBy(t, url) {
  const host = hostOf(url).toLowerCase();
  if (!host) return false;
  if (registrableDomain(siteKey(host)) === registrableDomain(siteKey(hostOf(t.pageUrl)))) return true;
  return t.log.some((l) => hostOf(l.url).toLowerCase() === host);
}

/** What a rule's "fetch" asks the page's own site with (lib/recipes.js allows no other site): never an address on your own network from a public page. */
const ruleFetch = (pageUrl) => (u) => {
  if (!autoFetchAllowed(u, pageUrl)) throw new Error('not asked: that address is on your own network');
  return fetchText(u, { maxBytes: 2_000_000 });
};

/** The same page? By address, ignoring the part after "#". */
const samePageUrl = (a, b) => !!a && String(a).split('#')[0] === String(b || '').split('#')[0];

/**
 * What a rule's title names on this tab (lib/rescue.js: titledByRule): that video takes the name, unless
 * you renamed it yourself. True when a name was changed.
 */
function applyRuleTitle(tabId, t) {
  const name = t.rule && samePageUrl(t.rule.url, t.pageUrl) ? ruleName(t.rule.title) : '';
  if (!name) return false;
  const m = titledByRule(t.media);
  if (!m || m.customName || (m.nameSource === 'rule' && m.title === name)) return false;
  // (Its course was worked out around the name it had: it is read again around this one.)
  Object.assign(m, { title: name, nameSource: 'rule', course: '' });
  m.label = describe(m);
  setTimeout(() => nameFromPage(tabId, m.id).catch(() => {}), 0);
  return true;
}

/**
 * Use what a rule found on a page: its title, its videos and its caption files.
 * `auto`: the rule ran by itself because the page was opened. Then only addresses on the page's own site,
 * or on a server the page has already asked for something, are looked at now; the rest wait (t.ruleHeld)
 * until StreamSnag is opened on the tab or "Scan again" is pressed (checkHeld): a page that is merely open
 * causes no request to a server it has not contacted itself.
 */
async function useRuleResult(tabId, t, result, { auto = false, pageUrl = t.pageUrl } = {}) {
  if (t.pageUrl !== pageUrl) return { added: [], real: [], captions: 0, realUrls: [], realIds: [], captionUrls: [], held: 0 };
  t.rule = { url: pageUrl, title: result.title || '' };
  const finds = [...result.urls.map((url) => ({ url })), ...(result.captions || []).map((url) => ({ url, captions: true }))];
  const now = auto ? finds.filter((f) => contactedBy(t, f.url)) : finds;
  t.ruleHeld = auto ? finds.filter((f) => !contactedBy(t, f.url)).slice(0, FOUND_MAX) : [];
  const got = await addFoundUrls(tabId, now, 'recipe');
  applyRuleTitle(tabId, t);
  persistTab(tabId);
  return { ...got, held: t.ruleHeld.length };
}

const heldRuns = new Map(); // tabId -> the looking in progress

/**
 * StreamSnag was opened on the tab: what a rule found there on a server the page had not contacted is
 * looked at now (see useRuleResult). Returns how many addresses are still being looked at.
 */
function checkHeld(tabId, t) {
  const held = t.ruleHeld || [];
  if (!held.length || heldRuns.has(tabId)) return held.length;
  const run = (async () => {
    await addFoundUrls(tabId, held, 'recipe');
    if (t.ruleHeld === held) t.ruleHeld = [];
    applyRuleTitle(tabId, t);
    persistTab(tabId);
  })().catch(() => {});
  heldRuns.set(tabId, run);
  run.finally(() => heldRuns.delete(tabId));
  return held.length;
}

/**
 * Run the rule for this tab's site, if it has one (your own, else a built-in one). `auto`: by itself, as
 * the page was opened (see useRuleResult for what that may ask for). A rule that finds nothing says
 * nothing: the page is left to ordinary detection.
 */
async function runSavedRecipe(tabId, { quiet = false, auto = false } = {}) {
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const recipe = await recipeForUrl(t.pageUrl);
  if (!recipe) {
    if (quiet) return null;
    throw new Error('No saved rule for this site.');
  }
  const pageUrl = t.pageUrl;
  const snap = await pageSnapshot(tabId, selectorsFor(recipe));
  // (A built-in rule never asks the site for anything: it is checked when it is loaded, and again here.)
  const ask = recipe.builtin ? null : ruleFetch(pageUrl);
  const result = await runRecipe(recipe, { ...snap, network: t.log.map((l) => l.url) }, ask);
  const got = await useRuleResult(tabId, t, result, { auto, pageUrl });
  return { ...result, added: got.added.length, held: got.held };
}

// ---------------------------------------------------------------- download options

/** Turn one detected media item into concrete download choices. */
async function inspectMedia(tabId, mediaId) {
  const t = await getTab(tabId);
  const m = t.media.find((x) => x.id === mediaId);
  if (!m) throw new Error('That media item is gone — reload the page.');
  await applyRefererRules([m.url], m.pageUrl || t.pageUrl, true); // you opened this item's qualities
  // One video in several files (lib/variants.js): each file is a choice, the best first.
  if (m.kind === 'direct' && m.variants?.length > 1) return { options: variantOptions(m) };
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
    // (A variant with sound and no picture is an audio choice, not one of the video qualities.)
    const options = pl.variants.map((v, i) => ({ id: `v${i}`, label: variantLabel(v), height: v.height || 0, bandwidth: v.bandwidth || 0, codecs: v.codecs || '', ...(audioOnly(v) ? { audio: true } : {}) }));
    pl.audio.filter((a) => a.url).forEach((a, i) => options.push({ id: `a${i}`, label: `Audio only · ${a.name || a.language || a.groupId}`, audio: true }));
    pl.subtitles.filter((s) => s.url).forEach((s, i) => options.push({ id: `s${i}`, label: `Subtitles · ${s.name || s.language}`, subtitle: true }));
    // (One size and bitrate listed once per sound format or codec reads as the same row several times: it is one choice.)
    return { options: uniqueChoices(options) };
  }
  const mpd = parseMPD(text, m.url);
  if (mpd.protected) return { options: [], protected: true };
  if (mpd.dynamic) return { options: [], live: true, note: LIVE_DASH };
  const options = mpd.video.map((v, i) => ({
    id: `v${i}`,
    label: [v.height ? `${v.height}p` : v.id, formatBitrate(v.bandwidth), mpd.audio.length ? '+ audio' : ''].filter(Boolean).join(' · '),
    height: v.height || 0,
    bandwidth: v.bandwidth || 0,
  }));
  mpd.audio.forEach((a, i) => options.push({ id: `a${i}`, label: `Audio only · ${[a.lang, formatBitrate(a.bandwidth)].filter(Boolean).join(' · ')}`, audio: true }));
  mpd.subtitles.forEach((s, i) => options.push({ id: `s${i}`, label: `Subtitles · ${s.lang || s.label || s.id}`, subtitle: true }));
  return { options: uniqueChoices(options) };
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

/**
 * Build the list of tracks (files) a job needs to produce. `prefs`: the languages subtitles are picked by
 * ({ langs, pageLang }, see subPrefs): the user's and English first, then the page's, then the stream's order.
 */
async function planTracks(m, optionId, settings, prefs = subPrefs(null)) {
  if (m.kind === 'direct' || m.kind === 'subtitle') {
    // One of a video's several files (lib/variants.js): its picture size is its quality, as a stream's is.
    const quality = m.kind === 'direct' && m.variants?.length > 1 && heightOf(m) ? `${heightOf(m)}p` : '';
    return [{ role: m.kind === 'subtitle' ? 'subtitle' : 'file', kind: 'direct', url: m.url, ext: m.ext || extFromUrl(m.url) || 'mp4', quality }];
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
      for (const s of orderSubtitles(top.subtitles.filter((x) => x.url && (!v.subtitleGroup || x.groupId === v.subtitleGroup)), prefs).slice(0, 4)) {
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
  if (mpd.dynamic) throw new Error(LIVE_DASH);
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
    orderSubtitles(mpd.subtitles, prefs).slice(0, 4).forEach((s) => tracks.push({ role: 'subtitle', kind: 'stream', ext: dashExt(s), plan: repPlan(s), quality, lang: s.lang }));
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
    for (const [id, j] of jobs) {
      const { helperPort, ...stored } = j; // the open connection to the helper is not data
      obj[id] = stored;
    }
    chrome.storage.session.set({ jobs: obj }).catch(() => {});
  };
  if (immediate) write();
  else jobsPersistTimer = setTimeout(write, 250);
}

// Speed and time left of each running download. Kept in memory only: after a worker restart the
// measuring simply starts again.
const rates = new Map(); // jobId -> meter (lib/rate.js)

/** Take a reading of a job's progress. `fresh`: a new file of the job starts, so forget the last one. */
function noteProgress(job, fresh = false) {
  if (job.live) return; // a recording runs as long as the broadcast: no speed or time left to tell
  if (fresh || !rates.has(job.id)) {
    for (const id of rates.keys()) if (jobs.get(id)?.status !== 'running') rates.delete(id); // finished since
    rates.set(job.id, newRate());
  }
  const p = job.progress || {};
  // Chrome's own downloads count bytes; streams count segments (plus the bytes so far); the helper's downloads a percentage.
  const bytes = p.isBytes ? p.done : p.percent ? null : p.bytes;
  feedRate(rates.get(job.id), { at: Date.now(), done: p.done, total: p.total, bytes });
}

/** {bytesPerSec, etaSeconds} of a running download, or null (not running, or nothing measured yet). */
function jobRate(j) {
  if (j.status !== 'running') return null;
  const meter = rates.get(j.id);
  return meter ? readRate(meter, Date.now()) : null;
}

function publicJob(j) {
  return {
    id: j.id, tabId: j.tabId, title: j.title, filename: j.filename, status: j.status, error: j.error, optionId: j.optionId || 'file',
    detail: j.detail || '', // what was really reported, when `error` says it in plain words
    pageUrl: j.pageUrl || '',
    folder: typeof j.folder === 'string' ? j.folder : null, // the subfolder it was saved under, for "Saved to …" (null: not known)
    rate: jobRate(j),
    progress: j.progress, startedAt: j.startedAt, finishedAt: j.finishedAt, live: j.live, kind: j.kind,
    outputs: j.outputs || [], note: j.note || '', mediaUrl: j.mediaUrl, diagnosis: j.diagnosis || null,
    mediaId: j.mediaId || '', mediaKeys: j.mediaKeys || [], mediaSize: j.mediaSize || null, fingerprint: j.fingerprint || '',
    trackCount: j.tracks?.length || 0,
    trackIndex: j.tracks ? j.tracks.findIndex((t) => t.status === 'running' || t.status === 'saving') : -1,
    // A study pack: the step it is at in words, the video it is for, and what it made.
    step: j.step || '', forMedia: j.forMedia || '', pack: j.pack || null,
    course: j.course || '', madeKeys: j.madeKeys || [], // for the desk: the shelf it belongs on, and whose pack it is
    reading: j.reading || null, // a tidied reading edition: what it made
    exam: j.exam || null, // a mock exam: its file and what it holds
  };
}

// Two streams started together ("Download all") must wait for the same document: the second one used to
// find it "already there" while it was still loading, and its first message then reached nobody.
let offscreenOpening = null;
function ensureOffscreen() {
  if (!offscreenOpening) offscreenOpening = openOffscreen().finally(() => { offscreenOpening = null; });
  return offscreenOpening;
}

async function openOffscreen() {
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

// One answer per video for a while: the review sheet's preview and the download that follows ask for the
// same name, and must get the same one (asked for once).
const AI_NAME_TTL = 15 * 60 * 1000;
const aiNames = new Map(); // what was asked -> {at, name: Promise<string | null>}

async function aiFilename(settings, names, pageUrl, quality) {
  if (!settings.aiFilenames || settings.aiProvider === 'off') return null;
  const key = JSON.stringify([names.pageTitle, names.videoName, names.course, pageUrl, quality]);
  for (const [k, v] of aiNames) if (Date.now() - v.at >= AI_NAME_TTL) aiNames.delete(k);
  if (!aiNames.has(key)) {
    const entry = { at: Date.now(), name: askAiFilename(settings, names, pageUrl, quality) };
    aiNames.set(key, entry);
    // No answer (AI unreachable, too slow): kept for five minutes only, so a later download asks again.
    entry.name.then((name) => { if (!name) entry.at = Date.now() - AI_NAME_TTL + 5 * 60 * 1000; });
  }
  return aiNames.get(key).name;
}

async function askAiFilename(settings, names, pageUrl, quality) {
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

/**
 * What a download of this item is called and where it goes: gives each track its file name and returns
 * {title, base, folder}. The one place that decides it, for the download itself and for the preview in the
 * "Review before downloading" sheet. `as`: a name to use in place of the item's own (a rename the sheet
 * is showing before it is saved).
 */
async function nameTracks(tabId, t, m, settings, tracks, as = '') {
  const pageUrl = m.pageUrl || t.pageUrl;
  const quality = tracks[0].quality || '';
  const own = as || m.customName;
  // Your own name > the lecture/episode name read from the page > the tab title.
  if (!own && !m.title) {
    const info = await readVideoName(tabId, 0, m.url);
    if (info) Object.assign(m, { title: info.name, course: info.course || '', nameSource: info.source });
  }
  const rawTitle = own || m.title || t.pageTitle || m.hint || hostOf(m.url);
  const title = own
    || (await aiFilename(settings, { pageTitle: t.pageTitle, videoName: m.title, course: m.course }, pageUrl, quality))
    || rawTitle;
  const date = new Date().toISOString().slice(0, 10);
  const { base, folder } = downloadName({ settings, title, quality, course: m.course, pageTitle: t.pageTitle, pageUrl, url: m.url, kind: m.kind, date });
  const multiAV = tracks.filter((x) => x.role === 'video' || x.role === 'audio').length > 1;
  tracks.forEach((tr) => { tr.filename = trackFilename(base, tr, multiAV, folder); });
  return { title, base, folder };
}

/** A failure to read or start a download, worded for a person: "HTTP 403 fetching https://…" says what to do instead. */
const inPlainWords = (e) => {
  const plain = plainError(e?.message || String(e), { status: e?.status });
  return Object.assign(new Error(plain.text), plain.code ? { code: plain.code } : {});
};

/** Has this waiting job been cancelled (or cleared) while its start was being prepared? */
const noLongerQueued = (queued) => !!queued && jobs.get(queued.id)?.status !== 'queued';

/**
 * Start a download now. `queued`: the waiting job whose turn has come. The real job takes its place under
 * the same id, and what that job kept of its item (lib/jobs.js) is used when the page has moved on or its
 * tab is closed. Resolves to null when that waiting job was cancelled meanwhile.
 */
async function startDownload(tabId, mediaId, optionId = 'file', queued = null) {
  await loadJobs();
  const settings = await getSettings();
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const live = t.media.find((x) => x.id === mediaId);
  const kept = live ? null : queued?.snap || null;
  if (!live && (docById(tabId, t, mediaId) || kept?.doc)) return startDocDownload(tabId, mediaId, queued); // a document linked on the page
  // (A video that comes in several files: the one chosen, under the video's own id and keys. A waiting
  // job kept it that way already.)
  const m = live ? variantChoice(t.media, live, optionId) : kept?.item ? { ...kept.item } : null;
  if (!m) throw new Error('That media item is gone — reload the page.');
  // @site-edition
  if (m.kind === 'embed') return startYtdlp(tabId, { mediaId, queued });
  // @store-edition
  // if (m.kind === 'embed') throw new Error(PLAYER_PENDING);
  // @end-site-edition
  if (m.protected) throw new Error('This media is DRM/encrypted and cannot be downloaded.');
  // Names and folders come from the page the item was found on, not from where its tab is now.
  const page = kept ? { pageUrl: kept.pageUrl, pageTitle: kept.pageTitle } : t;
  const pageUrl = m.pageUrl || page.pageUrl;
  await applyRefererRules([m.url], pageUrl, true); // you clicked Download

  const tracks = await planTracks(m, optionId, settings, subPrefs(live ? t : null));
  const allUrls = new Set();
  for (const tr of tracks) {
    if (tr.url) allUrls.add(tr.url);
    if (tr.plan?.init) allUrls.add(tr.plan.init.url);
    tr.plan?.segments.forEach((s) => allUrls.add(s.url));
  }
  await applyRefererRules([...allUrls], pageUrl);

  // Without its page there is nobody to ask what the video is called: no tab is asked (TAB_ID_NONE).
  const { title, base, folder } = await nameTracks(kept ? chrome.tabs.TAB_ID_NONE : tabId, page, m, settings, tracks);
  tracks.forEach((tr) => { tr.status = 'pending'; });
  if (noLongerQueued(queued)) return null;

  const job = {
    id: queued?.id || crypto.randomUUID(), // a waiting job keeps its id (and its row in the popup) when it starts
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
    itemTitle: m.customName || m.title || page.pageTitle || '', // what the transcript and notes made afterwards are headed
    course: m.course || '', // the study pack's flashcards are filed under it
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
  noteProgress(job, true);
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
  if (!job || job.status === 'done') return; // what is saved stays saved, whatever goes wrong afterwards
  // "HTTP 403 for https://…" becomes a sentence that says what to do; the raw report is kept as `detail`.
  const plain = extra.canceled ? { text: error, detail: '' } : plainError(error, { status: extra.status });
  job.status = extra.canceled ? 'canceled' : 'error';
  job.error = plain.text;
  job.detail = plain.detail;
  job.httpStatus = extra.status || 0;
  job.finishedAt = Date.now();
  delete job.snap;
  delete job.helperPort;
  removeLeftovers(job);
  persistJobs(true);
  toOffscreen({ type: 'jobFinished', jobId }).catch(() => {});
  pumpQueue();
}

/**
 * A download that stops before its last file leaves the files it had finished: a video without its sound,
 * which is no use and makes the next try save "name (1)". They are removed, and the job says so.
 */
function removeLeftovers(job) {
  const left = leftoverTracks(job.tracks);
  if (!left.length) return;
  for (const tr of left) {
    chrome.downloads.removeFile(tr.downloadId).catch(() => {}).then(() => chrome.downloads.erase({ id: tr.downloadId }).catch(() => {}));
    tr.status = 'removed';
  }
  const names = left.map((tr) => fileName(tr.path || tr.filename)).filter(Boolean).join(', ');
  job.note = [job.note, `Removed the unfinished part${left.length > 1 ? 's' : ''} already saved (${names}).`].filter(Boolean).join(' · ');
}

async function finalizeJob(jobId) {
  const job = jobs.get(jobId);
  const settings = await getSettings();
  job.outputs = job.tracks.filter((x) => x.status !== 'skipped').map((x) => ({ role: x.role, path: x.path, filename: x.filename, downloadId: x.downloadId }));
  const av = job.tracks.filter((x) => x.role === 'video' || x.role === 'audio');
  const hasVideo = av.some((x) => x.role === 'video');
  const subs = settings.embedSubtitles && hasVideo
    ? job.tracks.filter((x) => x.role === 'subtitle' && x.path && /\.(vtt|srt)$/i.test(x.path))
    : [];
  // lib/plan.js decides whether there is something to merge and into which type (the review sheet previews by it).
  const mergeInto = mergedExt(av, subs.length);
  const needsMux = !!mergeInto;
  if (settings.useFfmpeg && needsMux && av.every((x) => x.path)) {
    // Fresh check: the cached status may predate installing ffmpeg.
    const helper = await helperStatus(true);
    if (helper.ok && helper.tools?.ffmpeg) {
      job.status = 'muxing';
      persistJobs(true);
      try {
        const outExt = mergeInto;
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
  if (job.tracks.some((x) => x.status === 'skipped')) job.note = [job.note, 'The subtitles could not be downloaded.'].filter(Boolean).join(' · ');
  if (settings.saveFolder) await moveToSaveFolder(job, settings);
  job.status = 'done';
  job.finishedAt = Date.now();
  job.progress = { ...job.progress, done: job.progress.total || job.progress.done };
  persistJobs(true);
  toOffscreen({ type: 'jobFinished', jobId }).catch(() => {});
  pumpQueue();
  await addHistory(job);
  // "Download all" on a page's documents: one notification when the last of them is saved, not one per file.
  const moreDocs = job.kind === 'doc' && [...jobs.values()].some((j) => j.kind === 'doc' && j.id !== jobId && (j.status === 'queued' || ACTIVE.includes(j.status)));
  if (settings.notify && !moreDocs) {
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
    course: job.course || '', // the course named on the lecture's page, when there was one (the desk's shelves)
    ...(typeof job.folder === 'string' ? { folder: job.folder } : {}), // the subfolder it was saved under, for "Saved to …"
    at: Date.now(),
    // The size of what was saved (measured above). Only when a file could not be measured: what was counted
    // while it ran, which for a plain file is the last progress reading (multi-track counters only cover the last track).
    bytes: savedBytes(outputs, (job.tracks?.length || 0) > 1 ? 0 : job.progress?.bytes || 0),
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
    m.maybe = null;
    if (m.mark) {
      m.library = m.mark === 'done' ? { path: '', how: 'manual' } : null;
      continue;
    }
    const unique = (names.get(nameKey(m.customName || m.title)) || 0) <= 1;
    const found = library.at ? findInLibrary(m, history, library.files, library.dirs, library.at, { nameIsUnique: unique }) : null;
    // Only the length agrees: it may be this video, so it is said in a note and never shown as downloaded.
    m.library = found?.probable ? null : found;
    m.maybe = found?.probable ? { path: found.path } : null;
  }
  // Captions saved next to the file ("Lecture 3.vtt", e.g. from "Transcribe on this computer").
  for (const m of t.media) m.localCaptions = !!(m.library?.path && !m.library.missing && hasLocalCaptions(m.library.path));
}

let savedCheckAt = 0;

/**
 * Are the files this page's videos were saved to still there? Checked when StreamSnag is opened (a few files,
 * at most every few seconds); when one is gone (deleted, moved), the folder is scanned again at once, so the
 * video stops being shown as downloaded without waiting for the next scan.
 */
async function checkSavedFiles(t, history) {
  if (libraryScan || Date.now() - savedCheckAt < 4000) return;
  const paths = savedPathsOf(t.media, history);
  if (!paths.length) return;
  savedCheckAt = Date.now();
  if (!(await helperStatus()).ok) return;
  const res = await helperRequest({ type: 'stat', paths }, { timeoutMs: 8000 }).catch(() => null);
  if (res?.stats?.some((s) => !s)) scanLibrary({ force: true }).catch(() => {});
}

let captioned = { of: null, paths: new Set() };

/** Does a .vtt with the same name sit next to this file? (From the folder scan, and from transcriptions made since.) */
function hasLocalCaptions(file) {
  if (captioned.of !== library) {
    captioned = { of: library, paths: new Set((library?.files || []).filter((x) => x.vtt).map((x) => x.path.toLowerCase())) };
  }
  return captioned.paths.has(file.toLowerCase())
    || [...jobs.values()].some((j) => j.kind === 'transcribe' && j.status === 'done' && j.input === file);
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
    const [item] = !tr.path || job.kind === 'doc' ? await chrome.downloads.search({ id: delta.id }) : [];
    if (!tr.path) tr.path = item?.filename || '';
    if (tr.path) learnDownloadsRoot(tr.path, job.folder); // where downloads land: a later file's name must fit its path (saveCompanions)
    // A "document" that arrived as a web page is a viewer or a sign-in page saved under the file's name:
    // it is not kept, and the row says what happened instead of "Downloaded".
    if (job.kind === 'doc' && isWebPageMime(item?.mime)) {
      await chrome.downloads.removeFile(delta.id).catch(() => {});
      chrome.downloads.erase({ id: delta.id }).catch(() => {});
      failJob(job.id, WEB_PAGE_NOT_FILE);
      return;
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
    if (item) noteProgress(job);
  }
}

async function cancelJob(jobId) {
  await loadJobs();
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.status === 'queued') {
    Object.assign(job, { status: 'canceled', error: 'Canceled', finishedAt: Date.now() });
    delete job.snap;
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
const activeDownloads = () => [...jobs.values()].filter((j) => ACTIVE.includes(j.status) && !j.live && j.kind !== 'transcribe' && j.kind !== 'studypack' && j.kind !== 'reading').length;

// A download exists as a job only once its playlists are read and its name is known (seconds, with an AI
// file name up to half a minute). Until then a second click, or a second message, must find the first.
const starting = new Map(); // "tabId:mediaId" -> the start in progress
let startingNow = 0; // starts in progress that have no job yet: each already holds a download slot

function enqueueDownload(tabId, mediaId, optionId = 'file') {
  const key = `${tabId}:${mediaId}`;
  if (starting.has(key)) return starting.get(key); // one click too many
  const start = enqueueOnce(tabId, mediaId, optionId).finally(() => starting.delete(key));
  starting.set(key, start);
  return start;
}

async function enqueueOnce(tabId, mediaId, optionId) {
  await loadJobs();
  const settings = await getSettings();
  const already = [...jobs.values()].find((j) => j.mediaId === mediaId && j.tabId === tabId && (j.status === 'queued' || ACTIVE.includes(j.status)));
  if (already) return publicJob(already); // one click too many
  if (activeDownloads() + startingNow < Math.max(1, Number(settings.maxParallel) || 2)) {
    startingNow++;
    try {
      return await startDownload(tabId, mediaId, optionId);
    } catch (e) {
      throw inPlainWords(e);
    } finally {
      startingNow--;
    }
  }
  const t = await getTab(tabId);
  const listed = t.media.find((x) => x.id === mediaId);
  const m = listed ? variantChoice(t.media, listed, optionId) : null; // the file chosen, of a video that comes in several
  const d = m ? null : docById(tabId, t, mediaId);
  if (!m && !d) throw new Error('That media item is gone — reload the page.');
  const it = m || d;
  const job = {
    id: crypto.randomUUID(), tabId, mediaId, optionId, kind: it.kind, mediaUrl: it.url, mediaKeys: keysOf(it),
    mediaSize: it.kind === 'direct' ? it.size || null : null, fingerprint: it.fingerprint || '', pageUrl: it.pageUrl || t.pageUrl,
    title: it.customName || it.title || t.pageTitle || hostOf(it.url), filename: '', status: 'queued',
    progress: { done: 0, total: 0, bytes: 0 }, tracks: [], outputs: [], startedAt: Date.now(), queuedAt: Date.now(),
    // Enough of the item to start when its turn comes, even if the page has moved on or the tab is closed
    // by then. Kept only while it waits: it is dropped when the download starts (or can't).
    snap: m ? mediaSnapshot(m, t) : docSnapshot(d, await docTarget(tabId, t, d, settings)),
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
      if (!next || activeDownloads() + startingNow >= max) break;
      let problem = null;
      try {
        // The waiting job stays "queued" until the real one takes its place under the same id.
        await startDownload(next.tabId, next.mediaId, next.optionId, next);
      } catch (e) {
        problem = plainError(e.message, { status: e.status, queued: true });
      }
      const now = jobs.get(next.id);
      if (now === next && next.status === 'queued') {
        // It could not start (or nothing took its place): it must not be picked again.
        const { snap, ...rest } = next;
        jobs.set(next.id, { ...rest, status: 'error', error: problem?.text || 'This download could not start.', detail: problem?.detail || '', finishedAt: Date.now() });
        persistJobs(true);
      }
    }
  } finally {
    pumping = false;
  }
}

// ---------------------------------------------------------------- files on this page (slides, handouts…)
// Documents a page links to are kept apart from its videos (t.docs, not t.media), so the badge, the big
// card, "now playing" and duplicate-merging never see them. Downloading one is an ordinary job: the same
// queue, folders, save-folder move and history as a video. lib/files.js decides what counts as a document.

/** Remember what one frame reported (untrusted: cleaned and capped in lib/files.js). */
function noteDocs(tabId, t, frameId, reported) {
  const next = frameDocs(t.docs, frameId, reported);
  if (JSON.stringify(next) === JSON.stringify(t.docs || {})) return;
  t.docs = next;
  persistTab(tabId);
}

/** The tab's documents as the popup lists them, shaped like media items where a job needs it (id, key, url, title). */
function docsOf(tabId, t) {
  return mergeDocs(t.docs).map((d) => ({
    ...d, id: `d${shortId(`${tabId}:${d.key}`)}`, kind: 'doc', title: d.name, host: hostOf(d.url), label: docLabel(d.ext),
  }));
}

/** Frames that are gone (a reloaded page gets new ones, a closed viewer takes its links along) no longer count. */
async function pruneDocFrames(tabId, t) {
  if (!Object.keys(t.docs || {}).length) return;
  const frames = await chrome.webNavigation?.getAllFrames({ tabId }).catch(() => null);
  if (!frames?.length) return;
  const live = new Set(frames.map((f) => String(f.frameId)));
  const kept = Object.entries(t.docs || {}).filter(([id]) => live.has(id));
  if (kept.length === Object.keys(t.docs || {}).length) return;
  t.docs = Object.fromEntries(kept);
  persistTab(tabId);
}

function docById(tabId, t, id) {
  return String(id || '').startsWith('d') ? docsOf(tabId, t).find((d) => d.id === id) || null : null;
}

/** The {course} folder for a page's documents: the one its videos are filed under, else what the page says. */
async function courseForDocs(tabId, t) {
  const fromVideo = visibleMedia(t).filter((m) => m.course).sort((a, b) => b.detectedAt - a.detectedAt)[0]?.course;
  return fromVideo || (await readVideoName(tabId, 0))?.course || '';
}

/**
 * The file name and subfolder a document is saved under: "<name>.<type>", the name sanitised and the type
 * from the whitelist. Shared by the download and by the review sheet's list of files.
 */
async function docTarget(tabId, t, d, settings) {
  const file = docFilename(d.name, d.ext);
  if (!isHttpUrl(d.url) || !file) throw new Error('StreamSnag does not save this type of file.');
  const pageUrl = t.pageUrl;
  const rules = rulesFor(settings, pageUrl || d.url); // same folders as this site's videos
  const course = sanitizeFilename(/\{course\}/.test(rules.subfolder || '') ? await courseForDocs(tabId, t) : '', 80);
  const date = new Date().toISOString().slice(0, 10);
  return { file, pageUrl, folder: resolveFolder(rules.subfolder, { site: siteKey(pageUrl || d.url), course, date, kind: 'doc' }) };
}

/** Save one document. The file is "<name>.<type>": the name sanitised, the type from the whitelist. */
async function startDocDownload(tabId, docId, queued = null) {
  await loadJobs();
  const settings = await getSettings();
  const t = await getTab(tabId);
  const live = docById(tabId, t, docId);
  // Waited in the queue while the page moved on: the link, name and folder the waiting job kept.
  const kept = live ? null : queued?.snap?.doc ? queued.snap : null;
  const d = live || kept?.doc;
  if (!d) throw new Error('That file is no longer on the page. Reload the page.');
  // The file's name and type are worked out again from the whitelist either way; only the folder is taken as kept.
  const { file, folder, pageUrl } = kept ? { ...kept.target, file: docFilename(d.name, d.ext) } : await docTarget(tabId, t, d, settings);
  if (!isHttpUrl(d.url) || !file) throw new Error('StreamSnag does not save this type of file.');
  await applyRefererRules([d.url], pageUrl, true); // you clicked Download
  const filename = folder ? `${folder}/${file}` : file; // folder is already resolveFolder()-safe
  if (noLongerQueued(queued)) return null;
  const job = {
    id: queued?.id || crypto.randomUUID(), tabId, mediaId: d.id, optionId: 'file', mediaUrl: d.url, mediaKeys: [d.key], mediaSize: null, fingerprint: '',
    pageUrl, kind: 'doc', title: d.name, base: file.slice(0, -(d.ext.length + 1)), folder, filename, status: 'running', live: false,
    progress: { done: 0, total: 0, bytes: 0 },
    tracks: [{ role: 'file', kind: 'direct', url: d.url, ext: d.ext, quality: '', filename, status: 'pending' }],
    outputs: [], startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  persistJobs(true);
  runNextTrack(job.id).catch((e) => failJob(job.id, e.message));
  return publicJob(job);
}

/**
 * "Download all": every document on the page that isn't downloaded, queued or running, and never an
 * archive (a bundle that may be gigabytes). `only`: just the ones with these ids, the files ticked in the
 * review sheet: an archive is among them only when it was ticked there by hand (the sheet lists it unticked).
 */
async function downloadDocs(tabId, only = null) {
  await loadJobs();
  const t = await getTab(tabId);
  const { history = [] } = await chrome.storage.local.get('history');
  let queued = 0;
  let skipped = 0;
  for (const d of docsOf(tabId, t)) {
    if (only ? !only.includes(d.id) : !inDocsBulk(d)) continue;
    const st = docStatus(d, [...jobs.values()], history);
    // One click for many links the page chose: none of them may reach into your own network from a public page.
    if ((st !== 'new' && st !== 'failed') || !autoFetchAllowed(d.url, t.pageUrl)) {
      skipped++;
      continue;
    }
    await enqueueDownload(tabId, d.id);
    queued++;
  }
  return { queued, skipped };
}

// ---------------------------------------------------------------- playlists (showcases): every video, not just the played ones

// @site-edition
/** Ask yt-dlp for the playlist's videos and list each one; already-downloaded ones show as such. */
async function listPlaylist(tabId, mediaId) {
  const t = await getTab(tabId);
  const p = t.media.find((x) => x.id === mediaId);
  if (!p?.playlist) throw new Error('That item is not a playlist.');
  const helper = await helperStatus(true);
  if (!helper.ok) throw new Error(helper.error);
  if (!helper.tools?.ytdlp) throw new Error(`Listing a playlist needs yt-dlp. ${await installTip('yt-dlp')}, then try again.`);
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
// @end-site-edition

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
  const settings = await getSettings();
  const ctx = { ...helperOnce(true), fresh: true };
  let queued = 0;
  let skipped = 0;
  for (const e of entries) {
    const target = e.covered ? t.media.find((x) => x.id === e.covered) || e : e; // a played lecture downloads from its stream
    if (isDone(target) || isDone(e) || busy(target) || busy(e)) {
      skipped++;
      continue;
    }
    // The stream of a played lecture starts at the quality set in Settings, like "Download all". If it can't
    // be read any more (its link has expired), the lecture is fetched through the playlist instead.
    const viaStream = target === e ? null : await bulkOption(tabId, t, target.id, settings, ctx).catch(() => null);
    await enqueueDownload(tabId, viaStream ? target.id : e.id, viaStream ? viaStream.optionId : 'file');
    queued++;
  }
  return { queued, skipped };
}

/**
 * "Download all": start each of these page items at the quality set in Settings, through the normal queue
 * (so the limit, the naming rules and the history all apply). One that can't start doesn't stop the rest:
 * the answer lists them, {started, failed: [{id, title, error}]}, for a single summary line.
 * From the review sheet also: `names` ({id: name}, the names it showed for renamed and numbered videos) and
 * `docIds` (the page's documents ticked there, counted in `started` and as `files`).
 */
async function downloadMany(tabId, mediaIds, names = null, docIds = null) {
  await loadJobs();
  const settings = await getSettings();
  const t = await getTab(tabId);
  const ids = idList(mediaIds);
  const failed = [];
  let started = 0;
  const ctx = { ...helperOnce(true), fresh: true };
  for (const id of ids) {
    const m = t.media.find((x) => x.id === id);
    try {
      const { optionId } = await bulkOption(tabId, t, id, settings, ctx);
      // A name set in the review sheet is saved the way Rename saves it, before the download reads it.
      const name = givenName(names, id);
      if (name && setCustomName(m, name)) persistTab(tabId);
      await enqueueDownload(tabId, id, optionId);
      started++;
    } catch (e) {
      failed.push({ id, title: m ? m.customName || m.title || '' : '', error: e.message || String(e) });
    }
  }
  // The files ticked in the sheet go the way "Files on this page" sends them; one answer covers the lot.
  const docs = idList(docIds);
  const files = docs.length ? (await downloadDocs(tabId, docs)).queued : 0;
  return { started: started + files, failed, files };
}

// ---------------------------------------------------------------- review before downloading
// "Download all" opens a sheet that shows what would be saved, under which names, before anything starts.
// The preview is made by the same code a download runs (bulkOption, planTracks, nameTracks), so the name on
// the sheet is the name of the file. lib/review.js groups and labels the rows; lib/plan.js builds the names.

/** Ids from a message: strings, once each, at most 200. */
function idList(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'))].slice(0, 200);
}

/** The name the sheet gave one item ({id: name}), tidied like a rename; '' when it gave none. */
function givenName(names, id) {
  return names && typeof names === 'object' && Object.hasOwn(names, id) && typeof names[id] === 'string' ? cleanName(names[id]) : '';
}

/** Give an item your own name ('' takes it away again). Rename and the review sheet both save names here. */
function setCustomName(m, name) {
  const clean = cleanName(name);
  if (clean) m.customName = clean;
  else delete m.customName;
  return clean;
}

/**
 * Ask the helper what it can do at most once for a batch (and only when something in the batch needs it).
 * `force`: start it and ask now, as a download does; the sheet's preview goes by what it said in the last
 * minute, so ticking a box or typing a name never waits for the helper to start.
 */
function helperOnce(force) {
  let asked = null;
  return { helper: () => (asked = asked || helperStatus(force)) };
}

/**
 * "Download all" for one page item: the option it starts with, at the quality set in Settings. Throws, in
 * plain words, when the item can't be started; `why` on the error says what kind of trouble it is (the
 * review sheet groups by it). Shared by the sheet's preview and by the downloads themselves.
 */
const PLAYER_PENDING = 'This player has not been looked at yet. Close this and try again in a moment.';

async function bulkOption(tabId, t, id, settings, ctx) {
  const fail = (why, message) => Object.assign(new Error(message), { why });
  const m = t.media.find((x) => x.id === id);
  if (!m) throw fail('other', 'It is no longer on the list. Reload the page.');
  if (m.protected) throw fail('protected', 'It is protected (DRM), so it can\'t be saved.');
  if (m.info?.live) throw fail('live', m.kind === 'dash' ? LIVE_DASH : 'It is live. Record it from its own card.');
  if (m.pending) throw fail('other', PLAYER_PENDING);
  if (!canBulkDownload(m)) throw fail('other', 'It is not a single video.');
  // One click for many links the page chose: none of them may reach into your own network from a public page.
  if (!autoFetchAllowed(m.url, m.pageUrl || t.pageUrl)) throw fail('other', 'It is on your own network. Download it from its own card.');
  let optionId = 'file';
  let option = null;
  if (m.kind === 'direct' && m.variants?.length > 1) {
    // One video in several files: the one the quality set in Settings picks (MP4 before WebM and OGV at the same size).
    option = pickPreferred(variantOptions(m), settings.preferredQuality);
    optionId = option?.id || 'file';
  } else if (m.kind === 'hls' || m.kind === 'dash') {
    // Reading the qualities also tells us now, not later in the queue, that a link has expired. A download
    // reads them afresh (the link may have expired while the sheet was open); the sheet's preview may use
    // what was read a moment ago.
    const found = await (ctx.fresh ? inspectMedia(tabId, id) : inspectCached(tabId, id)).catch((e) => { throw Object.assign(inPlainWords(e), { why: 'unreadable' }); });
    if (found.protected) throw fail('protected', 'It is protected (DRM), so it can\'t be saved.');
    if (found.live) throw fail('live', found.note || 'It is live. Record it from its own card.');
    option = pickPreferred(found.options, settings.preferredQuality);
    if (!option) throw fail('other', found.note || 'No video was found in this stream.');
    optionId = option.id;
  } else if (m.kind === 'embed') {
    // @site-edition
    const helper = await ctx.helper();
    if (!helper.ok) throw fail('other', helper.error);
    if (!helper.tools?.ytdlp) throw fail('other', 'yt-dlp was not found. Install it, then try again.');
    // @store-edition
    // throw fail('other', PLAYER_PENDING);
    // @end-site-edition
  }
  return { m, optionId, option };
}

// The sheet asks about the same streams again whenever a name changes: what a stream's download is made of
// (which files, of which type) is remembered briefly, so only the first look reads its playlists.
const SHAPE_TTL = 3 * 60 * 1000;
const shapeCache = new Map(); // "tabId:mediaId:optionId:…" -> {at, url, tracks}

/** The tracks a download of this item would have, without their segment lists: [{role, ext, quality, lang, live}]. */
async function trackShapes(tabId, m, optionId, settings) {
  const key = `${tabId}:${m.id}:${optionId}:${settings.includeSubtitles ? 1 : 0}`;
  const hit = shapeCache.get(key);
  if (hit && hit.url === m.url && Date.now() - hit.at < SHAPE_TTL) return hit.tracks.map((x) => ({ ...x }));
  const t = await getTab(tabId);
  const tracks = (await planTracks(variantChoice(t.media, m, optionId), optionId, settings, subPrefs(t)))
    .map((tr) => ({ role: tr.role, ext: tr.ext, quality: tr.quality || '', lang: tr.lang || '', live: !!tr.plan?.live }));
  for (const [k, v] of shapeCache) if (Date.now() - v.at >= SHAPE_TTL) shapeCache.delete(k);
  if (m.kind !== 'direct') shapeCache.set(key, { at: Date.now(), url: m.url, tracks });
  return tracks.map((x) => ({ ...x }));
}

/** What downloading one item (or one document) would do right now, for the sheet. Never throws. */
async function planOne(tabId, t, id, settings, ctx, as) {
  try {
    const d = docById(tabId, t, id);
    if (d) {
      // As in "Download all" for files: nothing on your own network is fetched in one go from a public
      // page. (An archive is planned like any file: the sheet lists it unticked, and says how big it is.)
      if (!autoFetchAllowed(d.url, t.pageUrl)) throw new Error('It is on your own network: download it from its own row.');
      const target = await docTarget(tabId, t, d, settings);
      return { id, ok: true, doc: true, title: d.name, filename: target.file, folder: target.folder, quality: '' };
    }
    const { m, optionId, option } = await bulkOption(tabId, t, id, settings, ctx);
    // @site-edition
    if (m.kind === 'embed') {
      // yt-dlp picks the file's type itself: the name is known, its ending is not.
      const target = ytdlpTarget(t, m, settings, m.url, as);
      return { id, ok: true, optionId, title: as || m.customName || m.title || '', filename: target.name, folder: target.subfolder, quality: '', loose: true };
    }
    // @end-site-edition
    const tracks = await trackShapes(tabId, m, optionId, settings).catch((e) => {
      throw Object.assign(e, { why: /DRM|encrypt/i.test(e.message || '') ? 'protected' : 'unreadable' });
    });
    if (tracks.some((x) => x.live)) throw Object.assign(new Error('It is live. Record it from its own card.'), { why: 'live' });
    const { title, base, folder } = await nameTracks(tabId, t, m, settings, tracks, as);
    const isStream = m.kind === 'hls' || m.kind === 'dash';
    const helper = isStream && settings.useFfmpeg ? await ctx.helper() : null;
    const file = plannedFile(tracks, base, settings, !!(helper?.ok && helper.tools?.ffmpeg));
    // A stream's size is not written anywhere: its bitrate times its length is a fair guess.
    const guess = isStream && option?.bandwidth > 0 && m.info?.duration > 0 ? Math.round((option.bandwidth / 8) * m.info.duration) : 0;
    return {
      id, ok: true, optionId, title, filename: file.filename, extra: file.extra, folder, quality: tracks[0].quality || '',
      size: m.kind === 'direct' ? variantChoice(t.media, m, optionId).size || 0 : 0, about: guess,
    };
  } catch (e) {
    return { id, ok: false, why: e.why || 'other', reason: e.message || String(e) };
  }
}

const PLAN_CAP = 20000; // the longest one answer to the sheet may take; whatever isn't read by then says so
const PLAN_AT_ONCE = 4; // streams read at the same time

/**
 * The review sheet's preview: for each of these page items and documents, exactly what a download would do
 * right now, {id, ok, filename, folder, quality, size?, title, reason?}, and where downloads land (`root`).
 * `names` ({id: name}) previews renames before they are saved. Nothing is downloaded or changed.
 */
async function planDownloads(tabId, mediaIds, names = null) {
  await loadJobs();
  const settings = await getSettings();
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const ctx = helperOnce(false);
  // An AI file name can take a while to come back: allow for it when that setting is on.
  const deadline = Date.now() + (settings.aiFilenames && settings.aiProvider !== 'off' ? PLAN_CAP * 2 : PLAN_CAP);
  const late = (id) => ({ id, ok: false, why: 'slow', reason: 'Reading it took too long.' });
  const items = await mapLimit(idList(mediaIds), PLAN_AT_ONCE, (id) => {
    const left = deadline - Date.now();
    if (left <= 0) return late(id);
    let timer;
    return Promise.race([
      planOne(tabId, t, id, settings, ctx, givenName(names, id)),
      new Promise((resolve) => { timer = setTimeout(() => resolve(late(id)), left); }),
    ]).finally(() => clearTimeout(timer));
  });
  // Files only reach your own folder when the helper is there to move them (as a finished download finds out).
  const root = saveRoot(settings, settings.saveFolder ? (await ctx.helper()).ok : false);
  return { root, items };
}

// ---------------------------------------------------------------- local helper

/** "Install it with …" for a tool the helper did not find, for this kind of computer (winget, brew or the package manager). */
async function installTip(tool) {
  const info = await chrome.runtime.getPlatformInfo().catch(() => null);
  return installHint(tool, info?.os || '');
}

let helperCache = { at: 0, value: null };
async function helperStatus(force = false) {
  if (!force && helperCache.value && Date.now() - helperCache.at < 60000) return helperCache.value;
  try {
    const res = await helperRequest({ type: 'ping' }, { timeoutMs: 8000 });
    helperCache = { at: Date.now(), value: { ok: true, version: res.version, tools: res.tools || {}, stt: res.stt || null } };
  } catch (e) {
    helperCache = { at: Date.now(), value: { ok: false, error: e.message } };
  }
  return helperCache.value;
}

// @site-edition
/**
 * The name (without a type: yt-dlp adds it) and subfolder of a yt-dlp download. One video with a known name
 * is named like every other download (template, {number}, {name}); otherwise yt-dlp names it ('').
 * Shared by the download and by the review sheet's preview (`as`: a rename it is showing).
 */
function ytdlpTarget(t, item, settings, target, as = '') {
  const rules = rulesFor(settings, t.pageUrl);
  const date = new Date().toISOString().slice(0, 10);
  const course = sanitizeFilename(item?.course || '', 80);
  const title = as || item?.customName || item?.title;
  const name = item && !item.playlist && title
    ? buildFilename(rules.filenameTemplate, { title, quality: '', course, page: t.pageTitle || '', host: siteKey(t.pageUrl || target), date, kind: 'ytdlp' }, '')
    : '';
  return { name, subfolder: resolveFolder(rules.subfolder, { site: siteKey(t.pageUrl), course, date, kind: 'ytdlp' }) };
}

/**
 * Download with yt-dlp, through the helper: one listed item (`mediaId`), or a page (`url`, else the tab's).
 * `queued`: the waiting job whose turn has come (see startDownload).
 */
async function startYtdlp(tabId, { url, mediaId, queued = null } = {}) {
  await loadJobs();
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const live = mediaId ? t.media.find((x) => x.id === mediaId) : null;
  const kept = !live && queued?.snap?.item ? queued.snap : null;
  const item = live || (kept ? { ...kept.item } : null);
  // An item that was asked for and is gone is never swapped for "whatever page the tab shows now".
  if (mediaId && !item) throw new Error('That media item is gone — reload the page.');
  const page = kept ? { pageUrl: kept.pageUrl, pageTitle: kept.pageTitle } : t;
  // A video listed from a playlist downloads through that playlist (domain-restricted showcases need it).
  const viaPlaylist = item?.parentId && item.playlistUrl && item.playlistIndex;
  const target = viaPlaylist ? item.playlistUrl : item?.url || (isHttpUrl(url || '') ? url : page.pageUrl);
  const helper = await helperStatus(true);
  if (!helper.ok) throw new Error(helper.error);
  if (!helper.tools?.ytdlp) throw new Error(`yt-dlp was not found. ${await installTip('yt-dlp')}, then try again.`);
  const settings = await getSettings();
  const [dl] = await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] });
  if (noLongerQueued(queued)) return null;
  const job = {
    // Recorded under the video itself, not the playlist it was fetched through (or the playlist would count as saved).
    id: queued?.id || crypto.randomUUID(), tabId, kind: 'ytdlp', mediaUrl: item?.url || target, pageUrl: page.pageUrl,
    mediaId: item?.id || '', mediaKeys: item ? keysOf(item) : [], optionId: 'file',
    title: item?.customName || item?.title || page.pageTitle || page.pageUrl, filename: 'yt-dlp', status: 'running', tracks: [], outputs: [],
    itemTitle: item?.customName || item?.title || page.pageTitle || '',
    progress: { done: 0, total: 100, bytes: 0, percent: true }, startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  persistJobs(true);
  const named = ytdlpTarget(page, item, settings, target);
  const name = named.name;
  helperRequest({
    type: 'ytdlp',
    url: target,
    playlist: !!item?.playlist && !viaPlaylist, // a showcase: download every video in it
    items: viaPlaylist ? String(item.playlistIndex) : undefined,
    name: name || undefined,
    referer: page.pageUrl,
    subfolder: named.subfolder,
    dir: settings.saveFolder || '',
    downloadsHint: dl?.filename || '',
    quality: settings.preferredQuality, // "Quality to pick first" holds for yt-dlp too
  }, {
    timeoutMs: 6 * 60 * 60 * 1000,
    onPort: (port) => { job.helperPort = port; }, // Cancel closes it, and the helper then stops yt-dlp
    onProgress: (p) => {
      if (job.status !== 'running') return;
      if (Number.isFinite(p.percent)) job.progress = { done: p.percent, total: 100, bytes: 0, percent: true };
      if (Number.isFinite(p.percent)) noteProgress(job);
      if (p.line) job.note = p.line.slice(0, 160);
      persistJobs();
    },
  }).then(async (res) => {
    if (job.status !== 'running') return; // cancelled meanwhile: not "Done", no history, nothing afterwards
    job.status = 'done';
    job.finishedAt = Date.now();
    delete job.helperPort;
    job.outputs = (res.files || []).map((f) => ({ role: 'file', path: f, filename: f }));
    job.note = res.files?.length > 1 ? `Saved ${res.files.length} videos to ${parentDir(res.files[0])}`
      : res.files?.length ? `Saved to ${res.files[0]}` : 'yt-dlp finished';
    if (res.warning) job.note += ` · some videos failed: ${res.warning.slice(0, 160)}`;
    persistJobs(true);
    pumpQueue();
    await addHistory(job);
  }).catch((e) => { if (job.status === 'running') failJob(job.id, e.message); });
  return publicJob(job);
}
// @end-site-edition

// ---------------------------------------------------------------- converted copies (helper + ffmpeg)

const CONVERT_TITLES = { audio: 'Audio (MP3) of', small: 'Smaller copy (720p) of' };

/** Make an MP3 or a smaller 720p copy of a file you already downloaded, next to it. Shown as a job. */
async function startConvert(tabId, { path: file, mode, title } = {}) {
  await loadJobs();
  if (!Object.hasOwn(CONVERT_TITLES, mode)) throw new Error('Unknown conversion');
  if (typeof file !== 'string' || !file) throw new Error('That file is not on this computer any more.');
  const helper = await helperStatus(true);
  if (!helper.ok) throw new Error(helper.error);
  if (!helper.tools?.ffmpeg) throw new Error(`ffmpeg was not found. ${await installTip('ffmpeg')}, then try again.`);
  // The same copy of the same file is made once: a second click finds the first (as for a transcription).
  const already = [...jobs.values()].find((j) => j.kind === 'convert' && j.input === file && j.mode === mode && j.status === 'running');
  if (already) return publicJob(already);
  const name = String(title || '').trim() || file.split(/[\\/]/).pop();
  const job = {
    id: crypto.randomUUID(), tabId, kind: 'convert', mediaUrl: '', pageUrl: '', mediaId: '', mediaKeys: [], optionId: 'file', input: file, mode,
    title: `${CONVERT_TITLES[mode]} ${name}`.slice(0, 200), filename: file.split(/[\\/]/).pop(), status: 'running', tracks: [], outputs: [],
    progress: { done: 0, total: 100, bytes: 0, percent: true }, startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  persistJobs(true);
  helperRequest({ type: 'convert', input: file, mode }, {
    timeoutMs: 6 * 60 * 60 * 1000,
    onPort: (port) => { job.helperPort = port; },
    onProgress: (p) => {
      if (job.status !== 'running') return;
      if (Number.isFinite(p.percent)) job.progress = { done: p.percent, total: 100, bytes: 0, percent: true };
      persistJobs();
    },
  }).then((res) => {
    if (job.status !== 'running') return; // cancelled meanwhile
    job.status = 'done';
    job.finishedAt = Date.now();
    delete job.helperPort;
    job.outputs = [{ role: 'file', path: res.output, filename: res.output }];
    job.note = `Saved to ${res.output}`;
    persistJobs(true);
    pumpQueue();
    setTimeout(() => scanLibrary({ force: true }).catch(() => {}), 500);
  }).catch((e) => { if (job.status === 'running') failJob(job.id, e.message); });
  return publicJob(job);
}

/** The last part of a path: "C:\Videos\Lecture 3.mp4" → "Lecture 3.mp4". */
const fileName = (p) => String(p || '').split(/[\\/]/).pop();



// ---------------------------------------------------------------- AI features

const AI_OFF_FIND = 'AI is turned off. Choose a provider in StreamSnag settings.';

/** Save a rule for its site by itself, and remember what it replaced so that "Undo" can put that back. */
async function rememberRule(t, recipe) {
  const rule = normalizeRecipe(recipe);
  const recipes = await getRecipes();
  const previous = Object.hasOwn(recipes, rule.site) ? recipes[rule.site] : null;
  const at = Date.now();
  recipes[rule.site] = { ...rule, savedAt: at, by: 'ai' };
  await chrome.storage.local.set({ recipes });
  t.ruleUndo = { site: rule.site, at, previous };
  return { site: rule.site, at, replaced: !!previous };
}

/** "Undo" under "StreamSnag will find videos on … this way from now on": the rule goes, and what it replaced comes back. */
async function undoRule(tabId) {
  const t = await getTab(tabId);
  const u = t.ruleUndo;
  if (!u) throw new Error('There is nothing to undo here any more.');
  const recipes = await getRecipes();
  // Only the rule that was saved then: one you have changed in Settings since is yours, and stays.
  if (recipes[u.site]?.savedAt === u.at) {
    if (u.previous) recipes[u.site] = u.previous;
    else delete recipes[u.site];
    await chrome.storage.local.set({ recipes });
  }
  t.ruleUndo = null;
  if (t.aiResult?.saved) t.aiResult = { ...t.aiResult, saved: { ...t.aiResult.saved, undone: true } };
  persistTab(tabId);
  return { site: u.site };
}

/**
 * "Ask your AI to find it". Without `confirmed` nothing is sent: the answer is { confirm }, what would be
 * sent, to whom and at whose cost (lib/rescue.js: findConfirm), for the sheet the popup shows first. With
 * it, one request goes to the AI account chosen in Settings. Everything in the answer is untrusted:
 *  - an address it names is only asked for when it is part of this page (on the page's own site, or on a
 *    server the page itself names or has contacted) and not on your own network, and it is only listed
 *    when it answers as a real video, sound file, stream or caption file (verifyFound);
 *  - its rule is data (lib/recipes.js), run once on this page. When that finds a video that really is
 *    one, the rule is saved for the site by itself (rememberRule); the popup says so, with "Undo".
 */
async function aiFind(tabId, { confirmed = false } = {}) {
  const settings = await getSettings();
  // Checked before the page is read: without an AI account nothing is collected.
  if (!aiReady(settings)) throw new Error(AI_OFF_FIND);
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const snap = await pageSnapshot(tabId);
  const pageUrl = t.pageUrl || snap.url;
  const lastErr = [...jobs.values()].filter((j) => j.tabId === tabId && j.status === 'error').pop()?.error || '';
  const prompt = buildFindPrompt({
    pageUrl,
    pageTitle: t.pageTitle || snap.title,
    detected: visibleMedia(t).map((m) => ({ kind: m.kind, url: m.url })),
    network: t.log,
    dom: snap.dom,
    snippets: snap.snippets,
    previousError: lastErr,
  });
  if (confirmed !== true) {
    return {
      confirm: findConfirm({
        prompt, provider: settings.aiProvider, providerLabel: PROVIDER_LABELS[settings.aiProvider] || '', site: siteKey(pageUrl),
        counts: { network: Math.min(t.log.length, 300), snippets: (snap.snippets || []).length, players: (snap.dom?.videos?.length || 0) + (snap.dom?.iframes?.length || 0) },
      }),
    };
  }
  const listedBefore = new Set(visibleMedia(t).map((m) => m.id));
  const namesBefore = new Map(t.media.map((m) => [m.id, m.title || '']));
  const res = await callAI(settings, prompt);
  if (!samePageUrl(t.pageUrl || pageUrl, pageUrl)) throw new Error('The page changed while your AI was looking. Ask again on this page.');
  const result = normalizeFindResult(res.data, pageUrl);
  // What the page itself names or has contacted: an answer may point there, and nowhere else.
  const named = namedHosts(snap, t.log.map((l) => l.url));
  const refused = [];
  const allowed = (c) => {
    const why = refusedAddress(c.url, pageUrl, named);
    if (why) refused.push({ host: hostOf(c.url).slice(0, 80), why });
    return !why;
  };
  const media = result.candidates.filter((c) => c.kind !== 'page').filter(allowed);
  const pages = result.candidates.filter((c) => c.kind === 'page').filter(allowed).slice(0, 5).map((c) => ({ url: c.url, label: c.label }));
  const fromAi = await addFoundUrls(tabId, media.map((c) => ({ url: c.url, captions: c.kind === 'subtitle' })), 'ai', { strict: true });
  // Its rule, run once on this page: what it finds is checked the same way.
  let recipeTest = null;
  let fromRule = { added: [], real: [], captions: 0, realUrls: [], realIds: [], captionUrls: [] };
  if (result.recipe) {
    const snap2 = await pageSnapshot(tabId, selectorsFor(result.recipe)).catch(() => snap);
    recipeTest = await runRecipe(result.recipe, { ...snap2, network: t.log.map((l) => l.url) }, ruleFetch(pageUrl))
      .catch((e) => ({ urls: [], title: '', captions: [], log: [e.message], by: {} }));
    fromRule = await useRuleResult(tabId, t, recipeTest, { pageUrl });
  }
  // It worked: the rule found a video that really is one and that was not listed before, or it gave a
  // video that is listed its name. What is remembered for the site is only what made a difference on this
  // page (lib/recipes.js: provenRecipe): a rule that found nothing real, that only found what ordinary
  // detection had listed already, or that asked the site for a page that is not there, is not kept.
  // (A name counts when this answer's rule gave it: a video that was called so already was not helped by it.)
  const named1 = t.media.find((m) => m.nameSource === 'rule' && !m.hidden && !m.dismissed && m.title === ruleName(recipeTest?.title));
  const titled = !!named1 && namesBefore.get(named1.id) !== named1.title;
  const newByRule = fromRule.realUrls.filter((_, i) => !listedBefore.has(fromRule.realIds[i]));
  const proven = result.recipe && recipeTest ? provenRecipe(result.recipe, recipeTest.by, { real: newByRule, captions: fromRule.captionUrls, title: titled ? recipeTest.title : '' }) : null;
  let saved = null;
  if (proven && (proven.rules.length || proven.title)) saved = await rememberRule(t, proven).then((s) => ({ ...s, what: proven.rules.length ? 'find' : 'name' })).catch(() => null);
  const real = [...new Set([...fromAi.real, ...fromRule.real])];
  t.aiResult = {
    summary: result.summary, advice: result.advice, candidates: result.candidates, recipe: result.recipe, recipeError: result.recipeError, recipeNote: result.recipeNote,
    recipeTest: recipeTest ? { urls: recipeTest.urls, title: recipeTest.title, captions: recipeTest.captions, log: recipeTest.log } : null,
    pages, refused,
    added: new Set([...fromAi.added, ...fromRule.added]).size,
    // Videos that answered as real ones (whoever named them), how many of them were not listed before, and caption files that hold captions.
    found: real.length,
    fresh: real.filter((id) => !listedBefore.has(id)).length,
    captions: fromAi.captions + fromRule.captions,
    named: titled ? named1.title : '',
    saved,
    via: res.via, at: Date.now(),
  };
  persistTab(tabId);
  return t.aiResult;
}

/**
 * "Ask AI why" on a failed download. Without `confirmed` nothing is sent and nothing is asked of the
 * file's server: the answer is { confirm }, what would be sent, to whom and at whose cost (lib/rescue.js:
 * whyConfirm), for the sheet the popup shows first. With it, the file's server is asked once for its
 * answer (status and headers) and one request goes to the AI account chosen in Settings.
 */
async function aiDiagnose(jobId, { confirmed = false } = {}) {
  await loadJobs();
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found');
  const settings = await getSettings();
  if (!aiReady(settings)) throw new Error(AI_OFF_FIND);
  if (confirmed !== true) {
    const known = buildDiagnosePrompt({ job, error: job.error, pageUrl: job.pageUrl, mediaUrl: job.mediaUrl, status: job.httpStatus || 0, headers: null });
    return { confirm: whyConfirm({ prompt: known, provider: settings.aiProvider, providerLabel: PROVIDER_LABELS[settings.aiProvider] || '' }) };
  }
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
    // @site-edition
    tryYtdlp: !!res.data?.try_ytdlp,
    // @end-site-edition
  };
  persistJobs(true);
  return job.diagnosis;
}

// What the last look at each caption track found missing (lib/captions.js: coverageNote), by the track's
// address, so the transcript made from it can say so. '' when the whole track was read.
const captionGaps = new Map();

/** Every piece of a segmented caption track, a few at a time (a three-hour lecture has thousands). */
async function captionPieces(m, segments) {
  const got = await readSegments(segments.map((seg) => seg.url), (url) => fetchText(url));
  if (captionGaps.size > 200) captionGaps.clear();
  captionGaps.set(m.url, coverageNote(got));
  return got.texts;
}

/**
 * Fetch captions for a media item (subtitle file, HLS subtitle playlist, or a stream's own subtitle track).
 * Of a stream's several tracks the one in your language, else the page's, else English, else the first
 * (`prefs`, see subPrefs: the order the subtitles saved inside a video are picked in).
 */
async function captionsFor(m, prefs = subPrefs(null)) {
  captionGaps.delete(m.url);
  if (m.kind === 'subtitle') {
    const text = await fetchText(m.url);
    return m.ext === 'srt' ? srtToVtt(text) : text;
  }
  if (m.kind === 'hls') {
    const pl = parseM3U8(await fetchText(m.url), m.url);
    let subUrl = null;
    if (pl.type === 'master') {
      subUrl = orderSubtitles(pl.subtitles.filter((s) => s.url), prefs)[0]?.url;
    } else if (m.mediaType === 'subtitle') subUrl = m.url;
    if (!subUrl) return null;
    const sp = await loadHlsMedia(subUrl);
    return mergeVttSegments(await captionPieces(m, sp.segments));
  }
  if (m.kind === 'dash') {
    const mpd = parseMPD(await fetchText(m.url), m.url);
    const s = orderSubtitles(mpd.subtitles, prefs)[0];
    if (!s || !/vtt/i.test(s.mimeType)) return null;
    const texts = await captionPieces(m, s.segments);
    return s.segments.length > 1 ? mergeVttSegments(texts) : texts[0];
  }
  return null;
}

/**
 * "Summarize". Without `confirmed` nothing is sent: the captions are read (from the page, as "Save
 * transcript" reads them) and the answer is { confirm }, what would be sent, to whom and at whose cost
 * (lib/rescue.js: summaryConfirm), for the sheet the popup shows first. With it, one request goes to the
 * AI account chosen in Settings.
 */
async function aiSummarize(tabId, mediaId, { confirmed = false } = {}) {
  const settings = await getSettings();
  // Checked before anything is read: without an AI account no captions are fetched.
  if (!aiReady(settings)) throw new Error(AI_OFF_FIND);
  const t = await getTab(tabId);
  // Found the way "Save transcript" finds them: the item's own, the page's caption file, or those next to its file.
  const { vtt, used, gaps } = await captionsOf(t, mediaId);
  const captionsText = captionsToText(vtt);
  const prompt = buildSummaryPrompt({ title: t.pageTitle, captionsText });
  if (confirmed !== true) {
    return { confirm: summaryConfirm({ prompt, provider: settings.aiProvider, providerLabel: PROVIDER_LABELS[settings.aiProvider] || '', condensed: prompt.condensed }) };
  }
  const res = await callAI(settings, prompt);
  const summary = normalizeSummary(res.data);
  const markdown = summaryToMarkdown(summary, t.pageUrl, { condensed: prompt.condensed });
  // A lecture too long to send whole was condensed, and captions that could not all be read have gaps: say so.
  const note = [prompt.condensed ? CONDENSED_NOTE : '', gaps].filter(Boolean).join(' ');
  return { summary, markdown, via: res.via, from: used?.url, note };
}

async function saveTextFile(filename, text, mime = 'text/markdown') {
  const settings = await getSettings();
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
  const folder = resolveFolder(settings.subfolder, { site: '', date: new Date().toISOString().slice(0, 10), kind: 'text' });
  const name = folder ? `${folder}/${filename}` : filename;
  return chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify' });
}

// ---------------------------------------------------------------- transcripts & study notes
// Text files that go with a video (its transcript, AI study notes, flashcards), saved where the video is.

// This copy has no study tools (transcribing on this computer is one of them).
const hasStudyTools = async () => false;

/** What to say when a video has no captions: transcription is named only where it can be done (lib/wording.js). */
async function noCaptionsText() {
  const helper = helperCache.value || await helperStatus().catch(() => null);
  return noCaptions({ studyTools: await hasStudyTools(), helper });
}

/**
 * The captions of one item, or of the first item on the page that has any (the way "Summarize" looks):
 * { vtt, used, local?, gaps }. `gaps` says in words what could not be read ('' when all of it was).
 */
async function captionsOf(t, mediaId) {
  const candidates = mediaId
    ? t.media.filter((x) => x.id === mediaId)
    : [...t.media.filter((x) => x.kind === 'subtitle'), ...t.media.filter((x) => x.info?.hasSubtitles)];
  for (const m of candidates) {
    // Same headers the stream itself was read with (nothing a click would add).
    await applyRefererRules([m.url], m.pageUrl || t.pageUrl).catch(() => {});
    const vtt = await captionsFor(m, subPrefs(t)).catch(() => null);
    // (Captions are something that was said: a file of picture addresses, or one with no words, is not.)
    if (hasWords(vtt)) return { vtt, used: m, gaps: captionGaps.get(m.url) || '' };
  }
  const item = mediaId ? t.media.find((x) => x.id === mediaId) : null;
  // The caption files that are this video's (lib/captions.js): the ones the page declared for it, or, on a
  // page with a single video, its separate caption files (<track>). The one in the user's language first,
  // and a .vtt before the .srt beside it.
  for (const sub of item ? captionFiles(t.media, item, subPrefs(t)) : []) {
    await applyRefererRules([sub.url], sub.pageUrl || t.pageUrl).catch(() => {});
    const vtt = await captionsFor(sub, subPrefs(t)).catch(() => null);
    if (hasWords(vtt)) return { vtt, used: item, gaps: '' }; // named after the video, saved next to it
  }
  throw new Error(await noCaptionsText());
}

/**
 * Where the files that go with a video are saved: the folder and base file name its download uses
 * (site rules, folder and name templates). No AI file name here: saving a transcript never calls AI.
 */
async function companionTarget(tabId, t, m, settings) {
  await loadJobs();
  const pageUrl = m.pageUrl || t.pageUrl;
  // Your own name > the lecture/episode name read from the page > the tab title.
  const info = !m.customName && !m.title ? await readVideoName(tabId, 0, m.url) : null;
  const title = m.customName || m.title || info?.name || t.pageTitle || m.hint || hostOf(m.url);
  // Already downloaded from here: sit next to that file, under exactly its name (quality and all).
  const done = [...jobs.values()].filter((j) => j.mediaId === m.id && j.base && j.status === 'done')
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
  if (done) return { title, pageUrl, base: done.base, folder: done.folder || '' };
  const course = sanitizeFilename((info ? info.course : m.course) || '', 80);
  const date = new Date().toISOString().slice(0, 10);
  const site = siteKey(pageUrl || m.url);
  const rules = rulesFor(settings, pageUrl || m.url);
  const base = buildFilename(rules.filenameTemplate, { title, quality: '', course, page: t.pageTitle || '', host: site, date, kind: m.kind }, '');
  return { title, pageUrl, base, folder: resolveFolder(rules.subfolder, { site, course, date, kind: m.kind }) };
}

// The folder Chrome's downloads land in, as a finished one showed it ('' until then).
let downloadsRoot = '';
/** Learn it from a saved file's full path and the subfolder that was asked for. */
function learnDownloadsRoot(savedPath, folder = '') {
  const dir = parentDir(savedPath);
  const sub = String(folder || '').replace(/^[\\/]+|[\\/]+$/g, '');
  if (!dir) return;
  if (!sub) downloadsRoot = dir;
  else if (dir.replace(/\\/g, '/').toLowerCase().endsWith(`/${sub.toLowerCase()}`)) downloadsRoot = dir.slice(0, dir.length - sub.length - 1);
}

// The longest path Chrome leaves alone (lib/plan.js), made tighter if it is ever seen to cut a shorter one.
let pathLimit = PATH_LIMIT;
/** How long a file's name may be in this subfolder of the downloads folder (Infinity while that folder is not known). */
const nameRoom = (folder) => pathRoom(downloadsRoot, folder, pathLimit);
/**
 * The name of a file that goes with a video (its transcript, study page, slides…): the video's own name
 * and the fixed ending for its kind, the name shortened where the whole path would otherwise be too long.
 * The one place such a name is made: for saving it, for finding it again, and for linking to it.
 */
const companionName = (target, kind, ext) => companionFilename(target.base, kind, ext, nameRoom(target.folder));

/** Wait for one of our own small text downloads to land; resolves to Chrome's record of it. */
async function downloadFinished(downloadId) {
  for (let i = 0; i < 150; i++) {
    const [d] = await chrome.downloads.search({ id: downloadId });
    if (d?.state === 'complete') return d;
    if (!d || d.state === 'interrupted') throw new Error(`The file could not be saved (${d?.error || 'the download stopped'}).`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Saving the file took too long. Look in your Downloads folder.');
}

/**
 * Save text files next to a video: `parts` is [{ kind, ext, text }] (names and extensions come from
 * companionFilename's fixed list). Returns { files: [{ kind, name, path, downloadId? }], note }.
 */
async function saveCompanions(target, parts, settings) {
  const files = [];
  // (A name is as long as its path allows: the title gives way, never the ending. ".study.html" is how a
  // file is known again. How long that is, is unknown until a download has shown where downloads land.)
  for (const p of parts) {
    // A half surrogate pair (text cut mid-character) would make encodeURIComponent throw.
    const text = p.url ? '' : typeof p.text.toWellFormed === 'function' ? p.text.toWellFormed() : p.text;
    // `p.url`: a file that is already made (a blob: address from the offscreen page: a study page, the slides file), saved as it is.
    const url = p.url || `data:${p.ext === 'md' ? 'text/markdown' : 'text/plain'};charset=utf-8,${encodeURIComponent(text)}`;
    for (let attempt = 0; ; attempt++) {
      const name = companionName(target, p.kind, p.ext);
      // `p.overwrite`: a study pack made again replaces its own files (its guide links to the study page by name).
      const downloadId = await chrome.downloads.download({ url, filename: target.folder ? `${target.folder}/${name}` : name, conflictAction: p.overwrite ? 'overwrite' : 'uniquify' });
      const d = await downloadFinished(downloadId);
      learnDownloadsRoot(d.filename, target.folder);
      if (keptSuffix(d.filename, name) || attempt >= 1) {
        files.push({ kind: p.kind, path: d.filename, downloadId });
        break;
      }
      // Chrome cut the name after all (where downloads land was not known yet), and its ending with it:
      // that file is taken back, and saved again under a title short enough. What Chrome left of the
      // path is the most it allows.
      await chrome.downloads.removeFile(downloadId).catch(() => {});
      chrome.downloads.erase({ id: downloadId }).catch(() => {});
      pathLimit = Math.min(pathLimit, String(d.filename).length);
    }
  }
  let note = '';
  // `target.dir`: the folder of a video found on this computer; its files go right next to it.
  const dest = target.dir || settings.saveFolder;
  if (dest) {
    // Chrome can only save inside Downloads; the helper moves the files to your folder, as it does for videos.
    const helper = await helperStatus(true);
    if (!helper.ok) note = 'Saved in Downloads: moving to your chosen folder needs the local helper.';
    else {
      try {
        const replace = parts.length > 0 && parts.every((p) => p.overwrite);
        const res = await helperRequest({ type: 'move', files: files.map((f) => f.path), dest, subfolder: target.dir ? '' : target.folder || '', replace }, { timeoutMs: 60000 });
        files.forEach((f, i) => {
          if (!res.moved?.[i]) return;
          f.path = res.moved[i];
          delete f.downloadId; // Chrome's entry now points at the old location
        });
      } catch (e) {
        note = `Couldn't move to ${dest} (${e.message}); left in Downloads.`;
      }
    }
  }
  return { files: files.map((f) => ({ ...f, name: f.path.split(/[\\/]/).pop() })), note };
}

/** Captions → the transcript file, saved at `target` ({ title, pageUrl, base, folder, dir? }). `gaps`: what could not be read, in words. */
async function writeTranscript(target, vtt, settings, gaps = '') {
  const out = buildTranscript(vtt, { title: target.title, format: settings.transcriptFormat, sourceUrl: isHttpUrl(target.pageUrl) ? target.pageUrl : '' });
  if (!out.paragraphs) throw new Error('These captions have no words in them, so there is nothing to save.');
  const saved = await saveCompanions(target, [{ kind: 'transcript', ext: out.ext, text: out.text }], settings);
  return { title: target.title, paragraphs: out.paragraphs, ...saved, note: [saved.note, gaps].filter(Boolean).join(' ') };
}

/** "Save transcript": the item's captions as a readable text file. No AI, nothing sent anywhere. */
async function saveTranscript(tabId, mediaId) {
  const settings = await getSettings();
  const t = await getTab(tabId);
  await refreshTabInfo(tabId, t);
  const { vtt, used, local, gaps } = await captionsOf(t, mediaId);
  void local;
  const target = await companionTarget(tabId, t, used, settings);
  return writeTranscript(target, vtt, settings, gaps);
}

/** Is an AI account chosen and complete (a key where one is needed)? */
const aiReady = (s) => ['subscription', 'chatgpt'].includes(s.aiProvider) || (s.aiProvider === 'api' && !!s.apiKey)
  || (s.aiProvider === 'openai' && !!s.openaiKey) || (s.aiProvider === 'gemini' && !!s.geminiKey)
  || (s.aiProvider === 'deepseek' && !!s.deepseekKey) || (s.aiProvider === 'openrouter' && !!s.openrouterKey && !!s.openrouterModel);


// ---------------------------------------------------------------- what has been made from a lecture
// The popup's path and its five squares say what exists for each video: a transcript, a study page, a
// reading edition, a study pack, cards. It is remembered here under the video's own keys (as your marks
// are), so it is still known next week, on a fresh link, and with the job list cleared.

const MADE_KEY = 'sp:made'; // media key -> { at, transcript, page, read, guide, deck }: where each file was saved
const MADE_MAX = 3000;
let madeWrites = Promise.resolve(); // one after another: two files saved together must not lose each other's note
// Read once and kept (the popup asks every second or two); read again after anything changes it.
let madeSeen = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[MADE_KEY]) madeSeen = null;
});
async function madeIndex() {
  if (!madeSeen) madeSeen = (await chrome.storage.local.get(MADE_KEY))[MADE_KEY] || {};
  return madeSeen;
}

/** The keys a video's record is kept under: the item's own when its page is still open, else those its download kept. */
async function madeKeys(tabId, mediaId, fallback = []) {
  const t = tabId != null && mediaId ? await getTab(tabId).catch(() => null) : null;
  const m = t?.media.find((x) => x.id === mediaId);
  return (m ? markKeys(m) : fallback || []).filter(Boolean).slice(0, 12);
}

/** Remember that something was made for the video with these keys. `patch`: { transcript?, page?, read?, guide?, deck? } (empty values are left out). */
function noteMade(keys, patch) {
  const fresh = Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => typeof v === 'string' && v));
  if (!keys?.length || !Object.keys(fresh).length) return madeWrites;
  madeWrites = madeWrites.then(async () => {
    const made = { ...(await madeIndex()) };
    const before = keys.map((k) => made[k]).find(Boolean) || {};
    const next = { ...before, ...fresh, at: Date.now() };
    for (const k of keys) made[k] = next;
    const all = Object.keys(made);
    if (all.length > MADE_MAX) all.sort((a, b) => made[a].at - made[b].at).slice(0, all.length - MADE_MAX).forEach((k) => delete made[k]);
    await chrome.storage.local.set({ [MADE_KEY]: made });
    madeSeen = made;
  }).catch(() => {});
  return madeWrites;
}


const noteMadeFor = async (tabId, mediaId, patch, fallback) => noteMade(await madeKeys(tabId, mediaId, fallback), patch);


/**
 * What exists for each video of a tab, for the popup: m.made = { transcript, page, read, guide, deck, cards, due }
 * (true where a file was saved; `cards`: the flashcards its pack made, `due`: how many are due today), or null.
 */
async function attachMade(t) {
  await madeWrites;
  const made = await madeIndex();
  for (const m of t.media) {
    const rec = markKeys(m).map((k) => made[k]).find(Boolean);
    if (!rec) {
      m.made = null;
      continue;
    }
    const [cards, due] = [0, 0]; // (no flashcards in this copy)
    m.made = { transcript: !!rec.transcript, page: !!rec.page, read: !!rec.read, guide: !!rec.guide, cheat: !!rec.cheat, deck: cards ? rec.deck : '', cards, due };
  }
}
// ---------------------------------------------------------------- messages

/** Ids of the page's files as a message carries them (the popup's "these sit in the page's footer or menu"): strings only, and not endlessly many. */
const docIds = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.length <= 40).slice(0, 300) : []);

const handlers = {
  async getTabState({ tabId, panel = false, links = true }) {
    await loadJobs();
    await refreshDirectProgress();
    const t = await getTab(tabId);
    await refreshTabInfo(tabId, t);
    // StreamSnag is open on this tab: only now are the files its page links to asked whether they are files.
    // (`links: false`: a lookup made from another page, the study desk's, opens nothing on this tab.)
    // (And what a rule found on a server the page had not contacted: see useRuleResult.)
    // (And the players and files of the page that waited to be asked about: askHeld.)
    let checking = 0;
    if (links !== false) {
      const players = askHeld(tabId, t);
      if (players) await Promise.race([players, new Promise((resolve) => { setTimeout(resolve, 1200); })]);
      checking = checkLinks(tabId, t) + checkHeld(tabId, t) + (asking.get(tabId) || 0);
    }
    const settings = await getSettings();
    const recipe = t.pageUrl ? await recipeForUrl(t.pageUrl) : null;
    // The page's menu asked for "Ask your AI to find it": the popup opens on the sheet that says what would be sent (once).
    const askAi = links !== false && !!t.askAi && Date.now() - t.askAi < 30000;
    if (links !== false && t.askAi) t.askAi = 0;
    const allJobs = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    await loadLibrary();
    if (Date.now() - library.at > 60000) scanLibrary().catch(() => {});
    const { history = [], marks = {} } = await chrome.storage.local.get(['history', 'marks']);
    coverEntries(t);
    attachLibrary(t, history, marks);
    checkSavedFiles(t, history).catch(() => {});
    await attachMade(t).catch(() => {}); // what has been made from each video, for the path and the squares
    pumpQueue(); // in case the worker restarted with downloads waiting
    if (settings.showDocuments !== false) await pruneDocFrames(tabId, t);
    // The sidebar lists what is in your folders (newest first), marking the files this page's videos matched.
    const matched = new Set(t.media.map((m) => m.library?.path?.toLowerCase()).filter(Boolean));
    const files = panel
      ? [...(library.files || [])].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0)).slice(0, 2000)
        .map((f) => ({ path: f.path, name: f.name, size: f.size, duration: f.duration || 0, at: f.mtimeMs || 0, here: matched.has(f.path.toLowerCase()) }))
      : undefined;
    const media = listSort(visibleMedia(t), t.media.map((m) => m.id));
    return {
      // Linked files still being looked at (lib/linked.js): while this is not 0 the list is worth reading again.
      // `left`: media links on the page that are not looked at at all (past the limit), so the popup can say so.
      // `naming`: listed items that have not been named from the page yet (nameSoon): the list is there, its course is not.
      links: { checking, left: linksLeftOut(t.links), naming: links !== false ? naming.get(tabId) || 0 : 0 },
      playing: media.length > 1 ? await playingIn(tabId, media.filter((m) => !m.dismissed)).catch(() => null) : null,
      library: {
        at: library.at, count: library.files?.length || 0, dirs: library.dirs || [], scanning: !!libraryScan,
        pending: library.pending || 0, error: library.error || '', extra: settings.libraryFolders || [],
        downloads: settings.checkDownloads !== false, files,
      },
      // (`lectures`: how many pages of single lectures a page with no video lists, as the page itself was read to say.)
      // (`inPieces`: what plays here comes only in pieces that are never listed, see handleResponse.)
      page: { url: t.pageUrl, title: t.pageTitle, site: t.pageUrl ? siteKey(t.pageUrl) : '', lectures: t.lectures || 0, inPieces: !!t.inPieces },
      media,
      // The order the items were found in, which is the order they are on the page (the review sheet lists by it).
      order: t.media.map((m) => m.id),
      // Documents linked on the page ("Files on this page"); never part of `media`.
      docs: settings.showDocuments !== false ? docsOf(tabId, t) : [],
      removedCount: t.media.filter((m) => m.dismissed).length,
      // Playlist entries shown through the stream card you played (for the playlist's counts).
      coveredEntries: t.media.filter((m) => m.covered && !m.dismissed).map((m) => ({ id: m.id, parentId: m.parentId, covered: m.covered, title: m.title })),
      jobs: allJobs.filter((j) => j.tabId === tabId || ['running', 'recording', 'muxing', 'queued'].includes(j.status)).slice(0, 40).map(publicJob),
      aiResult: t.aiResult,
      askAi,
      // The rule in use on this site: your own, or one that ships with StreamSnag.
      rule: recipe ? { site: recipe.site, builtin: !!recipe.builtin } : null,
      ai: { provider: settings.aiProvider, configured: ['subscription', 'chatgpt'].includes(settings.aiProvider) || (settings.aiProvider === 'api' && !!settings.apiKey) || (settings.aiProvider === 'openai' && !!settings.openaiKey) || (settings.aiProvider === 'gemini' && !!settings.geminiKey) || (settings.aiProvider === 'deepseek' && !!settings.deepseekKey) || (settings.aiProvider === 'openrouter' && !!settings.openrouterKey && !!settings.openrouterModel) },
      preferredQuality: settings.preferredQuality, // the quality the big card and "Download all" pick first
      // Copies, previews and short clips are not folded away in the list: Settings ("Always show everything"), or "Show" on this page.
      foldOff: settings.showEverything === true || !!t.foldOpen,
      saveRoot: saveRoot(settings, !!helperCache.value?.ok), // where downloads land, for "Saved to Downloads › …"
      helper: helperCache.value,
      review: { due: 0, decks: 0 },
    };
  },
  inspect: ({ tabId, mediaId }) => inspectCached(tabId, mediaId).catch((e) => { throw inPlainWords(e); }),
  download: ({ tabId, mediaId, optionId }) => enqueueDownload(tabId, mediaId, optionId),
  // @site-edition
  listPlaylist: ({ tabId, mediaId }) => listPlaylist(tabId, mediaId),
  // @end-site-edition
  downloadMissing: ({ tabId, mediaId }) => downloadMissing(tabId, mediaId),
  downloadDocs: ({ tabId }) => downloadDocs(tabId),
  downloadMany: ({ tabId, mediaIds, names, docIds }) => downloadMany(tabId, mediaIds, names, docIds),
  planDownloads: ({ tabId, mediaIds, names }) => planDownloads(tabId, mediaIds, names),
  toolVersions: () => helperRequest({ type: 'toolVersions' }, { timeoutMs: 60000 }),
  // @site-edition
  updateYtdlp: () => helperRequest({ type: 'updateYtdlp' }, { timeoutMs: 6 * 60 * 1000 }),
  // @end-site-edition
  cancelJob: ({ jobId }) => cancelJob(jobId),
  convert: ({ tabId, path, mode, title }) => startConvert(tabId, { path, mode, title }),
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
  aiFind: ({ tabId, confirmed }) => aiFind(tabId, { confirmed: confirmed === true }),
  undoRule: ({ tabId }) => undoRule(tabId),
  aiDiagnose: ({ jobId, confirmed }) => aiDiagnose(jobId, { confirmed: confirmed === true }),
  aiSummarize: ({ tabId, mediaId, confirmed }) => aiSummarize(tabId, mediaId, { confirmed: confirmed === true }),
  async saveSummary({ markdown, title }) {
    await saveTextFile(`${sanitizeFilename(title || 'summary', 100)} - summary.md`, markdown);
    return { ok: true };
  },
  async saveTranscript({ tabId, mediaId }) {
    const saved = await saveTranscript(tabId, mediaId);
    await noteMadeFor(tabId, mediaId, { transcript: saved.files?.[0]?.path });
    return saved;
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
  panelBehavior: async () => ({ ...(await applyPanelBehavior()), popup: await chrome.action.getPopup({}), behavior: await chrome.sidePanel?.getPanelBehavior?.().catch(() => null) }),
  // "Remove from list" for anything that is still a duplicate or just not wanted.
  // "Show" on the list's folded line: copies, previews and short clips are listed on this page (and counted).
  async showFolded({ tabId }) {
    const t = await getTab(tabId);
    t.foldOpen = true;
    persistTab(tabId);
    updateBadge(tabId);
    return { ok: true };
  },
  async dismissMedia({ tabId, mediaId }) {
    const t = await getTab(tabId);
    // (A video that comes in several files goes as a whole: its other files must not take its place.)
    for (const m of t.media) if (m.id === mediaId || m.variantOf === mediaId) Object.assign(m, { dismissed: true, hidden: true });
    persistTab(tabId);
    return { ok: true };
  },
  async restoreMedia({ tabId }) {
    const t = await getTab(tabId);
    for (const m of t.media) {
      if (m.dismissed) {
        m.dismissed = false;
        m.hidden = keysOf(m).some((k) => isStreamPart(t, k));
      }
    }
    persistTab(tabId);
    return { ok: true };
  },
  async renameMedia({ tabId, mediaId, name }) {
    const t = await getTab(tabId);
    const m = t.media.find((x) => x.id === mediaId);
    if (!m) throw new Error('That item is gone. Reload the page.');
    setCustomName(m, name);
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
  // @site-edition
  ytdlp: ({ tabId, url, mediaId }) => startYtdlp(tabId, { url, mediaId }),
  // @end-site-edition
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  // Web pages (through content scripts) may only report what they found. Everything else — downloads, the
  // helper, folders, settings — is for StreamSnag's own pages (popup, sidebar, settings, offscreen).
  const fromExtension = sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));

  // A content script asking which file types count as documents (it can't import lib/files.js itself).
  if (msg.type === 'docTypes') {
    sendResponse({ exts: DOC_EXTS });
    return false;
  }

  // Content script reports.
  if (msg.type === 'contentMedia' && sender.tab) {
    const tabId = sender.tab.id;
    (async () => {
      const t = await getTab(tabId);
      const isTop = sender.frameId === 0; // from Chrome, not from what the page claims
      if (isTop && typeof msg.pageTitle === 'string' && msg.pageTitle) t.pageTitle = msg.pageTitle.slice(0, 300); // (a page chooses it: kept short)
      if (isTop && typeof msg.pageLang === 'string') t.pageLang = msg.pageLang.slice(0, 20);
      if (isTop) t.lectures = Number.isInteger(msg.lectures) && msg.lectures > 0 ? Math.min(msg.lectures, 999) : 0;
      if (Array.isArray(msg.docs)) noteDocs(tabId, t, sender.frameId || 0, msg.docs);
      const words = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
      // A playlist written into the page: every lecture, under its own name, with its files and captions.
      // (First: its lectures are then known when the page's links to the same files are looked at.)
      if (Array.isArray(msg.lists)) await addPlaylists(tabId, t, msg.lists, sender.url || t.pageUrl).catch(() => {});
      // Video and sound files the page only links to: nothing is asked of them while the page is merely
      // open (no request the page did not make itself). They wait as candidates, out of the list and the
      // toolbar's count, until StreamSnag is opened on the tab (checkLinks).
      if (!t.pageUrl) await refreshTabInfo(tabId, t);
      const frame = sender.frameId || 0;
      t.links = noteLinks(t.links, frame, (msg.items || []).filter((it) => it?.linked && classifyUrl(it.url)?.kind === 'direct'), msg.linksLeft);
      if (t.links[frame] && !isTop) t.links[frame].frameUrl = words(msg.frameUrl, 2000);
      for (const it of msg.items || []) {
        if (it.embed) {
          resolveEmbed(tabId, it).catch(() => {});
          continue;
        }
        if (it.linked) continue;
        let info = classifyUrl(it.url);
        if (!info && it.mediaType === 'subtitle') info = { kind: 'subtitle', mediaType: 'subtitle', ext: 'vtt', size: null, contentType: '' };
        if (!info && /mpegurl/i.test(it.contentType || '')) info = { kind: 'hls', mediaType: 'stream', ext: 'm3u8', size: null, contentType: it.contentType };
        if (!info) continue;
        // One unreadable item must not stop the rest of the report: the last item is often the one that
        // matters, and it used to be dropped whenever an earlier addMedia threw.
        try {
          await addMedia(tabId, {
            ...info, url: it.url, source: 'page', poster: it.poster, duration: it.duration, lang: words(it.lang, 20), label: words(it.label, 200),
            frameUrl: isTop ? '' : words(msg.frameUrl, 2000), group: words(it.group, 2100), height: Number(it.height) > 0 ? Number(it.height) : 0, quality: words(it.quality, 80), reportedBy: frame,
          });
        } catch { /* skip this item, keep the rest */ }
      }
      // A video kept from the page left behind (the address changed without a load) goes once this frame
      // no longer has it: its player was replaced, or plays something else now (lib/pagechange.js).
      const have = new Set((msg.items || []).filter((it) => typeof it?.url === 'string').map((it) => dedupeKey(it.url)));
      const gone = leftBehind(t.media, frame, have, new Set((Array.isArray(msg.blobs) ? msg.blobs : []).filter((s) => typeof s === 'string')));
      if (gone.length) {
        t.media = t.media.filter((m) => !gone.includes(m));
        t.left = [...(t.left || []), ...gone].slice(-60);
      }
      persistTab(tabId);
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
        noteProgress(job);
        persistJobs();
      } else if (msg.type === 'trackError') {
        if (!msg.canceled && tr?.role === 'subtitle' && job.tracks.some((x) => x.role !== 'subtitle')) {
          // Subtitles are an extra: a video is not thrown away because its captions would not load.
          tr.status = 'skipped';
          persistJobs(true);
          runNextTrack(job.id).catch((e) => failJob(job.id, e.message));
        } else {
          failJob(job.id, msg.error, { canceled: msg.canceled, status: msg.status });
        }
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
    // (`code`: a reason the popup can go by where the worker has one, e.g. 'not-a-stream'.)
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e), ...(e.code ? { code: e.code } : {}), ...(e.pro ? { pro: e.pro } : {}) }));
  return true;
});

// ---------------------------------------------------------------- context menus & install

// "Open StreamSnag in the sidebar" (Settings, or "Always open here" in the sidebar): the toolbar icon opens
// the side panel at once instead of the popup. Without a popup to show, the browser opens the panel itself.
async function applyPanelBehavior() {
  const on = (await getSettings()).sidebarOnClick === true;
  await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: on }).catch(() => {});
  await chrome.action.setPopup({ popup: on ? '' : 'popup.html' }).catch(() => {});
  return { on };
}
chrome.runtime.onStartup?.addListener(() => {
  applyPanelBehavior().catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings && changes.settings.oldValue?.sidebarOnClick !== changes.settings.newValue?.sidebarOnClick) applyPanelBehavior().catch(() => {});
  if (area === 'local' && changes.settings) {
    showEverything = changes.settings.newValue?.showEverything === true;
    for (const id of tabs.keys()) updateBadge(id);
  }
});
applyPanelBehavior().catch(() => {});


chrome.runtime.onInstalled.addListener(async (details) => {
  applyPanelBehavior().catch(() => {});
  chrome.contextMenus.removeAll(() => {
    // The toolbar icon's own menu (right-click on it).
    chrome.contextMenus.create({ id: 'ss-media', title: 'Download this media with StreamSnag', contexts: ['video', 'audio'] });
    chrome.contextMenus.create({ id: 'ss-ai', title: 'Ask your AI to find the video on this page', contexts: ['page', 'video', 'frame'] });
    // @site-edition
    chrome.contextMenus.create({ id: 'ss-ytdlp', title: 'Download this page with yt-dlp (local helper)', contexts: ['page', 'video'] });
    // @end-site-edition
  });
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(() => {});
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
      if (!m) {
        // (One piece of a stream: the stream itself is in the list.)
        chrome.action.openPopup?.().catch(() => notify('Stream found', 'Open the StreamSnag popup to choose a quality.'));
      } else if (m.kind === 'direct') {
        await startDownload(tab.id, m.id, 'file');
      } else {
        chrome.action.openPopup?.().catch(() => notify('Stream found', 'Open the StreamSnag popup to choose a quality.'));
      }
    } else if (info.menuItemId === 'ss-ai') {
      // Nothing is sent from here: StreamSnag opens on the sheet that says what would be sent, and to whom.
      const t = await getTab(tab.id);
      t.askAi = Date.now();
      persistTab(tab.id);
      chrome.action.openPopup?.().catch(() => notify('StreamSnag', 'Click the StreamSnag button to see what would be sent to your AI before anything is.'));
    // @site-edition
    } else if (info.menuItemId === 'ss-ytdlp') {
      await startYtdlp(tab.id);
      notify('yt-dlp started', 'Progress is shown in the StreamSnag popup.');
    // @end-site-edition
    }
  } catch (e) {
    notify('StreamSnag', e.message);
  }
});

chrome.notifications?.onClicked.addListener((id) => {
  if (id.startsWith('done:')) chrome.downloads.showDefaultFolder();
});


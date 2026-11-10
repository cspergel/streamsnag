import { formatBytes, formatDuration, hostOf, ytdlpCommand, ffmpegCommand, rankVideoOptions, isHttpUrl } from './lib/util.js';
import { sameItem } from './lib/match.js';
import { docStatus } from './lib/files.js';

const $ = (sel) => document.querySelector(sel);
// The same page runs as the toolbar popup and (with ?view=panel) as Chrome's side panel.
const PANEL = new URLSearchParams(location.search).get('view') === 'panel';
let tabId = null;
let windowId = null;
let state = null;
let history = [];
const openMedia = new Map(); // mediaId -> {loading, options, error, menu, renaming, all: the list of formats is open}
const heroPick = new Map(); // mediaId -> the quality chosen on the big card
const expanded = new Set(); // keys of names the user clicked to show in full
let aiBusy = false;
let summaryState = null; // {loading} | {result} | {error}
let pollTimer = null;
let filter = 'all'; // 'all' | 'new' | 'done'
let activeFilter = 'all'; // the filter in effect (a remembered one waits while a page has under two videos)
let sortBy = 'default'; // see SORTS
let query = ''; // search box on the list
let searchOpen = false; // the search + sort row
let subsOpen = false; // the collapsed "Subtitle files" group
let docsOpen = false; // the collapsed "Files on this page" group
let folderQuery = '';
let setupLater = 0;
let heroId = null; // the video on the big card
let heroWhy = ''; // 'playing' | 'paused' | '' (it is just the newest)
let helperKnown = null; // was the helper installed the last time we heard? (true | false | null)
let setupShown = null; // decided once per page, so the card never appears under your pointer
try {
  filter = localStorage.getItem('ss-filter') || 'all';
  sortBy = localStorage.getItem('ss-sort') || 'default';
  subsOpen = localStorage.getItem('ss-subs') === '1';
  docsOpen = localStorage.getItem('ss-docs') === '1';
  searchOpen = localStorage.getItem('ss-search') === '1';
  setupLater = Number(localStorage.getItem('ss-setup-later')) || 0;
  helperKnown = { 1: true, 0: false }[localStorage.getItem('ss-helper')] ?? null;
} catch { /* storage unavailable */ }
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

/** Tiny DOM builder — always uses textContent, never innerHTML, so page titles can't inject markup. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Inline stroke icons (24×24 grid), built as SVG elements. */
function svg(...shapes) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of shapes) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    s.append(e);
  }
  return s;
}
const ICON = {
  download: () => svg(['path', { d: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14' }]),
  check: () => svg(['path', { d: 'M5 12.5 9.5 17 19 7.5' }]),
  play: () => svg(['path', { d: 'M9 6.5 17.5 12 9 17.5Z' }]),
  list: () => svg(['path', { d: 'M5 7h10M5 12h10M5 17h6M18 14v6l3-3Z' }]),
  folder: () => svg(['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }]),
  more: () => svg(['circle', { cx: 12, cy: 5.5, r: 1.6 }], ['circle', { cx: 12, cy: 12, r: 1.6 }], ['circle', { cx: 12, cy: 18.5, r: 1.6 }]),
};

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, tabId, ...payload });
  if (!res?.ok) throw new Error(res?.error || 'Something went wrong');
  return res.data;
}

function banner(text, isError = false) {
  const b = $('#banner');
  if (!text) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  b.className = `banner${isError ? ' err' : ''}`;
  b.textContent = text;
  clearTimeout(banner.t);
  banner.t = setTimeout(() => { b.hidden = true; }, isError ? 9000 : 4000);
}

async function copy(text, what = 'Copied') {
  await navigator.clipboard.writeText(text);
  banner(`${what} to clipboard`);
}

// ------------------------------------------------------------------ long names

/**
 * A one-line name that scrolls across on hover/focus when it doesn't fit, shows the full text as a
 * tooltip, and wraps onto several lines when clicked.
 */
function nameEl(text, key, cls = 'title', wrap = false) {
  // `wrap`: the big card has room for two lines, so its name wraps instead of scrolling.
  const el = h('div', {
    class: `${cls} ${wrap ? 'clamp' : 'marquee'}${expanded.has(key) ? ' expanded' : ''}`,
    title: text,
    tabindex: '0',
    onclick: (e) => {
      e.stopPropagation();
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      el.classList.toggle('expanded');
      fitMarquee(el);
    },
    onkeydown: (e) => { if (e.key === 'Enter') el.click(); },
  }, h('span', {}, text));
  return el;
}

function fitMarquee(el) {
  if (el.classList.contains('clamp')) {
    // Two lines; "overflow" means there is more to read, and a click shows (or folds) all of it.
    if (!el.classList.contains('expanded')) el.classList.toggle('overflow', el.scrollHeight - el.clientHeight > 2);
    return;
  }
  const inner = el.firstElementChild;
  const overflow = el.classList.contains('expanded') ? 0 : inner.scrollWidth - el.clientWidth;
  el.classList.toggle('overflow', overflow > 2);
  if (overflow > 2) {
    el.style.setProperty('--shift', `-${overflow + 8}px`);
    el.style.setProperty('--dur', `${Math.max(1, overflow / 75).toFixed(1)}s`); // ~75 px/s
  }
}

function fitAll(root = document) {
  root.querySelectorAll('.marquee, .clamp').forEach(fitMarquee);
}

/**
 * Replace list items only when they actually changed, so a name that is scrolling under the mouse
 * isn't reset by the background refresh every couple of seconds.
 */
function patchList(ul, items, keyOf, sigOf, build) {
  const old = new Map([...ul.children].map((el) => [el.dataset.key, el]));
  const next = items.map((it) => {
    const key = keyOf(it);
    const sig = sigOf(it);
    const prev = old.get(key);
    if (prev && prev.dataset.sig === sig) return prev;
    const el = build(it);
    el.dataset.key = key;
    el.dataset.sig = sig;
    return el;
  });
  const same = next.length === ul.children.length && next.every((el, i) => ul.children[i] === el);
  if (same) return;
  if (next.length === ul.children.length && next.every((el, i) => el.dataset.key === ul.children[i].dataset.key)) {
    next.forEach((el, i) => { if (ul.children[i] !== el) ul.children[i].replaceWith(el); });
  } else {
    ul.replaceChildren(...next);
  }
  next.forEach((el) => { if (!old.has(el.dataset.key) || old.get(el.dataset.key) !== el) fitAll(el); });
}

// ------------------------------------------------------------------ downloaded / not downloaded

const ACTIVE = ['running', 'recording', 'muxing'];

/** What happened to this media item: 'active' | 'done' | 'missing' | 'failed' | 'new'. */
function statusFor(m) {
  const mine = (state.jobs || []).filter((j) => sameItem(m, j));
  if (mine.some((j) => ACTIVE.includes(j.status))) return 'active';
  if (mine.some((j) => j.status === 'queued')) return 'queued';
  // A listed playlist is downloaded when every video in it is.
  if (m.playlist && m.listed && m.mark !== 'new') {
    const { total, missing } = playlistEntries(m);
    if (total && !missing) return 'done';
  }
  // You marked it yourself: that beats any guess below.
  if (m.mark === 'done') return 'done';
  if (m.mark === 'new') return 'new';
  // The folder scan has the final word: found (even renamed) or gone.
  if (m.library?.path && !m.library.missing) return 'done';
  if (m.library?.missing) return 'missing';
  if (mine.some((j) => j.status === 'done') || history.some((x) => sameItem(m, x))) return 'done';
  if (mine.some((j) => j.status === 'error')) return 'failed';
  return 'new';
}

/** The running or waiting download of this item, if any. */
function jobFor(m) {
  return (state.jobs || []).find((j) => sameItem(m, j) && ACTIVE.includes(j.status))
    || (state.jobs || []).find((j) => sameItem(m, j) && j.status === 'queued');
}

/** How far along a download is: {pct 0–100, indeterminate}. */
function jobProgress(j) {
  const p = j.progress || {};
  let pct = 0;
  if (p.percent) pct = p.done;
  else if (p.total) pct = Math.min(100, (p.done / p.total) * 100);
  const indeterminate = ACTIVE.includes(j.status) && (j.status === 'muxing' || j.status === 'recording' || !(p.total || p.percent));
  return { pct: Math.max(0, Math.min(100, pct || 0)), indeterminate };
}

const STATUS_TAG = {
  active: ['Downloading…', 'st-active'],
  queued: ['Queued', 'st-active'],
  done: ['Downloaded', 'st-done'],
  failed: ['Failed', 'st-failed'],
  missing: ['File not in folder', 'st-failed'],
  new: ['Not downloaded', 'st-new'],
};

/** "Downloading 42%", "Merging…": the short status of a running download. */
function activeText(j) {
  if (!j) return 'Downloading…';
  if (j.status === 'queued') return 'Queued';
  if (j.status === 'recording') return 'Recording live';
  if (j.status === 'muxing') return 'Merging…';
  const { pct, indeterminate } = jobProgress(j);
  return indeterminate ? 'Downloading…' : `Downloading ${Math.round(pct)}%`;
}

/** The same for the big card, in full sentences. */
function heroBusyText(j) {
  if (!j) return 'Downloading…';
  if (j.status === 'queued') return 'Queued: starts when a download finishes';
  if (j.status === 'recording') return 'Recording live…';
  if (j.status === 'muxing') return 'Merging video and audio…';
  const { pct, indeterminate } = jobProgress(j);
  return indeterminate ? 'Downloading…' : `Downloading ${Math.round(pct)}%`;
}

function stTag(st, m) {
  let [text, cls] = STATUS_TAG[st];
  if ((st === 'active' || st === 'queued') && m) text = activeText(jobFor(m));
  return h('span', { class: `st ${cls}` }, st === 'done' ? ICON.check() : null, h('span', { class: 'st-text' }, text));
}

/**
 * Move a card's progress bar and percentage without rebuilding the card, so a rename you are typing,
 * a name scrolling under the pointer or a click on Cancel isn't lost on every tick.
 */
function paintProgress(card, m) {
  const j = jobFor(m);
  if (!j) return;
  const { pct, indeterminate } = jobProgress(j);
  const moving = indeterminate && j.status !== 'queued';
  const busy = card.querySelector('.hero-state.busy');
  if (busy) {
    busy.classList.toggle('indeterminate', moving);
    busy.querySelector('.fill').style.width = moving ? '' : `${pct}%`;
    const text = busy.querySelector('.busy-text');
    const next = heroBusyText(j);
    if (text.textContent !== next) text.textContent = next;
  }
  const bar = card.querySelector('.row .progress');
  if (bar) {
    bar.classList.toggle('indeterminate', moving);
    bar.firstElementChild.style.width = moving ? '' : `${pct}%`;
  }
  const tag = card.querySelector('.st-active .st-text');
  const next = activeText(j);
  if (tag && tag.textContent !== next) tag.textContent = next;
}

function showFile(last) {
  send('openFile', { downloadId: last.downloadId ?? null, path: last.file || null }).catch((e) => banner(e.message, true));
}

function lastDownload(m) {
  if (m.library?.how === 'manual') return { at: 0, file: '', how: 'manual' };
  if (m.library?.path && !m.library.missing) {
    const j = (state.jobs || []).find((x) => sameItem(m, x) && x.status === 'done');
    const hx = history.find((x) => sameItem(m, x));
    return { at: j?.finishedAt || hx?.at || 0, file: m.library.path, how: m.library.how };
  }
  const j = (state.jobs || []).find((x) => sameItem(m, x) && x.status === 'done');
  if (j) return { at: j.finishedAt, file: j.outputs?.[0]?.path || j.filename, downloadId: j.outputs?.find((o) => o.downloadId != null)?.downloadId };
  const hx = history.find((x) => sameItem(m, x));
  return hx ? { at: hx.at, file: hx.files?.[0] } : null;
}

function ago(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop();

function renderFilters(counts, total) {
  const box = $('#filters');
  box.hidden = total < 2;
  const chips = [['all', 'All', total], ['new', 'Not downloaded', counts.new + counts.failed + counts.missing], ['done', 'Downloaded', counts.done]];
  box.replaceChildren(...chips.map(([id, label, n]) => h('button', {
    class: `chip${activeFilter === id ? ' on' : ''}`, 'aria-pressed': String(activeFilter === id),
    onclick: () => {
      filter = id;
      activeFilter = id;
      remember('ss-filter', id);
      render();
    },
  }, label, h('span', { class: 'n' }, String(n)))));
}

// ------------------------------------------------------------------ media list

const HOW_FOUND = {
  manual: 'you marked it as downloaded',
  id: "a file with this video's id in its name",
  name: "a file with this video's name (and no different length)",
  renamed: 'found under a new name (same file size)',
  size: 'a file of exactly the same size is already there',
  length: 'a video of exactly the same length is already there',
};

const NAME_SOURCE = {
  player: "from the player's label",
  list: 'from the highlighted lesson in the page',
  heading: 'from the heading by the video',
  structured: "from the page's video data",
  title: 'from the tab title',
  embed: "from the video service's own title",
};

/** A steady tint per item, so neighbouring tiles are told apart without technical labels. */
function tintOf(id) {
  let n = 0;
  for (const c of String(id)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % 4;
}

function thumbFor(m) {
  if (m.kind === 'subtitle') return h('div', { class: 'thumb subtitle' }, 'CC');
  const dur = m.playlist ? '' : formatDuration(m.info?.duration || m.duration);
  // Without a preview image the tile shows the length in its middle (or a play mark when that is unknown).
  return h('div', { class: `thumb t${tintOf(m.id)}${m.playlist ? ' stack' : ''}${m.poster ? '' : ' plain'}` },
    m.playlist ? ICON.list() : m.poster || !dur ? ICON.play() : null,
    m.poster ? h('img', { src: m.poster, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.currentTarget.remove() }) : null,
    dur ? h('span', { class: 'dur' }, dur) : null);
}

function sourceTag(m) {
  if (m.source === 'ai' || m.alsoAi) return h('span', { class: 'tag ai' }, 'AI');
  if (m.source === 'recipe') return h('span', { class: 'tag ai' }, 'recipe');
  return null;
}

/** The small grey line under a name: status, quality/size and where it comes from. */
function subLine(m, st) {
  const where = m.playlist ? playlistSummary(m) : m.parentId ? `#${m.playlistIndex} in the playlist` : m.kind === 'embed' ? 'downloads with yt-dlp' : hostOf(m.url);
  const parts = [m.label, m.section, where].filter(Boolean).join(' · ');
  const showSt = st !== 'new';
  return h('div', { class: 'sub', title: m.url },
    showSt ? h('span', { class: 'stw' }, stTag(st, m), parts ? ' · ' : '') : null, parts,
    m.info?.hasSubtitles ? h('span', { class: 'tag', title: 'Has subtitles: they are saved with the video' }, 'CC') : null,
    m.mark ? h('span', { class: 'tag', title: 'You set this yourself (⋯ menu to undo)' }, 'marked') : null,
    sourceTag(m));
}

/** Open or close a row's list of qualities. */
function toggleOptions(m) {
  const cur = openMedia.get(m.id) || {};
  if (cur.all) {
    openMedia.set(m.id, { ...cur, all: false, error: null });
    render();
    return;
  }
  openMedia.set(m.id, { ...cur, all: true, error: null });
  if (!cur.options && !cur.loading) loadOptions(m); // shows "Reading stream…" first, then the list
  render();
}

/** Read a stream's qualities. Whether the list of them is open (`all`) is left as it is. */
async function loadOptions(m) {
  openMedia.set(m.id, { ...(openMedia.get(m.id) || {}), loading: true, error: null });
  try {
    const res = await send('inspect', { mediaId: m.id });
    openMedia.set(m.id, { ...(openMedia.get(m.id) || {}), loading: false, ...res });
  } catch (e) {
    openMedia.set(m.id, { ...(openMedia.get(m.id) || {}), loading: false, error: e.message });
  }
  render();
}

async function download(m, optionId) {
  try {
    await send('download', { mediaId: m.id, optionId });
    const open = openMedia.get(m.id);
    // Keep the qualities already read (the big card shows them again later); close everything else.
    if (open?.options) openMedia.set(m.id, { options: open.options, live: open.live, note: open.note, protected: open.protected });
    else openMedia.delete(m.id);
    banner('Download started');
    refresh();
  } catch (e) {
    banner(e.message, true);
  }
}

/** Your rename > the lecture/episode name read from the page > the tab title. */
function displayName(m) {
  return m.customName || m.title || m.hint || (m.kind === 'subtitle' ? (m.lang ? `Subtitles (${m.lang})` : 'Subtitles') : state.page.title) || hostOf(m.url);
}

/** The videos listed from a playlist card, and how many of them still need downloading. */
function playlistEntries(m) {
  const entries = state.media.filter((x) => x.parentId === m.id);
  // An entry you played shows as its stream card ("covered"); count that card's status instead.
  const all = [...entries, ...(state.coveredEntries || []).filter((x) => x.parentId === m.id)];
  const statusOf = (e) => (e.covered ? statusFor(state.media.find((x) => x.id === e.covered) || e) : statusFor(e));
  const missing = all.filter((e) => !['done', 'active', 'queued'].includes(statusOf(e))).length;
  return { total: m.listed?.count || all.length, missing, done: all.filter((e) => statusOf(e) === 'done').length };
}

function playlistSummary(m) {
  if (!m.listed) return 'playlist · list its videos to see which you have';
  const { total, done } = playlistEntries(m);
  return `playlist · ${total} video${total === 1 ? '' : 's'} · ${done} downloaded`;
}

function playlistButton(m) {
  if (!m.listed) {
    return h('button', { class: 'primary txt', title: 'Ask yt-dlp for every video in this playlist (nothing is downloaded yet)', onclick: (e) => listPlaylist(m, e.currentTarget) }, 'List videos');
  }
  const { missing } = playlistEntries(m);
  return missing
    ? h('button', { class: 'primary txt', title: 'Download every video in this playlist that you don\'t have yet', onclick: (e) => downloadMissing(m, e.currentTarget) }, `Download missing (${missing})`)
    : h('span', { class: 'st st-done' }, ICON.check(), 'All downloaded');
}

async function listPlaylist(m, btn) {
  btn.disabled = true;
  btn.textContent = 'Listing…';
  try {
    const r = await send('listPlaylist', { mediaId: m.id });
    banner(`Found ${r.count} video${r.count === 1 ? '' : 's'}${r.title ? ` in "${r.title}"` : ''}.`);
  } catch (e) {
    banner(e.message, true);
  }
  refresh();
}

async function downloadMissing(m, btn) {
  btn.disabled = true;
  try {
    const r = await send('downloadMissing', { mediaId: m.id });
    banner(r.queued ? `Downloading ${r.queued} video${r.queued === 1 ? '' : 's'} (${r.skipped} already downloaded or in progress).` : 'Nothing left to download.');
  } catch (e) {
    banner(e.message, true);
  }
  refresh();
}

async function mark(m, as, msg) {
  try {
    await send('markMedia', { mediaId: m.id, as });
    openMedia.delete(m.id);
    banner(msg);
    refresh();
  } catch (e) {
    banner(e.message, true);
  }
}

function moreButton(m, open) {
  return h('button', {
    class: 'icon more', title: 'More actions', 'aria-label': `More actions for ${displayName(m)}`, 'aria-expanded': String(!!open.menu),
    onclick: () => { openMedia.set(m.id, { ...open, menu: !open.menu }); render(); },
  }, ICON.more());
}

/** The row's own button: download, choose a quality, or the playlist's next step. */
function rowAction(m, st, open) {
  const isStream = m.kind === 'hls' || m.kind === 'dash';
  if (m.protected) return h('span', { class: 'tag drm', title: 'Protected by DRM: it cannot be saved' }, 'DRM');
  if (m.playlist) return playlistButton(m);
  if (st === 'active' || st === 'queued') return null;
  // "Download again" is in the ⋯ menu. A subtitle file has no such entry, so it keeps its button.
  if (st === 'done' && m.kind !== 'subtitle') return null;
  const label = isStream ? (open.all ? 'Close the quality list' : 'Choose a quality and download') : m.kind === 'embed' ? 'Download (with yt-dlp, through the local helper)' : 'Download';
  return h('button', {
    class: 'primary dl', title: label, 'aria-label': `${label}: ${displayName(m)}`, 'aria-expanded': isStream ? String(!!open.all) : null,
    onclick: () => (isStream ? toggleOptions(m) : download(m, 'file')),
  }, ICON.download());
}

function mediaCard(m) {
  const open = openMedia.get(m.id) || {};
  const st = statusFor(m);
  const title = displayName(m);
  const card = h('li', { class: `card is-${st}` },
    h('div', { class: 'row' },
      thumbFor(m),
      h('div', { class: 'meta' },
        nameEl(title, `m:${m.id}`),
        subLine(m, st),
        st === 'active' ? h('div', { class: 'progress' }, h('div', {})) : null,
      ),
      rowAction(m, st, open),
      moreButton(m, open),
    ),
  );
  cardExtras(card, m, open, st, title);
  paintProgress(card, m);
  return card;
}

/** "1080p · 4.2 Mbps" → {q: "1080p", s: "4.2 Mbps"} */
function splitLabel(label) {
  const [q, ...rest] = String(label).split(' · ');
  return { q, s: rest.filter((x) => x !== '+ audio').join(' · ') };
}

/** The video you are most likely watching, big: thumbnail, quality choice and one Download button. */
function heroCard(m) {
  const open = openMedia.get(m.id) || {};
  const st = statusFor(m);
  const title = displayName(m);
  const isStream = m.kind === 'hls' || m.kind === 'dash';
  const eyebrow = heroWhy === 'playing' ? 'Now playing' : heroWhy === 'paused' ? 'Last played'
    : activeFilter === 'new' ? 'Newest not downloaded' : activeFilter === 'done' ? 'Newest downloaded' : 'Latest video';
  const drm = m.protected || open.protected;

  const card = h('li', { class: `card hero is-${st}` },
    h('div', { class: 'row' },
      thumbFor(m),
      h('div', { class: 'meta' },
        h('div', { class: `eyebrow${heroWhy === 'playing' ? ' live' : ''}` }, eyebrow),
        nameEl(title, `m:${m.id}`, 'title', true),
        subLine(m, st),
      ),
      moreButton(m, open),
    ),
  );

  // While it can be downloaded, the card itself shows reading / error / qualities.
  const own = ['new', 'failed', 'missing'].includes(st) || !!drm;
  const vids = rankVideoOptions(open.options);
  const chosen = vids.find((o) => o.id === heroPick.get(m.id)) || vids[0] || (open.options || [])[0];
  const chips = own && !drm && vids.length > 1 ? vids.slice(0, 4) : [];
  if (chips.length) {
    card.append(h('div', { class: 'qualities', role: 'group', 'aria-label': 'Quality' }, chips.map((o) => {
      const { q, s } = splitLabel(o.label);
      return h('button', {
        class: 'quality', 'aria-pressed': String(o === chosen),
        onclick: () => { heroPick.set(m.id, o.id); render(); },
      }, h('span', { class: 'q' }, q), s ? h('span', { class: 's' }, s) : null);
    })));
  }
  // What the chips and the big button already offer; "Other formats" lists the rest.
  const covered = !own ? [] : chips.length ? chips.map((o) => o.id) : chosen ? [chosen.id] : [];

  if (drm) {
    card.append(h('div', { class: 'status err' }, 'This video is protected (DRM), so it can\'t be saved.'));
  } else if (st === 'active' || st === 'queued') {
    const j = jobFor(m);
    card.append(h('div', { class: 'hero-state busy' },
      h('div', { class: 'fill' }),
      h('span', { class: 'busy-text' }, heroBusyText(j)),
      j?.status === 'recording' ? h('button', { onclick: () => send('stopLive', { jobId: j.id }).then(refresh) }, 'Stop & save') : null,
      j ? h('button', { onclick: () => send('cancelJob', { jobId: j.id }).then(refresh) }, 'Cancel') : null));
  } else if (st === 'done') {
    const last = lastDownload(m);
    card.append(h('div', { class: 'hero-state done' }, ICON.check(),
      h('span', {}, last?.how === 'manual' ? 'You marked this as downloaded' : last?.at ? `Downloaded ${ago(last.at)}` : 'Already in your folders'),
      last?.file ? h('button', { onclick: () => showFile(last) }, 'Show file') : null));
  } else if (isStream && (open.loading || (!open.options && !open.error))) {
    card.append(h('button', { class: 'primary big', disabled: true }, h('span', { class: 'spinner' }), 'Reading qualities…'));
  } else if (isStream && open.error) {
    card.append(h('div', { class: 'status err' }, open.error),
      h('button', { class: 'primary big', onclick: () => loadOptions(m) }, 'Try again'));
  } else if (isStream && !open.options.length) {
    // Nothing the browser can download itself (live DASH, or a stream without tracks): offer yt-dlp.
    card.append(h('div', { class: 'status' }, open.note || 'StreamSnag found no video it can download in this stream.'),
      h('button', { class: 'primary big', title: 'Downloads this page with yt-dlp through the local helper', onclick: runYtdlp }, ICON.download(), 'Try with yt-dlp'));
  } else {
    const live = !!(open.live || m.info?.live);
    const verb = st === 'failed' ? 'Try again' : live ? 'Record' : 'Download';
    let label = verb;
    if (isStream && chosen) {
      if (chosen.id !== 'media') label = `${verb} ${splitLabel(chosen.label).q}`;
      else if (live && st !== 'failed') label = 'Record live stream';
    } else if (m.kind === 'direct' && m.size) label = `${verb} · ${formatBytes(m.size)}`;
    card.append(h('button', {
      class: 'primary big', title: m.kind === 'embed' ? 'Downloads with yt-dlp through the local helper' : null,
      onclick: () => download(m, isStream ? chosen?.id || 'media' : 'file'),
    }, ICON.download(), label));
  }
  if (isStream && own && !drm && !open.all) {
    const others = (open.options || []).filter((o) => !covered.includes(o.id));
    const kinds = [others.some((o) => !o.audio && !o.subtitle) ? 'more qualities' : '', others.some((o) => o.audio) ? 'audio only' : '', others.some((o) => o.subtitle) ? 'subtitles' : ''].filter(Boolean);
    if (others.length) {
      card.append(h('button', { class: 'link all-formats', 'aria-expanded': 'false', onclick: () => { openMedia.set(m.id, { ...open, all: true }); render(); } }, `Other formats (${kinds.join(', ')})…`));
    }
  }
  cardExtras(card, m, open, st, title, { hero: true, own, covered });
  paintProgress(card, m);
  return card;
}

/** Everything that opens under a card: qualities, rename, the ⋯ menu, and sidebar details. */
function cardExtras(card, m, open, st, title, { hero = false, own = false, covered = [] } = {}) {
  const isStream = m.kind === 'hls' || m.kind === 'dash';
  if (PANEL) {
    const last = st === 'done' ? lastDownload(m) : null;
    const dur = formatDuration(m.info?.duration);
    const rows = [
      ['Type', [m.kind === 'direct' ? (m.ext || 'file').toUpperCase() : m.kind.toUpperCase(), m.contentType].filter(Boolean).join(' · ')],
      m.size && (m.kind === 'direct' || m.kind === 'subtitle') ? ['Size', formatBytes(m.size)] : null,
      dur ? ['Length', dur] : null,
      m.kind !== 'subtitle' ? ['Name', m.customName ? 'your rename' : NAME_SOURCE[m.nameSource] || 'tab title (no lecture name found)'] : null,
      m.course ? ['Course', m.course] : null,
      m.seen > 1 ? ['Merged', `found ${m.seen} times under different links; shown once`] : null,
      ['Found', `${ago(m.detectedAt)} · ${m.source === 'ai' ? 'by AI' : m.source === 'recipe' ? 'by site recipe' : m.source === 'page' ? 'in the page' : 'in network traffic'}`],
      last ? ['Saved', [last.at ? ago(last.at) : '', baseName(last.file)].filter(Boolean).join(' · ')] : null,
      last?.how && last.how !== 'history' ? ['In folder', HOW_FOUND[last.how]] : null,
      st === 'missing' ? ['In folder', `not found any more (was ${baseName(m.library.path)})`] : null,
    ].filter(Boolean);
    card.append(h('dl', { class: 'details' },
      rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
      h('dt', {}, 'URL'),
      h('dd', { class: 'url', title: 'Click to copy', onclick: () => copy(m.url, 'URL copied') }, m.url),
    ));
    if (last?.file && !hero) {
      card.append(h('div', { class: 'job-actions' },
        h('button', { class: 'secondary', onclick: () => showFile(last) }, 'Show file'),
      ));
    }
  }

  // The list of formats. A big card that can still be downloaded shows its own reading / error / DRM lines.
  if (open.all && !own) {
    if (open.loading) card.append(h('div', { class: 'options loading' }, h('div', { class: 'spinner' }), 'Reading stream…'));
    if (open.error) card.append(h('div', { class: 'status err' }, open.error));
    if (open.protected) card.append(h('div', { class: 'status err' }, 'This stream is DRM/encrypted — it cannot be downloaded.'));
    if (open.note) card.append(h('div', { class: 'status' }, open.note));
  }
  if (open.all && open.options) {
    const list = open.options.filter((o) => !covered.includes(o.id));
    if (list.length) {
      card.append(h('div', { class: 'options' }, list.map((o) =>
        h('button', { class: 'opt', onclick: () => download(m, o.id) },
          h('span', {}, o.label),
          h('span', { class: 'hint' }, o.audio ? 'audio' : o.subtitle ? 'subs' : open.live ? 'live' : 'video'),
        ))));
    }
  }
  if (hero && open.all && !open.loading) {
    card.append(h('button', { class: 'link all-formats', 'aria-expanded': 'true', onclick: () => { openMedia.set(m.id, { ...open, all: false, error: null }); render(); } }, 'Hide formats'));
  }
  if (open.renaming) {
    const input = h('input', {
      class: 'rename', type: 'text', value: title, 'aria-label': 'File name for this video', spellcheck: 'false',
      onkeydown: (e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') { openMedia.set(m.id, { ...open, renaming: false }); render(); }
      },
    });
    const save = async (name = input.value) => {
      try {
        await send('renameMedia', { mediaId: m.id, name });
        openMedia.set(m.id, { ...open, renaming: false, menu: false });
        banner(name.trim() ? 'Renamed. Downloads of this item use the new name.' : 'Back to the name from the page');
        refresh();
      } catch (e) {
        banner(e.message, true);
      }
    };
    card.append(h('div', { class: 'rename-row' },
      input,
      h('button', { class: 'primary', onclick: () => save() }, 'Save'),
      m.customName ? h('button', { class: 'secondary', title: 'Use the name found on the page', onclick: () => save('') }, 'Reset') : null,
    ));
    setTimeout(() => { if (document.activeElement !== input) { input.focus(); input.select(); } }, 0);
  }
  if (open.menu) {
    const referer = m.pageUrl || state.page.url;
    const downloadAgain = () => {
      if (!isStream) return download(m, 'file');
      // Open the list of formats; reading them shows a spinner, and an error if the link has expired.
      openMedia.set(m.id, { ...open, menu: false, all: true, error: null });
      if (!open.options && !open.loading) loadOptions(m);
      return render();
    };
    card.append(h('div', { class: 'menu' },
      m.kind !== 'subtitle' && !m.playlist && st === 'done' && !m.protected ? h('button', { class: 'secondary', onclick: downloadAgain }, '↓ Download again') : null,
      m.kind !== 'subtitle' ? h('button', { class: 'secondary', onclick: () => { openMedia.set(m.id, { ...open, menu: false, renaming: true }); render(); } }, '✎ Rename') : null,
      ...convertButtons(m, st, open),
      m.kind !== 'subtitle' && !m.mark && st !== 'done' ? h('button', { class: 'secondary', title: 'You already have this video (the folder check missed it)', onclick: () => mark(m, 'done', 'Marked as downloaded') }, '✓ Mark as downloaded') : null,
      m.kind !== 'subtitle' && !m.mark && st === 'done' ? h('button', { class: 'secondary', title: 'The folder check matched the wrong file', onclick: () => mark(m, 'new', 'Marked as not downloaded') }, 'Mark as not downloaded') : null,
      m.mark ? h('button', { class: 'secondary', onclick: () => mark(m, null, 'Back to checking your folder') }, 'Undo my mark') : null,
      m.playlist ? h('button', { class: 'secondary', title: 'Every video in the playlist, into its own folder', onclick: () => download(m, 'file') }, 'Download all') : null,
      m.playlist && m.listed ? h('button', { class: 'secondary', onclick: (e) => listPlaylist(m, e.currentTarget) }, 'List again') : null,
      h('button', { class: 'secondary', onclick: () => copy(m.url, 'URL copied') }, 'Copy URL'),
      h('button', { class: 'secondary', onclick: () => copy(ytdlpCommand(m.url, { referer }), 'yt-dlp command copied') }, 'Copy yt-dlp cmd'),
      isStream ? h('button', { class: 'secondary', onclick: () => copy(ffmpegCommand(m.url, { referer }), 'ffmpeg command copied') }, 'Copy ffmpeg cmd') : null,
      (m.kind === 'subtitle' || m.info?.hasSubtitles) ? h('button', { class: 'secondary', onclick: () => summarize(m.id) }, 'Summarize captions') : null,
      h('button', { class: 'secondary', onclick: () => chrome.tabs.create({ url: m.url }) }, 'Open'),
      h('button', {
        class: 'secondary danger',
        onclick: () => send('dismissMedia', { mediaId: m.id }).then(() => { openMedia.delete(m.id); refresh(); }),
      }, 'Remove from list'),
    ));
  }
}

/** For a video that is on this computer (and with the helper's ffmpeg): make an MP3 or a smaller copy. */
function convertButtons(m, st, open) {
  const file = st === 'done' && !m.playlist && m.kind !== 'subtitle' && m.library?.path && !m.library.missing ? m.library.path : '';
  if (!file || !state.helper?.ok || !state.helper.tools?.ffmpeg) return [];
  const go = (mode, started) => () => {
    openMedia.set(m.id, { ...open, menu: false });
    send('convert', { path: file, mode, title: displayName(m) })
      .then(() => { banner(started); refresh(); })
      .catch((e) => banner(e.message, true));
  };
  return [
    h('button', { class: 'secondary', title: 'Saves the sound as an MP3 next to the video', onclick: go('audio', 'Making an MP3. It appears next to the video.') }, 'Save audio as MP3'),
    /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(file) ? null
      : h('button', { class: 'secondary', title: 'A smaller 720p copy for a phone or tablet, next to the original', onclick: go('small', 'Making a smaller copy. It appears next to the original.') }, 'Make a smaller copy (720p)'),
  ];
}

// ------------------------------------------------------------------ jobs

const STATUS_TEXT = {
  queued: 'Waiting for a free slot', running: 'Downloading', recording: 'Recording live', muxing: 'Merging with ffmpeg', done: 'Done',
  error: 'Failed', canceled: 'Canceled',
};

function jobCard(j) {
  const active = ACTIVE.includes(j.status);
  const p = j.progress || {};
  const { pct, indeterminate } = jobProgress(j);
  const detail = [];
  if (j.trackCount > 1 && j.trackIndex >= 0) detail.push(`file ${j.trackIndex + 1}/${j.trackCount}`);
  if (p.isBytes) detail.push(`${formatBytes(p.done)}${p.total ? ` / ${formatBytes(p.total)}` : ''}`);
  else if (p.total && !p.percent) detail.push(`${p.done}/${p.total} segments`);
  else if (p.live) detail.push(`${p.done} segments`);
  if (p.bytes && !p.isBytes) detail.push(formatBytes(p.bytes));
  if (p.percent) detail.push(`${pct.toFixed(1)}%`);
  // Once a multi-track stream is done the counters only describe its last (often subtitle) track.
  if (j.status === 'done' && j.trackCount > 1) detail.length = 0;

  const cls = j.status === 'error' ? 'err' : j.status === 'done' ? 'ok' : '';
  const card = h('li', { class: 'card' },
    h('div', { class: 'meta' },
      nameEl(j.title || j.filename, `j:${j.id}`),
      nameEl(baseName(j.outputs?.[0]?.path || j.filename), `jf:${j.id}`, 'sub'),
    ),
    active ? h('div', { class: `progress${indeterminate ? ' indeterminate' : ''}` }, h('div', { style: indeterminate ? null : `width:${pct}%` })) : null,
    h('div', { class: `status ${cls}` }, h('span', {}, j.status === 'error' ? j.error : j.kind === 'convert' && j.status === 'running' ? 'Converting with ffmpeg' : STATUS_TEXT[j.status] || j.status), h('span', {}, detail.join(' · '))),
    j.note ? h('div', { class: 'status' }, j.note) : null,
  );

  const actions = h('div', { class: 'job-actions' });
  if (j.status === 'recording') actions.append(h('button', { class: 'primary', onclick: () => send('stopLive', { jobId: j.id }).then(refresh) }, '■ Stop & save'));
  if (active || j.status === 'queued') actions.append(h('button', { class: 'secondary danger', onclick: () => send('cancelJob', { jobId: j.id }).then(refresh) }, 'Cancel'));
  if ((j.status === 'error' || j.status === 'canceled') && j.mediaId) {
    actions.append(h('button', {
      class: 'secondary',
      title: 'Try this download again (fresh links are fetched)',
      onclick: () => send('download', { mediaId: j.mediaId, optionId: j.optionId || 'file' }).then(() => { banner('Trying again'); refresh(); }).catch((e) => banner(e.message, true)),
    }, '↻ Retry'));
  }
  if (j.status === 'done') {
    // After an ffmpeg merge the main output has a path but no Chrome download id.
    const main = j.outputs?.[0];
    actions.append(h('button', {
      class: 'secondary',
      onclick: () => showFile({ downloadId: main?.downloadId, file: main?.path }),
    }, 'Show file'));
  }
  if (j.status === 'error' && !j.diagnosis) {
    actions.append(h('button', { class: 'secondary', onclick: (e) => diagnose(j, e.currentTarget) }, '✦ Ask AI why'));
  }
  if (actions.childNodes.length) card.append(actions);
  if (j.diagnosis) {
    card.append(h('div', { class: 'diag' },
      h('strong', {}, 'Likely cause: '), j.diagnosis.cause,
      j.diagnosis.fixes?.length ? h('ul', {}, j.diagnosis.fixes.map((f) => h('li', {}, f))) : null,
      j.diagnosis.tryYtdlp ? h('button', { class: 'link', onclick: runYtdlp }, 'Try yt-dlp on this page') : null,
    ));
  }
  return card;
}

/** The bar pinned to the bottom while something is downloading. */
function renderTray(jobs) {
  const running = jobs.filter((j) => ACTIVE.includes(j.status));
  const waiting = jobs.filter((j) => j.status === 'queued');
  const tray = $('#tray');
  tray.hidden = !running.length && !waiting.length;
  if (tray.hidden) return;
  const first = running[0] || waiting[0];
  const { pct, indeterminate } = jobProgress(first);
  $('#tray-title').textContent = first.title || baseName(first.filename);
  $('#tray-pct').textContent = first.status === 'queued' ? 'Waiting' : first.status === 'recording' ? 'Live' : indeterminate ? '' : `${Math.round(pct)}%`;
  const bar = $('#tray-bar');
  bar.parentElement.classList.toggle('indeterminate', indeterminate && first.status !== 'queued');
  bar.style.width = indeterminate ? '' : `${pct}%`;
  $('#tray-summary').textContent = [running.length ? `${running.length} downloading` : '', waiting.length ? `${waiting.length} queued` : ''].filter(Boolean).join(' · ');
}

async function diagnose(j, btn) {
  btn.disabled = true;
  btn.textContent = 'Asking…';
  try {
    await send('aiDiagnose', { jobId: j.id });
    refresh();
  } catch (e) {
    banner(e.message, true);
    btn.disabled = false;
    btn.textContent = '✦ Ask AI why';
  }
}

// ------------------------------------------------------------------ AI panel

let aiSig = '';
function renderAi() {
  const sec = $('#ai-section');
  const panel = $('#ai-panel');
  const r = state?.aiResult;
  const sig = JSON.stringify([aiBusy, r || null]);
  if (sig === aiSig) return;
  aiSig = sig;
  if (!aiBusy && !r) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  panel.replaceChildren();
  if (aiBusy) {
    panel.append(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Claude is reading the page and network log…'));
    return;
  }
  $('#ai-via').textContent = r.via ? `· ${r.via}` : '';
  if (r.summary) panel.append(h('p', {}, r.summary));
  panel.append(h('p', { class: 'muted small' }, `${r.added} new item(s) added to the list.`));
  const pages = r.candidates.filter((c) => c.kind === 'page');
  if (pages.length) {
    panel.append(h('div', {}, h('strong', {}, 'Player pages to open:'),
      h('ul', {}, pages.map((c) => h('li', {}, h('a', { href: c.url, target: '_blank', title: c.url }, c.label || hostOf(c.url)))))));
  }
  if (r.advice) panel.append(h('p', { class: 'muted' }, r.advice));
  if (r.recipe) {
    const test = r.recipeTest;
    panel.append(
      h('div', {}, h('strong', {}, 'Site recipe '), h('span', { class: 'muted small' }, `for ${r.recipe.site}${test ? ` · test run found ${test.urls.length} URL(s)` : ''}`)),
      r.recipe.description ? h('p', { class: 'muted small' }, r.recipe.description) : null,
      h('pre', {}, JSON.stringify(r.recipe.rules, null, 1)),
      h('div', { class: 'job-actions' },
        h('button', { class: 'primary', onclick: saveRecipe }, 'Save recipe for this site'),
        h('button', { class: 'secondary', onclick: () => copy(JSON.stringify(r.recipe, null, 1), 'Recipe copied') }, 'Copy recipe'),
        h('button', { class: 'secondary', onclick: () => copy(aiReportText(r), 'AI report copied') }, 'Copy report'),
        h('button', { class: 'secondary', onclick: () => chrome.runtime.openOptionsPage() }, 'Edit in settings'),
      ),
    );
  } else if (r.recipeError) {
    panel.append(h('p', { class: 'muted small' }, `Recipe not usable: ${r.recipeError}`));
  }
}

/** Plain-text version of the AI result, for pasting into a note or a chat. */
function aiReportText(r) {
  return [
    r.summary,
    r.candidates?.length ? `\nFound:\n${r.candidates.map((c) => `- [${c.kind}] ${c.label || ''} ${c.url}`).join('\n')}` : '',
    r.advice ? `\n${r.advice}` : '',
    r.recipe ? `\nRecipe for ${r.recipe.site}:\n${JSON.stringify(r.recipe.rules, null, 1)}` : '',
  ].filter(Boolean).join('\n');
}

async function saveRecipe() {
  try {
    await send('saveRecipe', { recipe: state.aiResult.recipe });
    banner('Recipe saved — it will run automatically on this site');
    refresh();
  } catch (e) {
    banner(e.message, true);
  }
}

async function runAi() {
  if (!state?.ai?.configured) {
    banner('Set up AI first: choose your Claude subscription or an API key in Settings.', true);
    chrome.runtime.openOptionsPage();
    return;
  }
  aiBusy = true;
  render();
  try {
    await send('aiFind');
  } catch (e) {
    banner(e.message, true);
  } finally {
    aiBusy = false;
    refresh();
  }
}

// ------------------------------------------------------------------ summary

let summarySig = '';
function renderSummary() {
  const sec = $('#summary-section');
  const panel = $('#summary-panel');
  const sig = JSON.stringify(summaryState);
  if (sig === summarySig) return;
  summarySig = sig;
  if (!summaryState) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  panel.replaceChildren();
  if (summaryState.loading) {
    panel.append(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Reading captions and summarizing…'));
    return;
  }
  if (summaryState.error) {
    panel.append(h('p', { class: 'status err' }, summaryState.error));
    return;
  }
  const { summary, markdown, via } = summaryState.result;
  panel.append(
    h('strong', {}, summary.title || state.page.title),
    h('p', {}, summary.summary),
    summary.keyPoints.length ? h('ul', {}, summary.keyPoints.map((k) => h('li', {}, k.timestamp ? h('strong', {}, `${k.timestamp} `) : null, k.point))) : null,
    h('p', { class: 'muted small' }, via),
    h('div', { class: 'job-actions' },
      h('button', { class: 'secondary', onclick: () => copy(markdown, 'Summary copied') }, 'Copy'),
      h('button', { class: 'secondary', onclick: () => send('saveSummary', { markdown, title: summary.title || state.page.title }).then(() => banner('Saved .md file')) }, 'Save .md'),
      h('button', { class: 'link', onclick: () => { summaryState = null; render(); } }, 'Close'),
    ),
  );
}

async function summarize(mediaId) {
  if (!state?.ai?.configured) {
    banner('Set up AI first in Settings.', true);
    return;
  }
  summaryState = { loading: true };
  render();
  try {
    summaryState = { result: await send('aiSummarize', { mediaId }) };
  } catch (e) {
    summaryState = { error: e.message };
  }
  render();
}

async function runYtdlp() {
  try {
    await send('ytdlp');
    banner('yt-dlp started');
    refresh();
  } catch (e) {
    banner(e.message, true);
  }
}

// ------------------------------------------------------------------ render loop

function historyCard(x) {
  const files = x.files || [];
  return h('li', { class: 'card' },
    h('div', { class: 'meta' },
      nameEl(x.title || baseName(files[0]), `h:${x.at}`),
      h('div', { class: 'sub' }, h('span', { class: 'st st-done' }, ICON.check()), ` ${ago(x.at)}`, x.bytes ? ` · ${formatBytes(x.bytes)}` : '', ` · ${hostOf(x.pageUrl || x.mediaUrl)}`),
      files.length ? nameEl(files.map(baseName).join(' + '), `hf:${x.at}`, 'sub') : null,
      x.note ? h('div', { class: 'sub muted' }, x.note) : null,
    ),
    files.length ? h('div', { class: 'job-actions' },
      h('button', { class: 'secondary', onclick: () => send('openFile', { path: files[0] }) }, 'Show file'),
      isHttpUrl(x.pageUrl || x.mediaUrl) ? h('button', { class: 'link', onclick: () => chrome.tabs.create({ url: x.pageUrl || x.mediaUrl }) }, 'Open page') : null,
    ) : null,
  );
}

const STATUS_ORDER = { failed: 0, missing: 0, new: 1, queued: 2, active: 2, done: 3 };
const byName = (a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true, sensitivity: 'base' });

/** Sort (and for "section", group) the cards. Returns cards and {group} headings. */
function arrange(list) {
  const out = [...list];
  const st = new Map(out.map((m) => [m.id, statusFor(m)]));
  if (sortBy === 'page') out.sort((a, b) => (a.detectedAt || 0) - (b.detectedAt || 0));
  if (sortBy === 'name') out.sort(byName);
  if (sortBy === 'status') out.sort((a, b) => STATUS_ORDER[st.get(a.id)] - STATUS_ORDER[st.get(b.id)] || byName(a, b));
  if (sortBy === 'length') out.sort((a, b) => (b.info?.duration || b.duration || 0) - (a.info?.duration || a.duration || 0));
  if (sortBy !== 'section') return out;
  const groups = new Map();
  for (const m of out.sort((a, b) => (a.detectedAt || 0) - (b.detectedAt || 0))) {
    const g = m.section || 'Elsewhere on the page';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  if (groups.size < 2) return out;
  return [...groups].flatMap(([group, ms]) => [{ group, n: ms.length, done: ms.filter((m) => st.get(m.id) === 'done').length }, ...ms]);
}

function matchesQuery(m, q) {
  if (!q) return true;
  const hay = [displayName(m), m.course, m.section, m.label, hostOf(m.url)].filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/**
 * The item for the big card: the newest single video (what you most likely just pressed play on).
 * Only in the default order, so a sort you chose is never broken up.
 */
function pickHero(list, arranged) {
  heroWhy = '';
  if (arranged) return null;
  const candidates = list.filter((m) => !m.playlist && !m.parentId && m.kind !== 'subtitle');
  if (!candidates.length) return null;
  // The video playing in the page (or the one you paused) comes first.
  const watching = state.playing && candidates.find((m) => m.id === state.playing.id);
  if (watching) {
    heroWhy = state.playing.playing ? 'playing' : 'paused';
    heroId = watching.id;
    return watching;
  }
  // Otherwise the newest; and once shown it stays, so a video found a second later doesn't swap the
  // card under your pointer. Opening the popup again starts fresh.
  const kept = candidates.find((m) => m.id === heroId);
  const hero = kept || candidates.reduce((a, b) => ((b.detectedAt || 0) > (a.detectedAt || 0) ? b : a));
  heroId = hero.id;
  return hero;
}

function groupHeading(g) {
  return h('li', { class: 'group-h' }, h('span', { class: 'gname', title: g.group }, g.group), h('span', { class: 'muted' }, `${g.done}/${g.n} saved`));
}

let libSig = '';
function renderLibrary() {
  const lib = state.library;
  const box = $('#library');
  box.hidden = !lib || (!lib.at && !lib.scanning && !lib.error);
  if (box.hidden) return;
  const dirs = lib.dirs || [];
  const text = lib.error
    ? lib.error
    : lib.scanning && !lib.at
      ? 'Checking your folders for videos you already have…'
      : `Checked ${lib.count} video file${lib.count === 1 ? '' : 's'} in ${dirs.length} folder${dirs.length === 1 ? '' : 's'} ${ago(lib.at)}${lib.scanning ? ' · checking again…' : ''}${lib.pending ? ` · measuring ${lib.pending} more` : ''}`;
  const sig = JSON.stringify([text, dirs, lib.extra, PANEL]);
  if (sig === libSig) return;
  libSig = sig;
  box.title = dirs.length ? `Folders checked:\n${dirs.join('\n')}` : '';
  box.replaceChildren(
    ICON.folder(),
    h('span', {}, text), ' · ',
    h('button', { class: 'link small', title: 'Look through your folders again now', onclick: checkNow }, 'Check now'), ' · ',
    h('button', { class: 'link small', title: 'Also look in another folder for videos you already have', onclick: addFolder }, 'Add folder…'),
  );
  if (PANEL && dirs.length) {
    const extra = (lib.extra || []).map((d) => d.toLowerCase());
    box.append(h('ul', { class: 'dirs' }, [...new Set([...dirs, ...(lib.extra || [])])].map((d) => h('li', {},
      h('span', { title: d }, d),
      extra.includes(d.toLowerCase()) ? h('button', { class: 'link small', onclick: () => removeFolder(d) }, 'Stop checking') : null))));
  }
}

async function checkNow() {
  banner('Checking your folders…');
  try {
    const r = await send('checkLibrary');
    banner(r.error || `Checked ${r.count} video file${r.count === 1 ? '' : 's'} in ${r.dirs.length} folder${r.dirs.length === 1 ? '' : 's'}.`, !!r.error);
  } catch (e) {
    banner(e.message, true);
  }
  refresh();
}

async function addFolder() {
  // The folder picker takes focus, which closes the toolbar popup; the folder is still added.
  banner('A folder picker opened (check the taskbar if you don\'t see it)…');
  try {
    const r = await send('addLibraryFolder');
    if (r.path) banner(`Now also checking ${r.path}`);
    else banner('No folder chosen');
  } catch (e) {
    banner(e.message, true);
  }
  refresh();
}

async function removeFolder(d) {
  await send('removeLibraryFolder', { path: d }).catch((e) => banner(e.message, true));
  refresh();
}

function folderCard(f) {
  const ext = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] || 'file').toUpperCase().slice(0, 4);
  return h('li', { class: `card${f.here ? ' is-done' : ''}` },
    h('div', { class: 'row' },
      h('div', { class: 'thumb subtitle' }, ext),
      h('div', { class: 'meta' },
        nameEl(f.name, `f:${f.path}`),
        h('div', { class: 'sub', title: f.path },
          f.here ? h('span', { class: 'st st-done' }, 'On this page') : null, f.here ? ' · ' : '',
          [formatBytes(f.size), formatDuration(f.duration), ago(f.at), baseName(f.path.replace(/[\\/][^\\/]*$/, ''))].filter(Boolean).join(' · ')),
      ),
      h('button', { class: 'secondary', title: 'Show in its folder', onclick: () => send('openFile', { path: f.path }) }, 'Show'),
    ));
}

function renderFolder() {
  const lib = state.library;
  const sec = $('#folder-section');
  sec.hidden = !PANEL || !lib?.files?.length;
  if (sec.hidden) return;
  const q = folderQuery.trim().toLowerCase();
  const hits = q ? lib.files.filter((f) => q.split(/\s+/).every((w) => f.path.toLowerCase().includes(w))) : lib.files;
  const show = hits.slice(0, 150);
  $('#folder-count').textContent = String(lib.count);
  patchList($('#folder-files'), show, (f) => f.path, (f) => JSON.stringify([f.size, f.duration, f.here, ago(f.at), expanded.has(`f:${f.path}`)]), folderCard);
  const more = $('#folder-more');
  more.hidden = hits.length <= show.length && hits.length > 0;
  more.textContent = hits.length ? `Showing the newest ${show.length} of ${hits.length}. Search to narrow it down.` : 'No file names match.';
}

// ------------------------------------------------------------------ files on this page (slides, handouts…)

async function downloadDoc(d) {
  try {
    await send('download', { mediaId: d.id });
    banner('Download started');
  } catch (e) {
    banner(e.message, true);
  }
  refresh();
}

async function downloadAllDocs(btn) {
  btn.disabled = true;
  try {
    const r = await send('downloadDocs');
    banner(r.queued ? `Downloading ${r.queued} file${r.queued === 1 ? '' : 's'}.` : 'Nothing left to download.');
  } catch (e) {
    banner(e.message, true);
  }
  btn.disabled = false;
  refresh();
}

function docCard(d, st) {
  const busy = st === 'active' || st === 'queued';
  const label = st === 'done' ? 'Download again' : st === 'failed' ? 'Try again' : 'Download';
  return h('li', { class: `card is-${st}` },
    h('div', { class: 'row' },
      h('div', { class: 'thumb subtitle' }, d.label),
      h('div', { class: 'meta' },
        nameEl(d.name, `d:${d.id}`),
        h('div', { class: 'sub', title: d.url }, st !== 'new' ? h('span', { class: 'stw' }, stTag(st), ' · ') : null, d.host),
      ),
      busy ? null : h('button', { class: 'primary dl', title: label, 'aria-label': `${label}: ${d.name}`, onclick: () => downloadDoc(d) }, ICON.download()),
    ));
}

/** The documents the page links to, in their own collapsed group: never mixed into the videos or their counts. */
function renderDocs() {
  const docs = state.docs || [];
  const box = $('#docs-box');
  box.hidden = !docs.length;
  const st = new Map(docs.map((d) => [d.id, docStatus(d, state.jobs, history)]));
  const done = docs.filter((d) => st.get(d.id) === 'done').length;
  const left = docs.filter((d) => ['new', 'failed'].includes(st.get(d.id))).length;
  $('#docs-count').textContent = String(docs.length);
  $('#docs-note').textContent = done ? `${done} of ${docs.length} downloaded` : 'PDFs, slides, handouts';
  $('#docs-toggle').setAttribute('aria-expanded', String(docsOpen));
  $('#docs-all').hidden = left < 2;
  // Shown before it is filled: a name is measured as it is added, and a hidden one measures 0.
  $('#docs').hidden = !docsOpen;
  patchList($('#docs'), docsOpen ? docs : [], (d) => d.id,
    (d) => JSON.stringify([d.name, d.url, d.label, st.get(d.id), expanded.has(`d:${d.id}`)]), (d) => docCard(d, st.get(d.id)));
}

function renderSetup() {
  // The helper answered "not installed": offer setup, unless you said "Later" in the last week.
  // The answer can arrive a moment after the popup opens (the worker has to start the helper), so the
  // card goes by what was true last time and never pops in above the button you are reaching for.
  if (state.helper) {
    helperKnown = state.helper.ok !== false;
    remember('ss-helper', helperKnown ? '1' : '0');
  }
  if (setupShown === null) setupShown = helperKnown === false;
  if (helperKnown) setupShown = false;
  $('#setup').hidden = !setupShown || Date.now() - setupLater <= 7 * 86400e3;
}

function render() {
  if (!state) return;
  $('#site').textContent = state.page.site || 'No web page';
  renderSetup();
  // Subtitle files are kept apart (collapsed): stream downloads already include their subtitles.
  const videos = state.media.filter((m) => m.kind !== 'subtitle');
  const subs = state.media.filter((m) => m.kind === 'subtitle');
  const counts = { new: 0, done: 0, failed: 0, active: 0, queued: 0, missing: 0 };
  const withStatus = videos.map((m) => ({ m, st: statusFor(m) }));
  withStatus.forEach(({ st }) => { counts[st]++; });
  // With fewer than two videos there is nothing to filter, search or sort: a remembered choice waits.
  const few = videos.length < 2;
  activeFilter = few ? 'all' : filter;
  const q = few ? '' : query.trim().toLowerCase();
  const sorted = !few && sortBy !== 'default';
  const shown = withStatus.filter(({ st }) => activeFilter === 'all'
    || (activeFilter === 'done' ? st === 'done' : st === 'new' || st === 'failed' || st === 'missing')).map(({ m }) => m)
    .filter((m) => matchesQuery(m, q));
  renderFilters(counts, videos.length);
  $('#list-head').hidden = few;
  const barOpen = !few && (searchOpen || !!q);
  $('#listbar').hidden = !barOpen;
  const searchBtn = $('#btn-search');
  searchBtn.setAttribute('aria-expanded', String(barOpen));
  searchBtn.classList.toggle('on', sorted && !barOpen); // a dot: the list is in an order you chose
  searchBtn.title = sorted && !barOpen ? `Search and sort (sorted: ${$('#sort').selectedOptions[0]?.textContent || sortBy})` : 'Search and sort';
  if ($('#sort').value !== sortBy) $('#sort').value = sortBy;
  renderLibrary();
  renderFolder();
  const removed = $('#removed');
  removed.hidden = !state.removedCount;
  if (state.removedCount) {
    removed.replaceChildren(`${state.removedCount} removed from the list · `,
      h('button', { class: 'link small', onclick: () => send('restoreMedia').then(refresh) }, 'Show again'));
  }

  const hero = pickHero(shown, sorted || !!q);
  if (hero && (hero.kind === 'hls' || hero.kind === 'dash') && !hero.protected && ['new', 'failed', 'missing'].includes(statusFor(hero))) {
    const open = openMedia.get(hero.id);
    if (!open?.options && !open?.loading && !open?.error) loadOptions(hero);
  }
  // The percentage is painted onto the card afterwards (paintProgress): a tick must not rebuild the card.
  const progressSig = (m) => { const j = jobFor(m); return j ? j.status : null; };
  const sig = (m) => m.group ? JSON.stringify(m) : JSON.stringify([
    m.listed, m.playlist ? JSON.stringify(playlistEntries(m)) : '', m.playlistIndex, m.label, m.size, m.seen, m.library, m.fingerprint, m.poster, m.hint, m.title, m.customName, m.course, m.nameSource, m.source, m.alsoAi, m.info, m.duration, m.protected, m.mark, m.section, statusFor(m), progressSig(m), state.page.title,
    PANEL && statusFor(m) === 'done' ? ago(lastDownload(m)?.at) : '', PANEL ? ago(m.detectedAt) : '',
    openMedia.get(m.id) || null, expanded.has(`m:${m.id}`), m === hero ? [activeFilter, heroWhy, heroPick.get(m.id) || ''] : '',
  ]);
  const rest = arrange(shown.filter((m) => m !== hero));
  // Show the boxes before filling them: a name is measured as it is added, and a hidden one measures 0.
  $('#box').hidden = !rest.length && !subs.length;
  $('#media').hidden = !rest.length;
  $('#subs-box').hidden = !subs.length;
  $('#subs').hidden = !subsOpen;
  patchList($('#hero'), hero ? [hero] : [], (m) => m.id, sig, heroCard);
  const keyOf = (m) => (m.group ? `g:${m.group}` : m.id);
  const build = (m) => (m.group ? groupHeading(m) : mediaCard(m));
  patchList($('#media'), rest, keyOf, sig, build);
  $('#media-count').textContent = videos.length ? String(videos.length) : '';

  renderDocs();
  const docCount = state.docs?.length || 0; // with files to show, the page is not "nothing found": only its videos are missing

  const empty = $('#empty');
  const nothing = !videos.length && !subs.length && !docCount;
  // Browser pages (settings, new tab, the extension store) can't be looked at by any extension.
  const webPage = /^(https?|file):/i.test(state.page.url || '');
  empty.hidden = shown.length > 0 || (!videos.length && subs.length > 0);
  empty.classList.toggle('slim', !nothing);
  empty.querySelector('p strong').textContent = q && videos.length
    ? `No names match “${query.trim()}”.`
    : videos.length
      ? (activeFilter === 'done' ? 'Nothing downloaded from this page yet.' : 'Everything on this page is downloaded.')
      : webPage ? (docCount ? 'No videos found yet.' : 'No media found yet.') : 'StreamSnag can\'t look at this page.';
  const hint = empty.querySelector('p.muted');
  hint.hidden = videos.length > 0;
  hint.textContent = webPage
    ? 'Press play on the video, then open StreamSnag again. Many players only load their video once it starts.'
    : 'Browser pages like this one are off limits to extensions. Open a website with a video, press play, then click StreamSnag.';
  $('#empty-actions').hidden = !nothing || !webPage;
  $('#empty-tip').hidden = !nothing;

  $('#subs-count').textContent = String(subs.length);
  $('#subs-toggle').setAttribute('aria-expanded', String(subsOpen));
  patchList($('#subs'), subsOpen ? subs : [], (m) => m.id, sig, mediaCard);
  // Move the bars of running downloads on the cards that were kept as they are.
  for (const m of state.media) {
    if (!jobFor(m)) continue;
    const card = [...document.querySelectorAll('.items > li')].find((el) => el.dataset.key === m.id);
    if (card) paintProgress(card, m);
  }

  const jobs = state.jobs || [];
  $('#jobs-section').hidden = !jobs.length;
  patchList($('#jobs'), jobs, (j) => j.id, (j) => JSON.stringify([j, expanded.has(`j:${j.id}`), expanded.has(`jf:${j.id}`)]), jobCard);
  renderTray(jobs);

  // The sidebar has room for a log of what was saved before (across all sites).
  const recent = PANEL ? history.slice(0, 25) : [];
  $('#history-section').hidden = !recent.length;
  if (recent.length) {
    patchList($('#history'), recent, (x) => String(x.at), (x) => JSON.stringify([x.at, ago(x.at), expanded.has(`h:${x.at}`), expanded.has(`hf:${x.at}`)]), historyCard);
  }

  renderAi();
  renderSummary();

  const bar = $('#recipe-bar');
  if (state.recipe) {
    bar.hidden = false;
    bar.replaceChildren(
      h('span', {}, '✦ Recipe active for ', h('strong', {}, state.recipe.site)),
      h('button', { class: 'link', onclick: () => send('runRecipe').then((r) => { banner(`Recipe found ${r.urls.length} URL(s)`); refresh(); }).catch((e) => banner(e.message, true)) }, 'Run now'),
    );
  } else bar.hidden = true;
}

async function refresh() {
  try {
    const [s, stored] = await Promise.all([send('getTabState', { panel: PANEL }), chrome.storage.local.get('history')]);
    state = s;
    history = stored.history || [];
    render();
  } catch (e) {
    banner(e.message, true);
  }
  clearTimeout(pollTimer);
  const busy = state?.jobs?.some((j) => ACTIVE.includes(j.status));
  pollTimer = setTimeout(refresh, busy ? 700 : 2000);
}

function setupToolsMenu() {
  const btn = $('#btn-tools');
  const menu = $('#tools-menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector('button')?.focus();
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); btn.focus(); }
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  const item = (id, fn) => $(id).addEventListener('click', () => { close(); fn(); });
  item('#btn-ai', runAi);
  item('#btn-summarize', () => summarize(null));
  item('#btn-ytdlp', runYtdlp);
}

async function init() {
  // ?tabId=N lets you open popup.html in a normal tab for debugging/screenshots.
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  windowId = tab?.windowId ?? null;
  tabId = forced || (tab?.id ?? null);
  if (PANEL) {
    document.body.classList.add('sidebar');
    $('#btn-sidebar').hidden = true;
    // The side panel stays open while you switch tabs: follow whichever tab is active in this window.
    const follow = (id) => {
      if (forced || id === tabId) return;
      tabId = id;
      openMedia.clear();
      summaryState = null;
      refresh();
    };
    chrome.tabs.onActivated.addListener(({ tabId: id, windowId: w }) => { if (w === windowId) follow(id); });
    chrome.windows.onFocusChanged.addListener(async (w) => {
      if (w < 0 || w !== windowId) return;
      const [t] = await chrome.tabs.query({ active: true, windowId: w });
      if (t) follow(t.id);
    });
  }
  $('#btn-sidebar').addEventListener('click', () => {
    // Must run inside the click (user gesture), before any await.
    chrome.sidePanel.open({ windowId }).then(() => window.close()).catch((e) => banner(`Couldn't open the sidebar: ${e.message}`, true));
  });
  $('#btn-history-all').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#history') }));
  window.addEventListener('resize', () => fitAll());
  $('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#btn-setup').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#helper') }));
  $('#btn-setup-later').addEventListener('click', () => { setupLater = Date.now(); remember('ss-setup-later', String(setupLater)); render(); });
  const deepScan = async () => {
    const btns = [$('#btn-rescan'), $('#btn-scan')];
    btns.forEach((b) => { b.disabled = true; });
    banner('Scanning the page, its frames and embedded players again…');
    try {
      const r = await send('rescan');
      banner(r.added ? `Found ${r.added} new item${r.added > 1 ? 's' : ''} (${r.total} in total).`
        : `Nothing new (${r.total} item${r.total === 1 ? '' : 's'}, ${r.frames} frame${r.frames === 1 ? '' : 's'} checked). Open tabs or press play on hidden players, then scan again.`);
    } catch (e) {
      banner(e.message, true);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
      refresh();
    }
  };
  $('#btn-rescan').addEventListener('click', deepScan);
  $('#btn-scan').addEventListener('click', deepScan);
  $('#btn-ai-empty').addEventListener('click', runAi);
  setupToolsMenu();
  $('#btn-clear').addEventListener('click', () => send('clearJobs').then(refresh));
  $('#btn-tray').addEventListener('click', () => $('#jobs-section').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('#btn-search').addEventListener('click', () => {
    searchOpen = $('#listbar').hidden;
    remember('ss-search', searchOpen ? '1' : '0');
    if (!searchOpen) {
      query = '';
      $('#search').value = '';
    }
    render();
    if (searchOpen) $('#search').focus();
  });
  $('#search').addEventListener('input', (e) => { query = e.target.value; render(); });
  $('#sort').addEventListener('change', (e) => { sortBy = e.target.value; remember('ss-sort', sortBy); render(); });
  $('#subs-toggle').addEventListener('click', () => { subsOpen = !subsOpen; remember('ss-subs', subsOpen ? '1' : '0'); render(); });
  $('#docs-toggle').addEventListener('click', () => { docsOpen = !docsOpen; remember('ss-docs', docsOpen ? '1' : '0'); render(); });
  $('#docs-all').addEventListener('click', (e) => downloadAllDocs(e.currentTarget));
  $('#folder-search').addEventListener('input', (e) => { folderQuery = e.target.value; render(); });
  chrome.runtime.sendMessage({ type: 'helperStatus' }).catch(() => {});
  await refresh();
}

init();

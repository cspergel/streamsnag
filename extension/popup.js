import { formatBytes, formatDuration, hostOf, /* @site-edition */ ytdlpCommand, /* @end-site-edition */ ffmpegCommand, rankVideoOptions, isHttpUrl } from './lib/util.js';
import { sameItem } from './lib/match.js';
import { leftOutNote } from './lib/linked.js';
import { docStatus, docsNote, inDocsBulk } from './lib/files.js';
import { pickPreferred, qualityChips, canBulkDownload, bulkSummary } from './lib/quality.js';
import { rateText, formatEta } from './lib/rate.js';
import { traySummary, transcribeOffer } from './lib/jobs.js';
import { captionFiles, langOfFile } from './lib/captions.js';
import {
  REASONS, flagItems, foldedIds, foldLine, reviewGroups, numberNames, sameFileNames, splitName, folderTrail, reviewSummary, docKinds, heroChoice,
} from './lib/review.js';
import {
  emptyState, captionsTravel, captionsHeading, captionLabels, cardLine, kindWord, nounFor, fileTypeWord, fileTypeHint, qualityRows, savedTrail, savedTo,
  progressWords, activityEmpty, samePage, protectedWords, plainProblem, /* @site-edition */ OTHER_WAY, /* @end-site-edition */ docRows, ASIDE_GROUP, isAudio, flagWords, plainNote, sectionUnder,
} from './lib/wording.js';
import { STRIP_MIN, stripCells, stripCounts, stripLegend, stripSummary, stripLayout, stripAction } from './lib/strip.js';
import { SCAN_AGAIN, ASK_AI, SET_UP_AI, ASK_AI_NOTE, rememberedLine, forgottenLine, ONCE_ONLY, findOutcome, plainAdvice, wrongWords, setUpAiWords } from './lib/rescue.js';

const $ = (sel) => document.querySelector(sel);
// The same page runs as the toolbar popup and (with ?view=panel) as Chrome's side panel.
const PANEL = new URLSearchParams(location.search).get('view') === 'panel';
// The study tools (the lecture's path, Autopilot, the before-AI sheet, review) live in extension/pro/ and are
// reached through this one object. Without them (`pro` stays null) this page is the downloader and nothing else.
let pro = null;
let view = 'downloader'; // 'path' | 'downloader': how the lecture in front is shown (pro decides; see render)
let viewPref = ''; // your own choice of the two, when you made one
let activityOpen = false; // the Activity view (every job) is showing instead of the page's videos
// The panel that follows a transcript, a study page or a pack. The path seats it on the stop it belongs to,
// inside a card that is rebuilt now and then: it is held here so it is never lost with that card.
const studySection = $('#study-section');
const studyPanel = $('#study-panel');
let tabId = null;
let windowId = null;
let state = null;
let history = [];
const openMedia = new Map(); // mediaId -> {loading, options, error, menu, renaming, all: the list of formats is open}
const heroPick = new Map(); // mediaId -> the quality chosen on the big card
const expanded = new Set(); // keys of names the user clicked to show in full
let summaryState = null; // {loading} | {result} | {error}
let studyState = null; // "Save transcript" / "Make study page" / "Make study pack": {what: 'transcript' | 'page' | 'pack', loading} | {what, result} | {what, error} | … (see renderStudy)
let pollTimer = null;
let filter = 'all'; // 'all' | 'new' | 'done'
let activeFilter = 'all'; // the filter in effect (a remembered one waits while a page has under two videos)
let sortBy = 'default'; // see SORTS
let query = ''; // search box on the list
let searchOpen = false; // the search + sort row
let subsOpen = false; // the collapsed "Captions" group, as you last left it
let subsPick = null; // your own click on it in this window (it beats the default below)
let subsShown = false; // whether it is open right now: closed by default while the card itself offers the transcript
let docsOpen = false; // the collapsed "Files on this page" group
let docsQuery = ''; // the find-by-name box of a long file list
let docsAll = false; // a long file list is shown in full ("Show all N")
let settings = {}; // the stored settings this page's wording depends on (how captions are saved)
let page = { players: 0, playing: 0, aside: new Set(), key: '' }; // what the page itself was asked: its players (and whether one is running), and its file links that sit in a footer or a menu
const detailsOpen = new Set(); // ids of the items whose "Details" are unfolded
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
  viewPref = localStorage.getItem('ss-view') || '';
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
  pencil: () => svg(['path', { d: 'M4 20h4L19 9l-4-4L4 16Z' }], ['path', { d: 'm13.5 6.5 4 4' }]),
  no: () => svg(['circle', { cx: 12, cy: 12, r: 8 }], ['path', { d: 'm6.5 17.5 11-11' }]),
  chev: () => svg(['path', { d: 'm6.5 9.5 5.5 5.5 5.5-5.5' }]),
  key: () => svg(['circle', { cx: 8, cy: 15.5, r: 3.5 }], ['path', { d: 'M10.6 13 19 4.5M16 7.5l2.5 2.5' }]),
  doc: () => svg(['path', { d: 'M7 3h7l4 4v14H7Z' }], ['path', { d: 'M14 3v4h4M10 12h5M10 16h5' }]),
  text: () => svg(['path', { d: 'M5 7h14M5 12h14M5 17h9' }]),
};

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, tabId, ...payload });
  if (!res?.ok) throw Object.assign(new Error(res?.error || 'Something went wrong'), res?.code ? { code: res.code } : {}, res?.pro ? { pro: res.pro } : {});
  return res.data;
}

/**
 * A Pro action that may not run on this lecture (the worker said so, or the study tools know already): the
 * one note about Pro opens on its path instead of an error. On a fresh install that is the note that comes
 * before the first Pro action ("This will be your free lecture"): `again` is the action, run once more after
 * "Use this lecture". True when a note opened.
 */
function proNote(mediaId, e, again = null) {
  if (!pro || !mediaId) return false;
  const why = e ? (e.code === 'pro' ? e.pro : null) : pro.lockedFor?.(mediaId);
  if (!why) return false;
  if (studyState?.mediaId === mediaId) studyState = null;
  pro.locked(mediaId, why, again);
  return true;
}

function banner(text, isError = false) {
  const b = $('#banner');
  if (!text) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  b.className = `banner${isError ? ' err' : ''}`;
  // What went wrong is said as one plain sentence plus what to do; what was really reported is the tooltip.
  const problem = isError ? plainProblem(text) : null;
  b.textContent = problem ? problem.text : text;
  b.title = problem?.detail || '';
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
  // A name comes from the page: it is laid out in its own direction (Arabic and Hebrew start on the right).
  // It is a tab stop only while it is cut (fitMarquee): a name that fits has nothing to open.
  const el = h('div', {
    class: `${cls} ${wrap ? 'clamp' : 'marquee'}${expanded.has(key) ? ' expanded' : ''}`,
    title: text,
    dir: 'auto',
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
  // The keyboard stops on a name only when there is more of it to show (or to fold away again).
  const stop = () => {
    if (el.classList.contains('overflow') || el.classList.contains('expanded')) el.setAttribute('tabindex', '0');
    else el.removeAttribute('tabindex');
  };
  if (el.classList.contains('clamp')) {
    // Two lines; "overflow" means there is more to read, and a click shows (or folds) all of it.
    if (!el.classList.contains('expanded')) el.classList.toggle('overflow', el.scrollHeight - el.clientHeight > 2);
    stop();
    return;
  }
  const inner = el.firstElementChild;
  const overflow = el.classList.contains('expanded') ? 0 : inner.scrollWidth - el.clientWidth;
  el.classList.toggle('overflow', overflow > 2);
  // A name written right to left is cut on its left: it scrolls the other way, and fades on that side.
  const rtl = getComputedStyle(el).direction === 'rtl';
  el.classList.toggle('rtl', rtl);
  if (overflow > 2) {
    el.style.setProperty('--shift', `${rtl ? '' : '-'}${overflow + 8}px`);
    el.style.setProperty('--dur', `${Math.max(1, overflow / 75).toFixed(1)}s`); // ~75 px/s
  }
  stop();
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
  // The row the keyboard is on may be about to be rebuilt (its menu opens, its state changes): remember
  // which of its controls has the focus, so the same control of the new row gets it back (see below).
  const active = document.activeElement;
  const holder = active && active !== document.body ? [...ul.children].find((el) => el.contains(active)) : null;
  const held = holder ? { key: holder.dataset.key, at: [...holder.querySelectorAll(STOPS)].indexOf(active), tag: active.tagName, name: stopName(active) } : null;
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
  // The focus never falls to the page: the control that had it is found again in the rebuilt row (by its
  // name, else by its place), unless something has taken the focus meanwhile.
  if (held && (!document.activeElement || document.activeElement === document.body)) {
    const row = next.find((el) => el.dataset.key === held.key);
    const stops = row && row !== holder ? [...row.querySelectorAll(STOPS)] : [];
    const same = stops.find((s) => s.tagName === held.tag && stopName(s) === held.name) || (stops[held.at]?.tagName === held.tag ? stops[held.at] : null);
    same?.focus({ preventScroll: true });
  }
}

/** Everything in a row the keyboard can stop on, and what tells one such control from another. */
const STOPS = 'button, input, select, textarea, summary, a[href], [tabindex]';
const stopName = (el) => el.getAttribute('aria-label') || el.dataset.act || `${el.className}|${el.textContent.trim()}`;

/** The card of an item in whichever list it is showing (the big card, a row, a caption file's row). */
const cardOf = (id) => [...document.querySelectorAll('.items > li')].find((el) => el.dataset.key === id);

/** Put the keyboard on a control of an item's card, once the card has been drawn again: its ⋯ button, the first entry of its menu. */
function focusIn(id, sel) {
  const el = [...(cardOf(id)?.querySelectorAll(sel) || [])].find((x) => !x.disabled && x.getClientRects().length);
  if (el) el.focus();
  return !!el;
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
  if (j.status === 'muxing') return 'Finishing…';
  const { pct, indeterminate } = jobProgress(j);
  return indeterminate ? 'Downloading…' : `Downloading ${Math.round(pct)}%`;
}

/**
 * The same for the big card: one line with a time from the start. "Starting…", then the percentage and the
 * time left as soon as there is a rate (lib/wording.js). The speed itself is in Activity.
 */
function heroBusyText(j) {
  if (!j) return 'Starting…';
  const { pct, indeterminate } = jobProgress(j);
  const begun = (j.progress?.done || 0) > 0 || (j.progress?.bytes || 0) > 0;
  return progressWords({ status: j.status, pct, indeterminate, begun, eta: j.status === 'running' ? formatEta(j.rate?.etaSeconds) : '' });
}

/** "3.1 MB/s · about 2 min left" for a running download, '' while that isn't known. */
function jobSpeed(j) {
  return j?.status === 'running' ? rateText(j.rate) : '';
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

/** The finished download of this item (this session's job, else its history record), for the folder it went to. */
function savedRecord(m) {
  return (state.jobs || []).find((x) => sameItem(m, x) && x.status === 'done' && !['studypack', 'reading', 'transcribe', 'convert'].includes(x.kind))
    || history.find((x) => sameItem(m, x)) || null;
}

/** "Saved to Downloads › StreamSnag › PHYS201" for a file on this computer (`folder`: the subfolder its download used, when that is known). */
function savedWords(file, folder = null) {
  return savedTo(savedTrail({ path: file, folder, root: state?.saveRoot?.label || 'Downloads' }));
}

/** What the big card and the path say about a saved recording: where it is, in words. */
function savedLine(m, last = lastDownload(m)) {
  if (last?.how === 'manual') return 'You marked this as downloaded';
  if (!last?.file) return 'Already in your folders';
  const rec = savedRecord(m);
  // The folder is only the download's own while the file is still where the download put it.
  const mine = rec && (rec.outputs?.[0]?.path || rec.files?.[0]) === last.file;
  return savedWords(last.file, mine && typeof rec.folder === 'string' ? rec.folder : null);
}

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
  rule: 'from the rule for this site',
  file: 'from the file\'s own name',
  link: 'from its link on the page',
  playlist: "from the page's playlist",
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
  if (m.source === 'ai' || m.alsoAi) return h('span', { class: 'tag ai', title: 'Found by "Ask your AI to find it"' }, 'Found by AI');
  if (m.source === 'recipe') return h('span', { class: 'tag ai', title: state.rule?.builtin ? 'Found by a rule for this site that comes with StreamSnag' : 'Found by a rule saved for this site (Settings, under Backup & advanced)' }, 'Site rule');
  return null;
}

/**
 * The small grey line under a name, in plain words: what it is, how long, how big ("Video · 27 min · 129 MB").
 * The container, the bitrate and the server are under Details. `hero`: the lecture in front (its row has no
 * tile, so the line carries the length; its captions are a button on the card, not a tag).
 */
function subLine(m, st, { hero = false } = {}) {
  const what = m.playlist ? playlistSummary(m) : m.parentId ? `${kindWord(m)} · number ${m.playlistIndex} in the playlist` : cardLine(m, { length: hero });
  // A caption file that is the same captions in another format says so here ("also as an SRT file"): its name is the language.
  const parts = [what, m.kind === 'subtitle' ? captionNotes.get(m.id) : '', sectionUnder(displayName(m), m.section)].filter(Boolean).join(' · ');
  const showSt = st !== 'new';
  // The file's type is a quiet detail, never the choice: said when it is not an MP4, with what that means on hover.
  // (Not on a recording that comes in several files: each of its rows says its own.)
  const type = !m.playlist && !m.parentId && !(m.variants?.length > 1) ? fileTypeWord(m) : '';
  // The words give way when the line is too long (they end in "…"); the small tags after them stay whole.
  return h('div', { class: 'sub line', title: [parts, type].filter(Boolean).join(' · ') },
    h('span', { class: 'sub-text' }, showSt ? h('span', { class: 'stw' }, stTag(st, m), parts ? ' · ' : '') : null, parts,
      type ? h('span', { class: 'ftype', title: fileTypeHint(m.ext) }, `${parts ? ' · ' : ''}${type}`) : null),
    m.info?.hasSubtitles && !hero ? h('span', { class: 'tag', title: 'Has captions: they are saved with the video' }, 'Captions') : null,
    m.mark ? h('span', { class: 'tag', title: 'You set this yourself (⋯ menu, under Advanced, to undo)' }, 'Marked by you') : null,
    // Only the length agrees with a file you have (lib/match.js): said, never taken as downloaded.
    m.maybe && st !== 'done' ? h('span', { class: 'tag', title: `A file of the same length is in your folders (${baseName(m.maybe.path)}). It may be this one.` }, 'Maybe saved') : null,
    flagTag(m),
    sourceTag(m));
}

/** A video with a choice to make before it is saved: a stream's qualities, or the several files one video comes in. */
const hasChoices = (m) => m.kind === 'hls' || m.kind === 'dash' || (m.kind === 'direct' && m.variants?.length > 1);

/** "Short clip", "No name", "Looks like a preview or ad", "Same as another one": why a recording on a busy page might not be one you want (the review sheet's own words). */
function flagTag(m) {
  const why = REASONS[pageFlags.get(m.id)];
  return why?.tag ? h('span', { class: 'tag flag', title: flagWords(pageFlags.get(m.id)) }, why.tag) : null;
}

/** What that tag means for you, in a line of its own under the row: why it is left out of "Download all", and that it can be ticked there. */
function flagNote(m) {
  const words = REASONS[pageFlags.get(m.id)]?.tag ? flagWords(pageFlags.get(m.id)) : '';
  return words ? h('div', { class: 'flag-note' }, words) : null;
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

const startingIds = new Set(); // items whose download was just asked for: their buttons wait for the answer

async function download(m, optionId) {
  // Reading a stream and naming its file can take seconds. Until the worker answers, a second click
  // must not ask again: the buttons of this item are switched off (see startingNow in the worker too).
  if (startingIds.has(m.id)) return;
  startingIds.add(m.id);
  render();
  try {
    await send('download', { mediaId: m.id, optionId });
    const open = openMedia.get(m.id);
    // Keep the qualities already read (the big card shows them again later); close everything else.
    if (open?.options) openMedia.set(m.id, { options: open.options, live: open.live, note: open.note, protected: open.protected });
    else openMedia.delete(m.id);
    // (No banner: the item's own line says "Starting…" and then how far it is. One progress display.)
  } catch (e) {
    banner(e.message, true);
  }
  startingIds.delete(m.id);
  refresh();
}

/** Your rename > the lecture/episode name read from the page > the tab title. */
function displayName(m) {
  // A caption file is called by its language (and by its lecture on a page with several): see nameCaptions.
  if (m.kind === 'subtitle' && !m.customName) return captionNames.get(m.id) || 'Captions';
  return m.customName || m.title || m.hint || state.page.title || hostOf(m.url);
}

let captionNames = new Map(); // caption file id -> "English", "English · Lecture 3"…
let captionNotes = new Map(); // caption file id -> "also as an SRT file" (the same captions in another format), when there is something to say

/**
 * Name the page's caption files (lib/wording.js): by language (what the page said, else what the address
 * says), and by the lecture they belong to when the page has several (the recording of the same `set`).
 * Never by a bitrate or a bare dash.
 */
function nameCaptions(subs) {
  const lectures = new Map();
  for (const v of state.media) if (v.kind !== 'subtitle' && v.set && !lectures.has(v.set)) lectures.set(v.set, v.customName || v.title || '');
  const labels = captionLabels(subs.map((m) => ({ id: m.id, lang: m.lang || langOfFile(m.url), ext: m.ext, name: m.title || m.hint || '', of: (m.set && lectures.get(m.set)) || '' })));
  captionNames = new Map([...labels].map(([id, l]) => [id, l.name]));
  captionNotes = new Map([...labels].filter(([, l]) => l.detail).map(([id, l]) => [id, l.detail]));
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
  if (!m.listed) return 'Playlist · list its videos to see which you have';
  const { total, done } = playlistEntries(m);
  return `Playlist · ${total} video${total === 1 ? '' : 's'} · ${done} downloaded`;
}

function playlistButton(m) {
  if (!m.listed) {
    return h('button', { class: 'primary txt', title: 'List every video in this playlist (nothing is downloaded yet). Needs the local helper.', onclick: (e) => listPlaylist(m, e.currentTarget) }, 'List videos');
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
    // Opening it puts the keyboard on its first entry; closing it, back on this button.
    onclick: () => (open.menu ? closeMenu(m) : (openMedia.set(m.id, { ...open, menu: true }), render(), focusIn(m.id, '.menu button'))),
    onkeydown: (e) => { if (e.key === 'Escape' && open.menu) { e.preventDefault(); closeMenu(m); } },
  }, ICON.more());
}

/** Close an item's ⋯ menu and hand the keyboard back to its ⋯ button. */
function closeMenu(m) {
  openMedia.set(m.id, { ...(openMedia.get(m.id) || {}), menu: false });
  render();
  focusIn(m.id, '.more');
}

/** How many rows of the review sheet's list are in sight at once (at least one): what Page Down moves by. */
function pageOfRows(row, box) {
  const scroller = [row.parentElement, ...(function* up(el) { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) yield p; })(row.parentElement)]
    .find((el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) || box;
  const tall = row.getBoundingClientRect().height || 1;
  // (Where the whole sheet scrolls, its heading and its foot stand over the list: they take from what is in sight.)
  const over = scroller.classList.contains('rv-body') ? 0 : ['.rv-head', '.rv-foot'].reduce((n, sel) => n + (box.querySelector(sel)?.getBoundingClientRect().height || 0), 0);
  return Math.max(1, Math.floor((scroller.clientHeight - over) / tall) - 1);
}

/**
 * The keys of an open ⋯ menu: the arrows move between its entries (Home and End to the first and the last),
 * Escape closes it and puts the focus back on ⋯. Tab still walks through it like any other part of the page.
 */
function menuKeys(m, menu) {
  menu.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(m);
      return;
    }
    const items = [...menu.querySelectorAll('button')].filter((b) => !b.disabled && b.getClientRects().length);
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined || !items.length) return;
    e.preventDefault();
    items[(to + items.length) % items.length].focus();
  });
}

/** The row's own button: download, choose a quality, or the playlist's next step. */
function rowAction(m, st, open) {
  const isStream = hasChoices(m); // (the several files of one video are chosen from like a stream's qualities)
  if (m.protected) return h('span', { class: 'tag drm', title: 'Protected by the site: it can\'t be saved' }, 'Protected');
  if (m.playlist) return playlistButton(m);
  if (st === 'active' || st === 'queued') return null;
  // "Download again" is in the ⋯ menu. A subtitle file has no such entry, so it keeps its button.
  if (st === 'done' && m.kind !== 'subtitle') return null;
  if (startingIds.has(m.id)) return h('button', { class: 'primary dl', disabled: true, title: 'Starting…', 'aria-label': `Starting: ${displayName(m)}` }, h('span', { class: 'spinner' }));
  // (The file's type is on the row's line, not in the button's words.)
  const label = isStream ? (open.all ? 'Close the quality list' : 'Choose a quality and download') : m.kind === 'embed' ? 'Download (through the local helper)' : 'Download';
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
        flagNote(m),
        st === 'active' ? h('div', { class: 'progress' }, h('div', {})) : null,
      ),
      // What exists for this lecture (video, transcript, study page, study pack, cards), when anything does.
      m.kind !== 'subtitle' && !m.playlist ? pro?.squares(m) : null,
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

/**
 * What one choice of a recording is, for the words of its row (lib/wording.js: qualityRows): its picture
 * size and its bitrate; for one of a video's several files (lib/variants.js), its size and its type too.
 */
function choiceFacts(m, o) {
  const file = (m.variants || []).find((v) => (v.id === m.id ? 'file' : `alt:${v.id}`) === o.id);
  if (file) return { q: file.height ? `${file.height}p` : '', bytes: file.size || 0, ext: file.ext || '' };
  const said = /([\d.]+)\s*(M|k)bps/i.exec(o.label || '');
  return { q: splitLabel(o.label).q, rate: Number(o.bandwidth) || (said ? Number(said[1]) * (said[2].toLowerCase() === 'm' ? 1e6 : 1e3) : 0) };
}

/** The page's own files: the ones it links to in its content, not in its footer or its menus (legal PDFs, press kits). */
const mainDocs = () => (state.docs || []).filter((d) => !page.aside.has(d.url));
/** The files of this page that "Download all" may still fetch: not downloaded, not running. */
const docsLeft = () => (state.docs || []).filter((d) => ['new', 'failed'].includes(docStatus(d, state.jobs, history)));

/**
 * What the card offers besides the download, as buttons on the card itself: the lecture's captions ("Save
 * transcript") and the page's files. `onPath`: the full path is on the card, and its Transcript stop holds
 * the transcript's button.
 */
function cardActions(m, { onPath = false } = {}) {
  const docs = mainDocs().length;
  const acts = [];
  // While the panel under the card names the transcript just saved (with its own "Show file"), the card
  // does not offer the same file a second time: one "Show file" for each saved thing in view.
  if (!onPath && hasCaptions(m) && !transcriptShown(m)) {
    const saved = !!m.made?.transcript;
    acts.push(h('button', {
      class: 'chip-act', 'data-act': saved ? 'card-transcript-show' : 'card-transcript',
      title: saved ? 'Show the transcript in its folder' : 'This lecture has captions. Save them as a text file you can read and search, next to the video.',
      onclick: () => (saved
        ? send('showMade', { mediaId: m.id, kind: 'transcript' }).then((r) => { if (r?.opened === 'folder') banner(r.why); }).catch((e) => banner(e.message, true))
        : saveTranscript(m.id)),
    }, saved ? ICON.check() : ICON.text(), saved ? 'Transcript saved · Show file' : 'Save transcript'));
  }
  if (docs) {
    acts.push(h('button', {
      class: 'chip-act', 'data-act': 'card-files', 'aria-haspopup': 'dialog',
      title: 'The slides and handouts this page links to. You review the list before anything is downloaded.',
      onclick: () => (docsLeft().length ? openReview({ files: true }) : showDocs()),
    }, ICON.doc(), `${docs} file${docs === 1 ? '' : 's'} on this page`));
  }
  return acts.length ? h('div', { class: 'found', role: 'group', 'aria-label': 'Also for this lecture' }, acts) : null;
}

/** Is the transcript panel showing this lecture's saved transcript right now (the file, with "Show file")? */
const transcriptShown = (m) => studyState?.what === 'transcript' && studyState.mediaId === m.id && !!studyState.result;

/** "2 of 40": where the recording in front sits among the page's ('' when it is the only one). */
function placeOnPage(m) {
  const vids = state.media.filter((x) => x.kind !== 'subtitle' && !x.playlist);
  if (vids.length < 2) return '';
  const at = [...vids].sort((a, b) => (pageOrder.get(a.id) ?? 1e9) - (pageOrder.get(b.id) ?? 1e9)).findIndex((x) => x.id === m.id);
  return at < 0 ? '' : `${at + 1} of ${vids.length}`;
}

/** The one label of the big card's slot, whatever put the recording there (playing, paused, or just the newest). */
const HERO_LABEL = 'On this page';

/**
 * The recording you are most likely watching, in front: its name set like the title of a text, what it is
 * in one plain line, and one main button. With the study tools it stands on its path (Save, Transcript,
 * Study page, Study pack, Review) and the download controls are the path's first stop; without them, or in
 * the downloads-only view, they follow the name directly.
 */
function heroCard(m) {
  const open = openMedia.get(m.id) || {};
  const st = statusFor(m);
  const title = displayName(m);
  const isStream = hasChoices(m); // a stream's qualities, or the several files one video comes in
  const drm = m.protected || open.protected;
  // (A protected recording has no path: nothing of it can be saved, so nothing is drawn that suggests it.)
  const onPath = !!pro && view === 'path' && !drm;
  const place = placeOnPage(m);

  const card = h('li', { class: `card hero is-${st}${onPath ? ' on-path' : ''}${drm ? ' is-protected' : ''}` },
    h('div', { class: 'row' },
      h('div', { class: 'meta' },
        h('div', { class: 'eyebrow-row' },
          // One label, and a dot that moves while it is playing.
          h('span', { class: `eyebrow${heroWhy === 'playing' ? ' live' : ''}` }, HERO_LABEL, heroWhy === 'playing' ? h('span', { class: 'sr' }, ' (playing now)') : null),
          place ? h('span', { class: 'eyebrow place' }, place) : null),
        nameEl(title, `m:${m.id}`, 'title', true),
        subLine(m, st, { hero: true }),
        flagNote(m),
      ),
      moreButton(m, open),
    ),
  );
  // The download controls: on the path they are its first stop, otherwise they follow the name.
  const save = h('div', { class: 'save' });

  // While it can be downloaded, the card itself shows reading / error / qualities.
  const own = ['new', 'failed', 'missing'].includes(st) || !!drm;
  const vids = rankVideoOptions(open.options);
  // Your own click, else the quality set in Settings ("Quality to pick first"), else the best.
  const chosen = vids.find((o) => o.id === heroPick.get(m.id)) || pickPreferred(open.options, state.preferredQuality) || vids[0] || (open.options || [])[0];
  const chips = own && !drm && vids.length > 1 ? qualityChips(vids, chosen) : [];
  // On the path the qualities fold behind the button's second half; otherwise they are always in sight.
  const pickOpen = !onPath || !!open.pick;
  // One row per picture size, in plain words: "1080p · best", "720p · smaller" (the bitrates are under "More
  // formats"). Files of the same picture are told apart by their size; the file's type is a small label at
  // the end of the row, never the choice, and "smaller" is only said of the one that is (lib/wording.js).
  const rows = qualityRows(chips.map((o) => choiceFacts(m, o)));
  const qualities = chips.length ? h('div', { class: 'qualities', role: 'group', 'aria-label': 'Quality', id: `q-${m.id}`, hidden: !pickOpen }, chips.map((o, i) => h('button', {
    class: 'quality', 'aria-pressed': String(o === chosen),
    onclick: () => { heroPick.set(m.id, o.id); render(); },
  }, h('span', { class: 'q' }, rows[i].words), rows[i].detail ? h('span', { class: 'qtype', title: fileTypeHint(rows[i].detail) }, rows[i].detail) : null))) : null;
  if (qualities && !onPath) save.append(qualities);
  // What the rows and the big button already offer; "More formats" lists the rest.
  const covered = !own ? [] : chips.length ? chips.map((o) => o.id) : chosen ? [chosen.id] : [];

  if (drm) {
    // The sentence, one line on what still works, and nothing that looks like a download.
    const words2 = protectedWords(m, { captions: hasCaptions(m), files: mainDocs().length });
    save.append(h('div', { class: 'status err protected-line' }, words2.text), h('div', { class: 'status protected-still' }, words2.still));
  } else if (st === 'active' || st === 'queued') {
    const j = jobFor(m);
    save.append(h('div', { class: 'hero-state busy' },
      h('div', { class: 'fill' }),
      h('span', { class: 'busy-text' }, heroBusyText(j)),
      j?.status === 'recording' ? h('button', { onclick: () => send('stopLive', { jobId: j.id }).then(refresh) }, 'Stop & save') : null,
      j ? h('button', { onclick: () => send('cancelJob', { jobId: j.id }).then(refresh) }, 'Cancel') : null));
  } else if (st === 'done') {
    const last = lastDownload(m);
    const where = savedLine(m, last);
    save.append(h('div', { class: 'hero-state done' }, ICON.check(),
      // (On the path the stop is already called "Saved": the line then only says where.)
      h('span', { class: 'saved-where', title: last?.file || where }, onPath ? where.replace(/^Saved to /, 'In ') : where),
      last?.file ? h('button', { onclick: () => showFile(last) }, 'Show file') : null));
  } else if (startingIds.has(m.id)) {
    save.append(h('button', { class: 'primary big', disabled: true }, h('span', { class: 'spinner' }), 'Starting…'));
  } else if (isStream && (open.loading || (!open.options && !open.error))) {
    save.append(h('button', { class: 'primary big', disabled: true }, h('span', { class: 'spinner' }), 'Reading qualities…'));
  } else if (isStream && open.error) {
    // One plain sentence plus what to do; what was really reported is the tooltip (and under Details).
    const problem = plainProblem(open.error);
    // append() would print an empty slot as the word "null": keep only what is there.
    save.append(...[h('div', { class: 'status err', title: problem.detail || null }, problem.text),
      h('button', { class: 'primary big', onclick: () => loadOptions(m) }, 'Try again'),
      /* @site-edition */ ytdlpFallback(m.pageUrl), /* @end-site-edition */ ].filter(Boolean));
  } else if (isStream && !open.options.length) {
    // @site-edition
    // Nothing the browser can download itself (a live broadcast of the other kind, or a stream without tracks): offer the other way.
    save.append(h('div', { class: 'status' }, open.note || 'StreamSnag found nothing it can download here.'),
      h('button', { class: 'primary big', title: 'Hands this page to the local helper\'s other downloader', onclick: runYtdlp }, h('span', { class: 'go' }), OTHER_WAY));
    // @store-edition
    // // Nothing the browser can download itself (a live broadcast of the other kind, or a stream without tracks).
    // save.append(h('div', { class: 'status' }, open.note || 'StreamSnag found nothing it can download here.'));
    // @end-site-edition
  } else {
    const live = !!(open.live || m.info?.live);
    // On the path the step is "Save lecture" and the quality has its own half of the button.
    const verb = st === 'failed' ? 'Try again' : live ? 'Record' : onPath ? 'Save lecture' : 'Download';
    // What the button will fetch: its picture size ("Download 720p"), else its size ("Download · 428 MB"). Never its file type.
    const facts = isStream && chosen && chosen.id !== 'media' ? choiceFacts(m, chosen) : null;
    const picked = facts ? { q: facts.q || (facts.bytes ? formatBytes(facts.bytes) : 'Quality'), sized: !facts.q && !!facts.bytes } : null;
    let label = verb;
    if (isStream && chosen) {
      if (picked && !(onPath && qualities)) label = picked.sized ? `${verb} · ${picked.q}` : facts.q ? `${verb} ${picked.q}` : verb;
      else if (!picked && live && st !== 'failed') label = 'Record live stream';
    } else if (m.kind === 'direct') {
      // Its size, when the page gave one. (Its type, when it is not an MP4, is a quiet detail on the line above.)
      label = [verb, m.size ? formatBytes(m.size) : ''].filter(Boolean).join(' · ');
    }
    const go = h('button', {
      class: 'primary big', title: m.kind === 'embed' ? 'Downloads through the local helper' : null,
      onclick: () => download(m, isStream ? chosen?.id || (m.kind === 'direct' ? 'file' : 'media') : 'file'),
    }, h('span', { class: 'go' }), label);
    if (onPath && qualities) {
      // One button in two halves: save it, or choose another quality first.
      save.append(h('div', { class: 'split' }, go,
        h('button', {
          class: 'split-q', title: 'Choose another quality', 'aria-label': `Quality: ${picked ? picked.q : 'choose'}`,
          'aria-expanded': String(pickOpen), 'aria-controls': `q-${m.id}`,
          onclick: () => { openMedia.set(m.id, { ...open, pick: !open.pick }); render(); },
        }, picked ? picked.q : 'Quality', ICON.chev())), qualities);
    } else save.append(go);
    // @site-edition
    // It failed once already: the other way to get it is one click away (no AI needed to find it).
    const other = st === 'failed' && m.kind !== 'embed' ? ytdlpFallback(m.pageUrl) : null;
    if (other) save.append(other);
    // @end-site-edition
  }
  // Only its length agrees with a file you have: that is said, and the download stays one click away.
  if (m.maybe && own && !drm) {
    save.append(h('div', { class: 'status maybe' }, `A file of the same length is already in your folders (${baseName(m.maybe.path)}). It may be this one. `,
      h('button', { class: 'link small', onclick: () => showFile({ file: m.maybe.path }) }, 'Show file')));
  }
  if (isStream && own && !drm && !open.all) {
    const others = (open.options || []).filter((o) => !covered.includes(o.id));
    const kinds = [others.some((o) => !o.audio && !o.subtitle) ? 'more qualities' : '', others.some((o) => o.audio) ? 'sound only' : '', others.some((o) => o.subtitle) ? 'captions' : ''].filter(Boolean);
    if (others.length) {
      save.append(h('button', { class: 'link all-formats', 'aria-expanded': 'false', title: `Everything this one comes in: ${kinds.join(', ')}`, onclick: () => { openMedia.set(m.id, { ...open, all: true }); render(); } }, 'More formats…'));
    }
  }
  // (On a busy page, where the course strip shows, the path folds to one line so the strip stays in sight.)
  card.append(onPath ? pro.path(m, { save, full: true, mini: !!courseCounts }) : save);
  // Saved, with the study tools there but the path not in view: the one obvious next step is offered right
  // under "Saved to …": the readable lecture (transcribe it when it has no captions, then "Read the lecture").
  const next = pro && !onPath && !drm && st === 'done' ? pro.next(m) : null;
  if (next) card.append(next);
  // What else the card offers for this lecture (its captions, the page's files): after its one main step, quietly.
  const also = cardActions(m, { onPath: onPath && !courseCounts });
  if (also) card.append(also);
  cardExtras(card, m, open, st, title, { hero: true, own, covered, formats: save });
  paintProgress(card, m);
  return card;
}

// @site-edition
/** Does the local helper have yt-dlp? (As it last said; nothing is offered that would only fail.) */
const hasYtdlp = () => !!(state?.helper?.ok && state.helper.tools?.ytdlp);

/**
 * "Try another way" for a download or a stream that failed: the page it came from is handed to the
 * helper's other downloader (yt-dlp). Only when the helper says it has it; null otherwise.
 */
function ytdlpFallback(pageUrl = '') {
  if (!hasYtdlp()) return null;
  return h('button', {
    class: 'secondary try-ytdlp', title: 'Hands this page to the local helper\'s other downloader',
    onclick: () => runYtdlp(pageUrl),
  }, OTHER_WAY);
}
// @end-site-edition

/**
 * The technical facts of one item, for people who want them: its type and qualities as the stream states
 * them, the server, where its name came from, when it was found, how the folder check matched it, its
 * address. Never on the first screen: the side panel folds them behind "Details", the popup keeps them
 * under "Advanced" in the ⋯ menu.
 */
function detailsList(m, st) {
  const last = st === 'done' ? lastDownload(m) : null;
  const dur = formatDuration(m.info?.duration);
  const rows = [
    ['Type', [m.kind === 'direct' ? (m.ext || 'file').toUpperCase() : m.kind.toUpperCase(), m.contentType].filter(Boolean).join(' · ')],
    m.label ? ['Format', m.label] : null,
    ['Server', hostOf(m.url)],
    m.size && (m.kind === 'direct' || m.kind === 'subtitle') ? ['Size', formatBytes(m.size)] : null,
    dur ? ['Length', dur] : null,
    m.kind !== 'subtitle' ? ['Name', m.customName ? 'your rename' : NAME_SOURCE[m.nameSource] || 'tab title (no lecture name found)'] : null,
    m.course ? ['Course', m.course] : null,
    m.seen > 1 ? ['Merged', `found ${m.seen} times under different links; shown once`] : null,
    ['Found', `${ago(m.detectedAt)} · ${m.source === 'ai' ? 'by AI' : m.source === 'recipe' ? 'by the rule for this site' : m.source === 'page' ? 'in the page' : 'in network traffic'}`],
    last ? ['Saved', [last.at ? ago(last.at) : '', baseName(last.file)].filter(Boolean).join(' · ')] : null,
    last?.how && last.how !== 'history' ? ['In folder', HOW_FOUND[last.how]] : null,
    st === 'missing' ? ['In folder', `not found any more (was ${baseName(m.library.path)})`] : null,
  ].filter(Boolean);
  return h('dl', { class: 'details' },
    rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
    h('dt', {}, 'URL'),
    h('dd', { class: 'url', title: 'Click to copy', onclick: () => copy(m.url, 'URL copied') }, m.url),
  );
}

/** The same facts behind a "Details" line that opens in place (and stays as you left it while the list refreshes). */
function detailsFold(m, st) {
  const box = h('details', { class: 'fold', open: detailsOpen.has(m.id) }, h('summary', {}, 'Details'), detailsList(m, st));
  box.addEventListener('toggle', () => { if (box.open) detailsOpen.add(m.id); else detailsOpen.delete(m.id); });
  return box;
}

/** Everything that opens under a card: qualities, rename, the ⋯ menu, and the side panel's details. */
function cardExtras(card, m, open, st, title, { hero = false, own = false, covered = [], formats = card } = {}) {
  const isStream = m.kind === 'hls' || m.kind === 'dash';
  const choosy = hasChoices(m);
  const shielded = !!(m.protected || open.protected);
  if (PANEL) {
    const last = st === 'done' ? lastDownload(m) : null;
    card.append(detailsFold(m, st));
    if (last?.file && !hero) {
      card.append(h('div', { class: 'job-actions' },
        h('button', { class: 'secondary', onclick: () => showFile(last) }, 'Show file'),
      ));
    }
  }

  // The list of formats. A big card that can still be downloaded shows its own reading / error / protected lines.
  // (`formats`: where the list goes. On the big card that is with its download controls.)
  if (open.all && !own) {
    if (open.loading) formats.append(h('div', { class: 'options loading' }, h('div', { class: 'spinner' }), 'Reading qualities…'));
    if (open.error) formats.append(h('div', { class: 'status err', title: plainProblem(open.error).detail || null }, plainProblem(open.error).text));
    if (open.protected) formats.append(h('div', { class: 'status err' }, protectedWords(m).text));
    if (open.note) formats.append(h('div', { class: 'status' }, open.note));
  }
  if (open.all && open.options && !shielded) {
    const list = open.options.filter((o) => !covered.includes(o.id));
    if (list.length) {
      formats.append(h('div', { class: 'options' }, list.map((o) =>
        h('button', { class: 'opt', disabled: startingIds.has(m.id), onclick: () => download(m, o.id) },
          h('span', {}, o.label),
          h('span', { class: 'hint' }, o.audio ? 'sound only' : o.subtitle ? 'captions' : open.live ? 'live' : 'video'),
        ))));
    }
  }
  if (hero && open.all && !open.loading) {
    formats.append(h('button', { class: 'link all-formats', 'aria-expanded': 'true', onclick: () => { openMedia.set(m.id, { ...open, all: false, error: null }); render(); } }, 'Hide formats'));
  }
  if (open.renaming) {
    const input = h('input', {
      class: 'rename', type: 'text', value: title, 'aria-label': 'File name', spellcheck: 'false', dir: 'auto',
      onkeydown: (e) => {
        if (e.key === 'Enter') save();
        // Esc leaves the name as it was, and the keyboard goes back to the ⋯ button it came from.
        if (e.key === 'Escape') { e.preventDefault(); openMedia.set(m.id, { ...open, renaming: false }); render(); focusIn(m.id, '.more'); }
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
      if (!choosy) return download(m, 'file');
      // Open the list of formats; reading them shows a spinner, and an error if the link has expired.
      openMedia.set(m.id, { ...open, menu: false, all: true, error: null });
      if (!open.options && !open.loading) loadOptions(m);
      return render();
    };
    const isLecture = m.kind !== 'subtitle' && !m.playlist;
    // Grouped, so the actions read as a few short lists instead of one wall of buttons.
    const group = (label, ...buttons) => {
      const shown = buttons.flat().filter(Boolean);
      return shown.length ? h('div', { class: 'menu-group', role: 'group', 'aria-label': label || 'This recording' }, label ? h('span', { class: 'menu-label' }, label) : null, ...shown) : null;
    };
    const transcript = () => h('button', { class: 'secondary', title: 'Save the captions as a text file you can read and search, next to the video', onclick: () => saveTranscript(m.id) }, 'Save transcript');
    // What a student needs is in sight: rename it, the lecture's path, take it off the list. The rest (its
    // address, the commands for other tools, your own "downloaded" mark, the technical details) is one line away.
    const advanced = open.adv ? h('div', { class: 'menu-adv', id: `adv-${m.id}` }, ...[
      shielded ? null : group('Your own mark',
        m.kind !== 'subtitle' && !m.mark && st !== 'done' ? h('button', { class: 'secondary', title: 'You already have this one (the folder check missed it)', onclick: () => mark(m, 'done', 'Marked as downloaded') }, '✓ Mark as downloaded') : null,
        m.kind !== 'subtitle' && !m.mark && st === 'done' ? h('button', { class: 'secondary', title: 'The folder check matched the wrong file', onclick: () => mark(m, 'new', 'Marked as not downloaded') }, 'Mark as not downloaded') : null,
        m.mark ? h('button', { class: 'secondary', onclick: () => mark(m, null, 'Back to checking your folder') }, 'Undo my mark') : null),
      shielded ? null : group('Link',
        h('button', { class: 'secondary', onclick: () => copy(m.url, 'URL copied') }, 'Copy URL'),
        // @site-edition
        h('button', { class: 'secondary', onclick: () => copy(ytdlpCommand(m.url, { referer }), 'yt-dlp command copied') }, 'Copy yt-dlp command'),
        // @end-site-edition
        isStream ? h('button', { class: 'secondary', onclick: () => copy(ffmpegCommand(m.url, { referer }), 'ffmpeg command copied') }, 'Copy ffmpeg command') : null,
        h('button', { class: 'secondary', onclick: () => chrome.tabs.create({ url: m.url }) }, 'Open link')),
      PANEL ? null : h('div', { class: 'menu-group', role: 'group', 'aria-label': 'Details' }, h('span', { class: 'menu-label' }, 'Details'), detailsList(m, st)),
    ].filter(Boolean)) : null;
    // The saved file, in its folder (Explorer or Finder opens with it selected).
    const saved = isLecture && st === 'done' ? lastDownload(m) : null;
    const menu = h('div', { class: 'menu' }, ...[
      group('',
        saved && (saved.file || saved.downloadId != null) ? h('button', { class: 'secondary', title: saved.file || 'The folder the video was saved to', onclick: () => showFile(saved) }, 'Open folder') : null,
        isLecture && st === 'done' && !shielded ? h('button', { class: 'secondary', onclick: downloadAgain }, '↓ Download again') : null,
        // (Not for a protected one: nothing of it is saved, so there is no file to name.)
        m.kind !== 'subtitle' && !shielded ? h('button', { class: 'secondary', onclick: () => { openMedia.set(m.id, { ...open, menu: false, renaming: true }); render(); } }, '✎ Rename') : null,
        m.playlist ? h('button', { class: 'secondary', title: 'Every video in the playlist, into its own folder', onclick: () => download(m, 'file') }, 'Download all') : null,
        m.playlist && m.listed ? h('button', { class: 'secondary', onclick: (e) => listPlaylist(m, e.currentTarget) }, 'List again') : null,
        // A lecture's own captions, summed up by AI (a caption file's entry is with its transcript, below).
        isLecture && hasCaptions(m) ? h('button', { class: 'secondary', title: 'A short summary of the captions, written by the AI account chosen in Settings. You see what would be sent first.', onclick: () => summarize(m.id) }, 'Summarize captions') : null),
      // A lecture's study tools are its path: on the big card in the path view, and here everywhere else
      // (and here too when that path is folded to one line, on a busy page). Not for a protected one:
      // nothing of it can be saved, so no study page or pack is offered from it.
      isLecture && pro && !shielded && !(hero && view === 'path' && !courseCounts) ? h('div', { class: 'menu-group path-group', role: 'group', 'aria-label': 'This lecture\'s path' },
        h('span', { class: 'menu-label' }, 'This lecture\'s path'), pro.path(m, { full: false })) : null,
      // Without the study tools (or for a protected lecture) there is still the transcript of the captions it
      // has, which is part of the downloader. (Making captions for one that has none is one of the study tools.)
      isLecture && (!pro || shielded) ? group('Transcript', hasCaptions(m) ? transcript() : null) : null,
      // A caption file is not a lecture with a path: what can be made from it stays one short list.
      m.kind === 'subtitle' ? group('Transcript and notes',
        transcript(),
        h('button', { class: 'secondary', title: 'The lecture as an article you can read instead of watching, saved next to the video. No AI unless you choose it.', onclick: () => readLecture(m.id) }, 'Read the lecture'),
        h('button', { class: 'secondary', title: 'You see what would be sent first', onclick: () => summarize(m.id) }, 'Summarize captions'),
        h('span', { class: 'menu-hint ai-line' }, state.ai?.configured ? 'Summaries use the AI account chosen in Settings. You see what would be sent first.' : 'Summaries need an AI account. Choose one in Settings.')) : null,
      group('Make a copy', convertButtons(m, st, open)),
      h('div', { class: 'menu-group menu-foot', role: 'group', 'aria-label': 'More' },
        h('button', {
          class: 'link adv-toggle', 'aria-expanded': String(!!open.adv), 'aria-controls': `adv-${m.id}`,
          title: shielded ? 'The technical details' : 'Copy its address, commands for other tools, your own "downloaded" mark, technical details',
          onclick: () => { openMedia.set(m.id, { ...open, adv: !open.adv }); render(); },
        }, open.adv ? 'Hide advanced' : 'Advanced'),
        h('button', {
          class: 'secondary danger',
          onclick: () => send('dismissMedia', { mediaId: m.id }).then(() => { openMedia.delete(m.id); refresh(); }),
        }, 'Remove from list')),
      advanced,
    ].filter(Boolean));
    menuKeys(m, menu);
    card.append(menu);
  }
}

/**
 * Caption files that are this video's (listed under "Subtitle files"): the ones the page declared for it,
 * or, on a page with one video, its separate caption files (lib/captions.js, as the worker reads them).
 */
function captionFileFor(m) {
  return m.kind !== 'subtitle' && captionFiles(state.media, m).length > 0;
}

/** Captions to read: on the page, or saved next to the downloaded file (e.g. transcribed on this computer). */
function hasCaptions(m) {
  return m.kind === 'subtitle' || !!m.info?.hasSubtitles || !!m.localCaptions || captionFileFor(m);
}

/**
 * A study page lines slides up with what is said, so it is offered where "Save transcript" is: for a video
 * with captions to read. (Without any, the greyed-out "Transcribe on this computer" says how to get them.)
 */
function canStudyPage(m) {
  return m.kind !== 'subtitle' && !m.playlist && hasCaptions(m);
}

const transcribing = new Set(); // transcription jobs started from this popup: their end is announced once

/**
 * For a video that is on this computer: turn its speech into captions and a transcript, with the helper.
 * Until transcription is set up, the entry says so and opens Settings on the Local helper tab.
 */
/** Where a downloaded video is on this computer ('' when it is not known). */
const fileOf = (m, st) => (st === 'done' && m.library?.path && !m.library.missing ? m.library.path : '');

/** What "Transcribe on this computer" is for this video right now (lib/jobs.js), or null when it has no place. */
function transcribeOfferFor(m, st) {
  if (m.playlist || m.kind === 'subtitle') return null;
  return transcribeOffer({ hasCaptions: hasCaptions(m), localCaptions: !!m.localCaptions, downloaded: st === 'done', file: fileOf(m, st), helper: state.helper });
}

/** Transcription is not set up yet: say so, and open Settings where it is. */
function openSttSetup(m) {
  openMedia.set(m.id, { ...(openMedia.get(m.id) || {}), menu: false });
  banner('Transcription needs a one-time setup. Settings is opening on the Local helper tab.');
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#helper') });
  render();
}

/** Start transcribing a downloaded video on this computer. */
function startTranscribing(m, st) {
  openMedia.set(m.id, { ...(openMedia.get(m.id) || {}), menu: false });
  const again = () => startTranscribing(m, st);
  if (proNote(m.id, null, again)) return;
  send('transcribe', { path: fileOf(m, st), title: displayName(m), mediaId: m.id })
    .then((job) => { transcribing.add(job.id); banner('Transcribing. This can take a while; you can close this window.'); refresh(); })
    .catch((e) => { if (!proNote(m.id, e, again)) banner(e.message, true); });
}

/** Say once that a transcription started here has ended (the job's row has the files and "Show file"). */
function announceTranscripts() {
  for (const j of state?.jobs || []) {
    if (!transcribing.has(j.id) || ACTIVE.includes(j.status)) continue;
    transcribing.delete(j.id);
    if (j.status === 'done') banner('Transcript saved next to the video');
    else if (j.status === 'error') banner(j.error || 'The transcription failed', true);
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

// ------------------------------------------------------------------ download all

let bulkIds = []; // what "Download all" is about: the downloadable videos shown right now
let bulkBusy = false;
let bulkSig = '';
let courseCounts = null; // the course strip's counts while it is showing (see renderCourse), else null
let courseSig = '';

/**
 * The course strip: one small cell for each video of a busy page (saved, saving, to get, to check, can't
 * be saved), with the counts in words under it. lib/strip.js decides the cells; the list below it is unchanged.
 */
function renderCourse(withStatus, hero) {
  const vids = withStatus.filter(({ m }) => !m.playlist);
  const box = $('#course');
  box.hidden = vids.length < STRIP_MIN;
  if (box.hidden) {
    courseCounts = null;
    courseSig = '';
    return;
  }
  const cells = stripCells(vids.map(({ m, st }) => ({
    id: m.id, name: displayName(m), status: st, flagged: pageFlags.has(m.id),
    blocked: !canBulkDownload(m) || !!openMedia.get(m.id)?.protected, order: pageOrder.get(m.id),
  })), { here: hero?.id || '' });
  courseCounts = stripCounts(cells);
  // While the page's links are still being looked at, or its videos named (the course comes with the name),
  // the strip holds its name and its counts: it never says the site's address and then, a second later,
  // the course's name; nor "144 to get" and then "145". Its cells and "N videos here" fill in as the list does.
  const settling = stripSettling();
  const known = hero?.course || vids.map(({ m }) => m.course).find(Boolean) || '';
  const name = known || (settling ? '' : state.page.site || 'This page');
  // Rebuilt only when a cell changes: eighty cells are not touched on every tick.
  const sig = JSON.stringify([name, settling, cells.map((c) => [c.state, c.here, c.name]), nounFor(vids.map(({ m }) => m))]);
  if (sig === courseSig) return;
  courseSig = sig;
  const { cols, size } = stripLayout(cells.length);
  // (Sound files are not "videos": a page with both has "recordings".)
  const noun = nounFor(vids.map(({ m }) => m), cells.length);
  $('#course-name').textContent = name || '\u00a0'; // (the line keeps its height while the name is on its way)
  $('#course-name').title = name;
  $('#course').setAttribute('aria-busy', String(settling));
  $('#course-count').textContent = `${cells.length} ${noun} here`;
  const strip = $('#strip');
  strip.className = `strip size-${size}`;
  strip.style.setProperty('--cols', String(cols));
  strip.setAttribute('aria-label', stripSummary(courseCounts, nounFor(vids.map(({ m }) => m), 1)));
  strip.replaceChildren(...cells.map((c) => h('i', { class: `c-${c.state}${c.here ? ' here' : ''}`, title: c.name })));
  $('#strip-legend').replaceChildren(...(settling ? [] : stripLegend(courseCounts)).map((l) => h('li', {}, h('i', { class: `c-${l.state}` }), l.text)));
}

/** Is the page's list still filling in or being named (lib/linked.js; the worker's nameSoon)? The strip's words wait for that. */
function stripSettling() {
  return !!(state.links?.checking || state.links?.naming);
}

/** "Files · 31" next to the strip's button: open the page's files and bring them into view. */
function showDocs() {
  docsOpen = true;
  remember('ss-docs', '1');
  render();
  $('#docs-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const DOWNLOAD_KINDS = ['hls', 'dash', 'direct', 'embed', /* @site-edition */ 'ytdlp', /* @end-site-edition */ 'doc'];

/**
 * What this page's downloads are doing, once there are several: "Downloading 4 · about 1 min left" while
 * they run (or how many are waiting their turn), then "4 saved to Downloads › StreamSnag › PHYS201".
 * '' when there is nothing to say (one download is said on its own card).
 */
function bulkStatus() {
  const mine = (state.jobs || []).filter((j) => j.tabId === tabId && DOWNLOAD_KINDS.includes(j.kind));
  const running = mine.filter((j) => ACTIVE.includes(j.status));
  const waiting = mine.filter((j) => j.status === 'queued');
  if (running.length + waiting.length >= 2) {
    const etas = running.map((j) => j.rate?.etaSeconds).filter((x) => Number.isFinite(x));
    // A time is only said when every one of them has one and none is still waiting: it is then an honest "about".
    const left = !waiting.length && etas.length === running.length ? formatEta(Math.max(...etas)) : '';
    return `Downloading ${running.length + waiting.length}${waiting.length ? ` · ${waiting.length} waiting ${waiting.length === 1 ? 'its' : 'their'} turn` : left ? ` · ${left}` : ''}`;
  }
  if (running.length + waiting.length) return '';
  const done = mine.filter((j) => j.status === 'done' && Date.now() - (j.finishedAt || 0) < 10 * 60 * 1000);
  if (done.length < 2) return '';
  const trails = [...new Set(done.map((j) => savedTrail({ path: j.outputs?.[0]?.path, folder: typeof j.folder === 'string' ? j.folder : null, root: state.saveRoot?.label || 'Downloads' }).join(' › ')))];
  return trails.length === 1 ? `${done.length} saved to ${trails[0]}` : `${done.length} saved, in ${trails.length} folders`;
}

/** "Download all (N)" above the list. It opens the review sheet; nothing starts until that says so. */
function renderBulk(shown, statusOf) {
  bulkIds = shown.filter((m) => canBulkDownload(m) && !openMedia.get(m.id)?.protected && ['new', 'failed', 'missing'].includes(statusOf.get(m.id))).map((m) => m.id);
  const n = bulkIds.length;
  const box = $('#bulk');
  const status = bulkStatus();
  // (Under a course strip whose counts are still settling, the button that says how many are missing waits with them.)
  box.hidden = (n < 2 && !bulkBusy && !status) || (!!courseCounts && stripSettling() && !bulkBusy && !status);
  // With the strip above it (and the whole page listed) it says what is missing; otherwise how many are shown.
  const strip = courseCounts && activeFilter === 'all' && !query.trim();
  const label = (strip && stripAction(courseCounts)) || `Download all (${n})`;
  const docs = strip ? mainDocs().length : 0;
  box.classList.toggle('with-strip', !!courseCounts);
  // Rebuilt only when it changes, so a click isn't lost to the background refresh.
  const sig = JSON.stringify([n, bulkBusy, label, docs, !!strip, status]);
  if (sig === bulkSig) return;
  bulkSig = sig;
  if (bulkBusy) {
    box.replaceChildren(h('button', { class: 'secondary', disabled: true }, h('span', { class: 'spinner' }), 'Starting…'));
  } else {
    box.replaceChildren(...[n >= 2 ? h('button', {
      id: 'bulk-start', class: 'secondary', title: 'Review the ones shown here that you don\'t have yet, then download them',
      'aria-haspopup': 'dialog', onclick: () => openReview(),
    }, ICON.download(), label) : null,
    docs ? h('button', { id: 'bulk-files', class: 'link small', title: 'The PDFs, slides and handouts this page links to', onclick: showDocs }, `Files · ${docs}`) : null,
    // What is happening (or where it all went) takes the note's place; else the promise that nothing starts unseen.
    status ? h('span', { class: 'small bulk-status', role: 'status' }, status)
      : n >= 2 ? h('span', { class: 'muted small bulk-note' }, 'You review the list first.') : null].filter(Boolean));
  }
}

// ------------------------------------------------------------------ review before downloading
// The sheet "Download all" opens: what would be saved and under which file names, in three groups (ready,
// worth a look, can't be downloaded), with the page's documents and a numbering option. lib/review.js
// decides the groups and labels; the worker says what each download would be called (planDownloads).
// Its state lives in `review` and its rows are patched in place, so the background refresh never unticks
// a box or closes a name you are typing.

let review = null; // the open sheet (see openReview), or null
let offered = []; // [{m, st}]: the videos listed right now (as filtered and searched), which the sheet is about
let pageFlags = new Map(); // id -> why a video might not be wanted (a key of REASONS), for the list's small tags
let pageOrder = new Map(); // id -> its place on the page
let planTicket = 0;
const PLAN_BATCH = 8; // streams asked about in one message (the worker reads four at a time)

/** A listed video as lib/review.js looks at it. */
function reviewItem(m, st) {
  return {
    id: m.id, name: m.customName || m.title || '', borrowed: !m.customName && (m.nameSource === 'title' || !m.title), url: m.url,
    duration: m.info?.duration || m.duration || 0, kind: m.kind, mediaType: m.mediaType, playlist: !!m.playlist,
    protected: !!(m.protected || openMedia.get(m.id)?.protected), live: !!m.info?.live, height: m.info?.maxHeight || 0, linked: !!m.linked,
    size: m.size || 0, ext: m.ext || '', order: pageOrder.get(m.id) ?? 1e9, status: st,
  };
}

const newRow = (ticked) => ({ ticked, plan: null, asked: undefined, seen: '', busy: false, ticket: 0, own: '', name: null, editing: false });

/**
 * Open the sheet. `files`: it is about the page's files alone (the Files group's "Download all", and the
 * card's "N files on this page"): the same sheet, with the files ticked and listed, and no videos on it.
 */
function openReview({ files = false } = {}) {
  if (review || bulkBusy || !state) return;
  review = {
    at: Date.now(),
    only: files ? 'files' : '',
    opener: document.activeElement?.closest?.('button') || null, // the button that opened it gets the focus back
    flags: new Map(pageFlags), // as they were when it opened: a row doesn't change groups under your pointer
    known: new Set(offered.map(({ m }) => m.id)), // anything else turned up later: "Just appeared"
    rows: new Map(), // video id -> {ticked, plan: the worker's answer, own: its name, name: the name you typed, editing…}
    docs: new Map(), // document id -> {ticked, plan}
    docsOpen: files, number: false, root: null, groups: null, want: new Map(), typing: '',
  };
  $('#review').hidden = false;
  document.body.classList.add('reviewing');
  $('#review').querySelector('.rv-body').scrollTop = 0;
  renderReview();
  $('#review').focus();
}

/** Close the sheet; nothing was downloaded or renamed. `refocus`: put the focus back on "Download all". */
function closeReview(refocus = true) {
  if (!review) return;
  const opener = review.opener;
  review = null;
  $('#review').hidden = true;
  document.body.classList.remove('reviewing');
  for (const ul of $('#review').querySelectorAll('.rv-list')) ul.replaceChildren();
  whereSig = '';
  if (refocus) (opener?.isConnected ? opener : $('#bulk-start') || $('#docs-all'))?.focus();
}

/** Ask the worker what each of these would be saved as. The rows fill in as the answers arrive. */
function planReview(ids) {
  const r = review;
  const byId = new Map(offered.map(({ m }) => [m.id, m]));
  const tickets = new Map();
  const rowOf = (id) => r.rows.get(id) || r.docs.get(id);
  for (const id of ids) {
    const row = rowOf(id);
    const m = byId.get(id);
    Object.assign(row, { asked: r.want.get(id) || '', seen: m ? m.customName || m.title || '' : '', busy: true, ticket: ++planTicket });
    tickets.set(id, row.ticket);
  }
  // Files and documents need nothing read: they are answered at once. Streams go a few at a time.
  const isStream = (id) => ['hls', 'dash'].includes(byId.get(id)?.kind);
  const streams = ids.filter(isStream);
  const batches = [ids.filter((id) => !isStream(id))];
  for (let i = 0; i < streams.length; i += PLAN_BATCH) batches.push(streams.slice(i, i + PLAN_BATCH));
  (async () => {
    for (const batch of batches.filter((b) => b.length)) {
      const names = Object.fromEntries(batch.map((id) => [id, rowOf(id)?.asked]).filter(([, name]) => name));
      let res;
      try {
        res = await send('planDownloads', { mediaIds: batch, names });
      } catch (e) {
        res = { items: batch.map((id) => ({ id, ok: false, why: 'other', reason: e.message })) };
      }
      if (review !== r) return; // closed meanwhile
      if (res.root) r.root = res.root;
      for (const p of res.items || []) {
        const row = rowOf(p.id);
        if (!row || row.ticket !== tickets.get(p.id)) continue; // asked again since: that answer is on its way
        row.plan = p;
        row.busy = false;
        if (p.ok && !row.asked) row.own = p.title || '';
      }
      renderReview();
    }
  })();
}

/** A file name, cut in the middle when it doesn't fit: the lecture number and the type stay in view. */
function fileNameEl(text) {
  const [head, tail] = splitName(text);
  // (Laid out in the name's own direction: its two halves follow it, so a name in Arabic or Hebrew still ends in its file type.)
  return h('span', { class: 'rv-file', title: text, dir: 'auto' }, h('span', { class: 'a' }, head), tail ? h('span', { class: 'b' }, tail) : null);
}

const alnum = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const reviewRowEl = (id) => [...$('#review').querySelectorAll('.rv-list > li')].find((el) => el.dataset.key === id);

/** What rebuilding a row depends on. Not its tick (set in place), and nothing at all while its name is being typed. */
function reviewSig(e) {
  if (e.group === 'blocked') return JSON.stringify(['off', displayName(e.m), e.reason]);
  if (e.row.editing) return 'editing';
  const p = e.row.plan;
  return JSON.stringify([e.group, e.reason, p ? [p.ok, p.filename, p.title, p.quality, p.size, p.about, p.extra, p.loose, e.where] : null,
    displayName(e.m), e.m.info?.duration || e.m.duration || 0, e.clash]);
}

function reviewRow(e) {
  const { m, row } = e;
  const name = displayName(m);
  if (e.group === 'blocked') {
    return h('li', { class: 'rv-row off' }, h('span', { class: 'rv-no' }, ICON.no()),
      h('div', { class: 'rv-main' }, fileNameEl(name), h('span', { class: 'rv-sub' }, e.reason)));
  }
  const p = row.plan?.ok ? row.plan : null;
  const file = (p && (p.filename || p.title)) || name;
  const boxId = `rv-box-${e.id}`;
  const box = h('input', {
    type: 'checkbox', id: boxId, 'aria-label': row.editing ? `Download ${file}` : null,
    onchange: (ev) => { row.ticked = ev.currentTarget.checked; renderReview(); },
  });
  box.checked = row.ticked;
  const why = e.reason ? h('span', { class: 'tag' }, REASONS[e.reason].label) : null;
  // Why it waits unticked, and what to do about it, in a line of its own (lib/wording.js).
  const means = e.reason ? h('span', { class: 'rv-why' }, flagWords(e.reason, 'sheet')) : null;
  if (!p) {
    return h('li', { class: 'rv-row wait' }, box,
      h('label', { class: 'rv-main', for: boxId }, fileNameEl(name), h('span', { class: 'rv-sub' }, why, h('span', { class: 'spinner' }), 'Working out names…'), means));
  }
  if (row.editing) {
    let closed = false;
    const done = (save, refocus) => {
      if (closed) return;
      closed = true;
      row.editing = false;
      if (save) {
        const typed = input.value.replace(/\s+/g, ' ').trim();
        row.name = typed && typed !== row.own ? typed : null; // empty, or its own name again: no rename
      }
      renderReview();
      if (refocus) reviewRowEl(e.id)?.querySelector('.rv-edit')?.focus();
    };
    const input = h('input', {
      class: 'rv-input', type: 'text', value: row.name ?? row.own, 'aria-label': `Name for ${file}`, spellcheck: 'false', maxlength: '150', dir: 'auto',
      onkeydown: (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); done(true, true); }
        // Esc closes this input only, not the sheet around it.
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(false, true); }
      },
      onblur: () => done(true, false),
    });
    return h('li', { class: 'rv-row' }, box,
      h('div', { class: 'rv-main' }, input, h('span', { class: 'rv-sub' }, 'Enter saves the name. Esc keeps the old one.')));
  }
  const size = p.size ? formatBytes(p.size) : p.about ? `about ${formatBytes(p.about)}` : '';
  const facts = [
    e.where, // its own folder, when the videos don't all go to one
    alnum(file).includes(alnum(name)) ? '' : name, // the name the page gave it, when the file is called something else
    formatDuration(m.info?.duration || m.duration), p.quality, size,
    p.extra ? `and ${p.extra} more file${p.extra === 1 ? '' : 's'}` : '',
    p.loose ? (p.filename ? 'the file type is added when it is saved' : 'named when it is saved') : '',
  ].filter(Boolean).join(' · ');
  const clash = e.clash ? h('span', {
    class: 'tag warn', title: 'Another file here gets the same name, so your browser adds (1) to this one. Rename one, or number them.',
  }, 'Same file name as another') : null;
  return h('li', { class: 'rv-row' }, box,
    h('label', { class: 'rv-main', for: boxId }, fileNameEl(file), h('span', { class: 'rv-sub', title: facts }, why, clash, facts), means),
    h('button', { class: 'icon sm rv-edit', title: 'Rename', 'aria-label': `Rename ${file}`, onclick: () => { row.editing = true; review.typing = e.id; renderReview(); } }, ICON.pencil()));
}

/** A file the one tick for "all files" covers: not an archive (it may be gigabytes), not a link from the page's footer or menu. */
const bulkDoc = (d) => !!d && inDocsBulk(d) && !page.aside.has(d.url);

function reviewDocRow(e) {
  const boxId = `rv-box-${e.d.id}`;
  const box = h('input', { type: 'checkbox', id: boxId, onchange: (ev) => { e.doc.ticked = ev.currentTarget.checked; renderReview(); } });
  box.checked = e.doc.ticked;
  // Why a file starts unticked is said on its row: a bundle that may be gigabytes, a file from the page's footer or menu.
  const sub = [e.where, e.d.bundle ? 'ZIP archive (a bundle of files)' : '', e.d.size ? formatBytes(e.d.size) : '', page.aside.has(e.d.url) ? 'From the page\'s footer or menu' : '']
    .filter(Boolean).join(' · ');
  return h('li', { class: 'rv-row' }, box,
    h('label', { class: 'rv-main', for: boxId }, fileNameEl(e.file), sub ? h('span', { class: 'rv-sub' }, sub) : null));
}

let whereSig = '';

/** Bring the open sheet up to date with the list. Rows are patched in place; ticks and typing are left alone. */
function renderReview() {
  const r = review;
  if (!r) return;
  const box = $('#review');
  const byId = new Map(offered.map(({ m }) => [m.id, m]));
  for (const id of [...r.rows.keys()]) if (!byId.has(id)) r.rows.delete(id); // no longer on the page
  const plans = new Map([...r.rows].filter(([, row]) => row.plan).map(([id, row]) => [id, row.plan]));
  // (A sheet about the page's files alone has no videos on it.)
  const groups = reviewGroups(r.only === 'files' ? [] : offered.map(({ m, st }) => reviewItem(m, st)), { flags: r.flags, plans, known: r.known });
  r.groups = groups;
  for (const { id } of groups.ready) if (!r.rows.has(id)) r.rows.set(id, newRow(true));
  for (const { id } of groups.check) if (!r.rows.has(id)) r.rows.set(id, newRow(false));
  const choosable = [...groups.ready, ...groups.check];
  const picked = choosable.filter(({ id }) => r.rows.get(id).ticked);

  // The page's documents that are not downloaded yet. On a sheet about the files they start ticked, except
  // an archive (it may be gigabytes) and a file from the page's footer or menu: those are yours to tick.
  const docsNow = docsLeft();
  const tickFirst = (d) => r.only === 'files' && bulkDoc(d);
  for (const d of docsNow) if (!r.docs.has(d.id)) r.docs.set(d.id, { ticked: tickFirst(d), plan: null, asked: undefined, busy: false, ticket: 0 });
  for (const id of [...r.docs.keys()]) if (!docsNow.some((d) => d.id === id)) r.docs.delete(id);
  const docs = docsNow.filter((d) => r.docs.get(d.id).plan?.ok !== false);
  const pickedDocs = docs.filter((d) => r.docs.get(d.id).ticked);

  // Names: the one you typed, and the numbers of "Number them in page order" (once every name is known).
  const nameOf = (id) => r.rows.get(id).name ?? r.rows.get(id).own;
  const numbering = picked.every(({ id }) => nameOf(id)) ? numberNames(picked.map(({ id }) => ({ id, name: nameOf(id) }))) : { eligible: false, names: new Map() };
  r.want = new Map();
  for (const [id, row] of r.rows) {
    const name = (r.number && numbering.names.get(id)) || row.name || '';
    if (name) r.want.set(id, name);
  }
  // Ask the worker about rows it hasn't answered for, or whose name has changed since it did.
  const canAsk = new Set(choosable.map(({ id }) => id));
  const ask = [...r.rows].filter(([id, row]) => canAsk.has(id) && !row.editing
    && (row.asked === undefined || row.asked !== (r.want.get(id) || '') || row.seen !== (byId.get(id).customName || byId.get(id).title || '')))
    .map(([id]) => id);
  ask.push(...docs.filter((d) => r.docs.get(d.id).asked === undefined).map((d) => d.id));
  if (ask.length) planReview(ask);

  // Where it goes: one line when everything lands in one folder, else each row says its own.
  const okPlans = choosable.map(({ id }) => r.rows.get(id).plan).filter((p) => p?.ok);
  const folders = [...new Set(okPlans.map((p) => p.folder || ''))];
  const several = folders.length > 1;
  const trailOf = (folder) => folderTrail(r.root?.label, folder).join(' › ');
  // (A sheet about the files alone says where they go.)
  const docPlans = docs.map((d) => r.docs.get(d.id).plan).filter((p) => p?.ok);
  if (!okPlans.length && docPlans.length) folders.push(...new Set(docPlans.map((p) => p.folder || '')));
  const where = $('#review-where');
  where.hidden = !r.root || (!okPlans.length && !docPlans.length);
  const sig = JSON.stringify([r.root, folders]);
  if (!where.hidden && sig !== whereSig) {
    whereSig = sig;
    const trail = folderTrail(r.root.label, folders[0]);
    where.title = several ? '' : [r.root.path || 'Your browser\'s Downloads folder', ...trail.slice(1)].join(' › ');
    where.replaceChildren(ICON.folder(), h('span', { class: 'trail' },
      several ? 'Saved in several folders: each row shows its own.'
        : trail.flatMap((seg, i) => (i ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), seg] : [seg])),
      r.root.note ? h('span', { class: 'muted' }, r.root.note) : null));
  }

  const clash = sameFileNames(picked.map(({ id }) => r.rows.get(id).plan).filter((p) => p?.ok));
  const entry = (group) => ({ id, reason }) => {
    const row = r.rows.get(id);
    return { id, group, reason, m: byId.get(id), row, where: several && row?.plan?.ok ? trailOf(row.plan.folder) : '', clash: clash.has(id) };
  };
  const fill = (sel, list, group) => {
    const sec = $(sel);
    sec.hidden = !list.length; // shown before it is filled, like every list here
    sec.querySelector('.count').textContent = String(list.length);
    patchList(sec.querySelector('.rv-list'), list.map(entry(group)), (e) => e.id, reviewSig, reviewRow);
  };
  fill('#rv-ready', groups.ready, 'ready');
  fill('#rv-check', groups.check, 'check');
  fill('#rv-blocked', groups.blocked, 'blocked');
  // The name box just opened takes the cursor now, in the same click: the next key pressed goes into it.
  if (r.typing) {
    const input = reviewRowEl(r.typing)?.querySelector('.rv-input');
    r.typing = '';
    if (input) {
      input.focus();
      input.select();
    }
  }
  // Ticks are set on the rows as they are: a tick must never rebuild the row it is on.
  for (const li of box.querySelectorAll('#rv-ready .rv-list > li, #rv-check .rv-list > li')) {
    const row = r.rows.get(li.dataset.key);
    const tick = li.querySelector('input[type="checkbox"]');
    if (tick.checked !== row.ticked) tick.checked = row.ticked;
    li.classList.toggle('ticked', row.ticked);
  }

  const have = $('#rv-have');
  have.hidden = !groups.have && !groups.busy;
  have.textContent = [groups.have ? `${groups.have} already in your folders: skipped.` : '', groups.busy ? `${groups.busy} downloading now: skipped.` : ''].filter(Boolean).join(' ');

  // Files: one tick for all of them, and the list of their saved names behind the arrow.
  const files = $('#rv-files');
  files.hidden = !docs.length;
  const kinds = docKinds(docs);
  const some = pickedDocs.length > 0 && pickedDocs.length < docs.length;
  const fileCount = `${some ? `${pickedDocs.length} of ` : ''}${docs.length} file${docs.length === 1 ? '' : 's'}${kinds ? ` (${kinds})` : ''}`;
  $('#rv-docs-label').textContent = r.only === 'files' ? `Download ${some ? '' : docs.length === 1 ? 'the ' : 'all '}${fileCount}` : `Also download ${fileCount}`;
  const all = $('#rv-docs-all');
  all.checked = docs.length > 0 && pickedDocs.length === docs.length;
  all.indeterminate = some;
  all.closest('.rv-row').classList.toggle('ticked', pickedDocs.length > 0);
  $('#rv-docs-toggle').setAttribute('aria-expanded', String(r.docsOpen));
  $('#rv-docs').hidden = !r.docsOpen;
  const docEntry = (d) => {
    const doc = r.docs.get(d.id);
    const p = doc.plan?.ok ? doc.plan : null;
    return { d, doc, file: p?.filename || d.name, where: p && (several || (p.folder || '') !== folders[0]) ? trailOf(p.folder) : '' };
  };
  patchList($('#rv-docs'), r.docsOpen ? docs.map(docEntry) : [], (e) => e.d.id, (e) => JSON.stringify([e.file, e.where, e.d.size || 0, page.aside.has(e.d.url)]), reviewDocRow);
  for (const li of $('#rv-docs').children) {
    const doc = r.docs.get(li.dataset.key);
    const tick = li.querySelector('input[type="checkbox"]');
    if (tick.checked !== doc.ticked) tick.checked = doc.ticked;
    li.classList.toggle('ticked', doc.ticked);
  }

  $('#rv-options').hidden = !numbering.eligible;
  $('#rv-number').checked = r.number;
  $('#rv-number').closest('.rv-row').classList.toggle('ticked', r.number);

  const n = picked.length + pickedDocs.length;
  const waiting = picked.some(({ id }) => !r.rows.get(id).plan || r.rows.get(id).busy) || pickedDocs.some((d) => !r.docs.get(d.id).plan);
  const byId2 = new Map(offered.map(({ m }) => [m.id, m]));
  const summary = reviewSummary({
    selected: picked.length, files: pickedDocs.length, check: groups.check.length, blocked: groups.blocked.length, only: r.only,
    noun: nounFor(picked.map(({ id }) => byId2.get(id)), 1),
  });
  if ($('#review-summary').textContent !== summary) $('#review-summary').textContent = summary;
  // How much it comes to, as far as the sizes are known: said before anything starts.
  const sizes = [...picked.map(({ id }) => { const p = r.rows.get(id).plan; return p?.ok ? p.size || p.about || 0 : 0; }), ...pickedDocs.map((d) => d.size || 0)];
  const total = sizes.reduce((a, b) => a + b, 0);
  const allKnown = sizes.length > 0 && sizes.every((x) => x > 0);
  const totalText = !total ? '' : allKnown ? `About ${formatBytes(total)} in all` : `At least ${formatBytes(total)} (some sizes are not known)`;
  if ($('#review-total').textContent !== totalText) $('#review-total').textContent = totalText;
  const go = $('#review-go');
  if (go.textContent !== `Download ${n}`) go.textContent = `Download ${n}`;
  go.disabled = !n || waiting;
  go.title = waiting && n ? 'Working out names…' : '';
  roveReview();
}

/**
 * One tab stop for each list of the sheet: the tick box of the row the keyboard was last on (the first, to
 * begin with). The arrows move between the rows of a list and to a row's rename button (setupReview), so
 * "Download" is a few Tab presses away however long the list is.
 */
function roveReview() {
  for (const ul of $('#review').querySelectorAll('.rv-list')) {
    const rows = [...ul.children].filter((li) => li.querySelector('input[type="checkbox"]'));
    const cur = rows.find((li) => li.contains(document.activeElement)) || rows.find((li) => li.dataset.key === ul.dataset.at) || rows[0];
    if (cur) ul.dataset.at = cur.dataset.key;
    for (const li of rows) {
      for (const el of li.querySelectorAll('input[type="checkbox"], .rv-edit')) el.tabIndex = li === cur && el.matches('input') ? 0 : -1;
    }
  }
}

/** The sheet's own "Download N": save the names it showed, start the ticked videos and files, close it. */
async function startReview() {
  const r = review;
  // A double-click on "Download all" must not land here: wait until the sheet has been on screen.
  if (!r?.groups || bulkBusy || Date.now() - r.at < 500) return;
  const mediaIds = [...r.groups.ready, ...r.groups.check].map(({ id }) => id).filter((id) => r.rows.get(id)?.ticked);
  const names = Object.fromEntries(mediaIds.filter((id) => r.want.get(id)).map((id) => [id, r.want.get(id)]));
  const docIds = [...r.docs].filter(([, d]) => d.ticked && d.plan?.ok !== false).map(([id]) => id);
  if (!mediaIds.length && !docIds.length) return;
  closeReview(false);
  bulkBusy = true;
  render();
  try {
    const res = await send('downloadMany', { mediaIds, names, docIds });
    // What started is said where it runs (the band above the list, each row, Activity): a banner only when something could not start.
    if (res.failed.length > 0 || !res.started) banner(bulkSummary(res), res.failed.length > 0);
  } catch (e) {
    banner(e.message, true);
  }
  bulkBusy = false;
  refresh();
}

function setupReview() {
  const box = $('#review');
  $('#review-close').addEventListener('click', () => closeReview());
  $('#review-cancel').addEventListener('click', () => closeReview());
  $('#review-go').addEventListener('click', startReview);
  for (const b of box.querySelectorAll('[data-pick]')) {
    b.addEventListener('click', () => {
      if (!review?.groups) return;
      for (const { id } of review.groups[b.dataset.pick]) review.rows.get(id).ticked = b.dataset.to === 'all';
      renderReview();
    });
  }
  $('#rv-docs-all').addEventListener('change', (e) => {
    if (!review) return;
    // One tick takes the page's own files. An archive or a footer link is ticked on its own row, by hand;
    // when the page's own files are all ticked already, the same click clears every tick.
    const byId = new Map(docsLeft().map((d) => [d.id, d]));
    const own = [...review.docs].filter(([id, s]) => s.plan?.ok !== false && bulkDoc(byId.get(id)));
    const fill = own.some(([, s]) => !s.ticked);
    if (fill) for (const [, s] of own) s.ticked = true;
    else for (const s of review.docs.values()) s.ticked = false;
    renderReview();
  });
  $('#rv-docs-toggle').addEventListener('click', () => { if (review) { review.docsOpen = !review.docsOpen; renderReview(); } });
  $('#rv-number').addEventListener('change', (e) => { if (review) { review.number = e.target.checked; renderReview(); } });
  // The row the keyboard is on is its list's one tab stop.
  box.addEventListener('focusin', (e) => { if (e.target.closest?.('.rv-list')) roveReview(); });
  box.addEventListener('keydown', (e) => {
    // Inside a list the arrows move between rows (Home and End to the first and the last); Right goes to
    // the row's rename button and Left back to its tick box. Tab leaves the list. Page Down and Page Up
    // move by as many rows as the sheet shows at once, and the keyboard goes with them: left to the
    // browser, the list would scroll away from the row that has the focus.
    const row = e.target.matches?.('.rv-list input[type="checkbox"], .rv-list .rv-edit') ? e.target.closest('li') : null;
    if (row && ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) {
      const rows = [...row.parentElement.children].filter((li) => li.querySelector('input[type="checkbox"]'));
      const i = rows.indexOf(row);
      const page = pageOfRows(row, box);
      const to = {
        ArrowDown: rows[i + 1], ArrowUp: rows[i - 1], Home: rows[0], End: rows[rows.length - 1], ArrowLeft: row,
        PageDown: rows[Math.min(rows.length - 1, i + page)], PageUp: rows[Math.max(0, i - page)],
      }[e.key];
      e.preventDefault();
      if (e.key === 'ArrowRight') row.querySelector('.rv-edit')?.focus();
      else to?.querySelector('input[type="checkbox"]').focus();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeReview();
    } else if (e.key === 'Tab') {
      // Keep the focus inside the sheet while it is open.
      const stops = [...box.querySelectorAll('button, input')].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
      if (!stops.length) return;
      const [first, last] = [stops[0], stops[stops.length - 1]];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

// ------------------------------------------------------------------ jobs

const STATUS_TEXT = {
  queued: 'Waiting for its turn', running: 'Downloading', recording: 'Recording live', muxing: 'Finishing: joining picture and sound', done: 'Done',
  error: 'Failed', canceled: 'Canceled',
};

/** What a job's row says it is doing; a finished download says where its file went. */
function jobWords(j) {
  if (j.status === 'error') return plainProblem(j.error).text;
  if (j.status === 'running') {
    if (j.kind === 'convert') return 'Making the copy';
    if (j.kind === 'transcribe') return 'Transcribing on this computer';
    if (j.kind === 'studypack') return j.step || 'Making the study pack';
    if (j.kind === 'reading') return j.step || 'Tidying the reading edition';
  }
  if (j.status === 'done') {
    const main = j.outputs?.[0];
    if (DOWNLOAD_KINDS.includes(j.kind) && main?.path) return savedWords(main.path, typeof j.folder === 'string' ? j.folder : null);
    if (['transcribe', 'studypack', 'reading', 'convert'].includes(j.kind)) return 'Saved next to the video';
  }
  return STATUS_TEXT[j.status] || j.status;
}

function jobCard(j) {
  const active = ACTIVE.includes(j.status);
  const p = j.progress || {};
  const { pct, indeterminate } = jobProgress(j);
  const detail = [];
  if (j.trackCount > 1 && j.trackIndex >= 0) detail.push(`file ${j.trackIndex + 1}/${j.trackCount}`);
  if (p.steps) {
    // A study pack counts AI requests, not segments.
    if (active && p.total) detail.push(`step ${Math.min(p.done + 1, p.total)} of ${p.total}`);
  } else if (p.isBytes) detail.push(j.status === 'done' ? formatBytes(p.total || p.done) : `${formatBytes(p.done)}${p.total ? ` / ${formatBytes(p.total)}` : ''}`);
  else if (p.total && !p.percent && active) detail.push(`${Math.round(pct)}%`); // (a stream counts pieces: said as how far it is)
  if (p.bytes && !p.isBytes) detail.push(formatBytes(p.bytes));
  if (p.percent) detail.push(`${pct.toFixed(1)}%`);
  // Once a multi-track stream is done the counters only describe its last (often subtitle) track.
  if (j.status === 'done' && j.trackCount > 1) detail.length = 0;

  const cls = j.status === 'error' ? 'err' : j.status === 'done' ? 'ok' : '';
  const reported = j.status === 'error' ? j.detail || plainProblem(j.error).detail : '';
  const note = plainNote(j.note);
  const card = h('li', { class: `card${j.status === 'error' ? ' needs' : ''}${active && (j.kind === 'studypack' || j.kind === 'reading') ? ' is-ai' : ''}` },
    h('div', { class: 'meta' },
      nameEl(j.title || j.filename, `j:${j.id}`),
      nameEl(baseName(j.outputs?.[0]?.path || j.filename), `jf:${j.id}`, 'sub'),
    ),
    active ? h('div', { class: `progress${indeterminate ? ' indeterminate' : ''}` }, h('div', { style: indeterminate ? null : `width:${pct}%` })) : null,
    // A failure is one plain sentence plus what to do; what was really reported is the tooltip (and a line of its own in the sidebar), for bug reports.
    h('div', { class: `status ${cls}` }, h('span', { class: 'job-words', title: j.status === 'error' ? reported || null : j.status === 'done' ? j.outputs?.[0]?.path || null : null }, jobWords(j)), h('span', {}, detail.join(' · '))),
    PANEL && j.status === 'error' && reported ? h('div', { class: 'status job-detail' }, `Details: ${reported}`) : null,
    // What else was done to it, in plain words; what the tool itself reported is the tooltip (lib/wording.js).
    note.text ? h('div', { class: 'status job-note', title: note.detail || null }, note.text) : null,
  );
  // The speed and time left go next to "Downloading", and are painted in place on every tick.
  if (j.status === 'running') card.querySelector('.status > span').append(h('span', { class: 'job-rate' }));
  paintJobRate(card, j);

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
  if (j.kind === 'studypack' && j.status === 'done' && j.pack?.guide) actions.append(h('button', { class: 'primary', onclick: () => openGuide(j) }, 'Open study guide'));
  if (j.kind === 'reading' && j.status === 'done' && j.reading?.read) actions.append(h('button', { class: 'primary', onclick: () => openRead({ jobId: j.id }) }, 'Open reading edition'));
  if (j.kind === 'reading' && (j.status === 'error' || j.status === 'canceled') && j.forMedia) {
    actions.append(h('button', {
      class: 'secondary', title: 'What was finished is kept, so it carries on from there',
      onclick: () => readLecture(j.forMedia, { tidy: true }),
    }, '↻ Try again'));
  }
  // The words are there now: they can be read as an article.
  if (j.kind === 'transcribe' && j.status === 'done' && j.forMedia && (state?.media || []).some((m) => m.id === j.forMedia)) {
    actions.append(h('button', { class: 'secondary', title: 'The lecture as an article you can read instead of watching', onclick: () => readLecture(j.forMedia) }, 'Read the lecture'));
  }
  if (j.kind === 'studypack' && (j.status === 'error' || j.status === 'canceled') && j.forMedia) {
    actions.append(h('button', {
      class: 'secondary', title: 'What was finished is kept, so it carries on from there',
      onclick: () => makeStudyPack(j.forMedia),
    }, '↻ Try again'));
  }
  if (j.status === 'done') {
    // After an ffmpeg merge the main output has a path but no Chrome download id.
    const main = j.outputs?.[0];
    actions.append(h('button', {
      class: 'secondary',
      onclick: () => showFile({ downloadId: main?.downloadId, file: main?.path }),
    }, 'Show file'));
  }
  // @site-edition
  // A video the browser could not download itself can often be fetched by yt-dlp: offered right here, AI or not.
  const viaYtdlp = j.status === 'error' && ['hls', 'dash', 'direct'].includes(j.kind) ? ytdlpFallback(j.pageUrl) : null;
  if (viaYtdlp) actions.append(viaYtdlp);
  // @end-site-edition
  if (j.status === 'error' && !j.diagnosis && j.kind !== 'transcribe' && j.kind !== 'studypack' && j.kind !== 'reading') {
    // (Nothing is sent on this click: the sheet says what would be sent first. While the answer is on its way the button waits.)
    actions.append(askingWhy.has(j.id) ? h('button', { class: 'secondary', disabled: true }, 'Asking…')
      : h('button', { class: 'secondary', 'data-act': 'ask-why', title: 'Nothing is sent on this click: you see what would be sent first', onclick: () => askWhy(j) }, '✦ Ask AI why'));
  }
  if (actions.childNodes.length) card.append(actions);
  if (j.diagnosis) {
    card.append(h('div', { class: 'diag' },
      h('strong', {}, 'Likely cause: '), j.diagnosis.cause,
      j.diagnosis.fixes?.length ? h('ul', {}, j.diagnosis.fixes.map((f) => h('li', {}, f))) : null,
      // @site-edition
      j.diagnosis.tryYtdlp ? h('button', { class: 'link', title: 'Hands this page to the local helper\'s other downloader', onclick: runYtdlp }, OTHER_WAY) : null,
      // @end-site-edition
    ));
  }
  return card;
}

/** Update a download row's speed and time left without rebuilding the row. */
function paintJobRate(card, j) {
  const el = card.querySelector('.job-rate');
  if (!el) return;
  const speed = jobSpeed(j);
  const next = speed ? ` · ${speed}` : '';
  if (el.textContent !== next) el.textContent = next;
}

const FINISHED = ['done', 'canceled'];

/**
 * Activity: every kind of job in one list (downloads, conversions, transcriptions, study packs, reading
 * editions): what is running first, then what needs you, what is waiting, and what is done. It has its
 * own view, opened from the foot of the window, which also says how much is going on.
 */
function renderActivity(jobs) {
  const groups = [
    ['Running now', jobs.filter((j) => ACTIVE.includes(j.status))],
    ['Needs you', jobs.filter((j) => j.status === 'error')],
    ['Waiting', jobs.filter((j) => j.status === 'queued')],
    ['Done', jobs.filter((j) => FINISHED.includes(j.status))],
  ];
  const rows = groups.flatMap(([group, list]) => (list.length ? [{ group, n: list.length }, ...list] : []));
  document.body.classList.toggle('activity', activityOpen);
  $('#jobs-section').hidden = !activityOpen;
  // Nothing in this session: say so, and show what was saved from this page before (by its address), or
  // point at History. It never says "nothing has run from this page" of a page whose lecture you saved last week.
  const earlier = jobs.length || !activityOpen ? [] : history.filter((x) => samePage(x.pageUrl, state.page.url)).slice(0, 8);
  const none = activityEmpty({ earlier: earlier.length, history: history.length });
  $('#jobs-none').hidden = jobs.length > 0;
  // (With jobs listed the line is not only hidden but empty: nothing on the page says "nothing running" above a list of them.)
  const noneText = jobs.length ? '' : none.text;
  if ($('#jobs-none-text').textContent !== noneText) $('#jobs-none-text').textContent = noneText;
  $('#btn-jobs-history').hidden = !none.link || jobs.length > 0;
  $('#jobs-earlier').hidden = !earlier.length;
  patchList($('#jobs-earlier'), earlier, (x) => String(x.at), (x) => JSON.stringify([x.at, ago(x.at), expanded.has(`h:${x.at}`), expanded.has(`hf:${x.at}`)]), historyCard);
  // The speed changes on every tick: it is left out of the signature and painted onto the row instead.
  patchList($('#jobs'), rows, (x) => (x.group ? `g:${x.group}` : x.id),
    (x) => (x.group ? JSON.stringify(x) : JSON.stringify([{ ...x, rate: null }, expanded.has(`j:${x.id}`), expanded.has(`jf:${x.id}`), /* @site-edition */ x.status === 'error' && hasYtdlp(), /* @end-site-edition */ askingWhy.has(x.id)])),
    (x) => (x.group ? h('li', { class: 'jobs-h' }, h('span', { class: 'eyebrow' }, x.group), h('span', { class: 'eyebrow' }, String(x.n))) : jobCard(x)));
  for (const j of jobs) {
    const row = j.status === 'running' && [...$('#jobs').children].find((el) => el.dataset.key === j.id);
    if (row) paintJobRate(row, j);
  }
  // The foot: how many are running or waiting; else whether one needs you; else "idle".
  const busy = groups[0][1].length + groups[2][1].length;
  const needs = groups[1][1].length;
  const note = busy ? String(busy) : needs ? `${needs} need${needs === 1 ? 's' : ''} you` : '· idle';
  $('#activity-dot').hidden = !busy;
  const el = $('#activity-note');
  if (el.textContent !== note) el.textContent = note;
  el.className = `dock-note${busy ? ' n' : needs ? ' bad' : ''}`;
  const btn = $('#btn-activity');
  btn.setAttribute('aria-expanded', String(activityOpen));
  btn.title = busy ? traySummary(jobs) : needs ? 'Something stopped: open Activity to see what to do' : 'Downloads, transcriptions and study packs';
  // The header becomes the way back while Activity is showing.
  $('.brand').hidden = activityOpen;
  $('#btn-back').hidden = !activityOpen;
  $('#back-text').textContent = heroId ? 'Back to the lecture' : 'Back to this page';
  $('#btn-clear').hidden = !activityOpen || !jobs.some((j) => FINISHED.includes(j.status) || j.status === 'error');
}

function setActivity(open) {
  activityOpen = open;
  render();
  // Names are measured as they are added, and a hidden one measures 0: measure again now that they show.
  fitAll();
  window.scrollTo(0, 0);
  (open ? $('#btn-back') : $('#btn-activity')).focus();
}

/** Your own choice between the lecture's path and the plain downloader; '' goes back to choosing for you. */
function setView(v) {
  viewPref = v;
  remember('ss-view', v);
  render();
}

/** The bar above the foot while something is running: its name, how far it is, and the queue in words. */
function renderTray(jobs) {
  // The lecture in front says how far it is on its own card: the bar is for whatever else is running
  // (and for everything while Activity or another view covers that card).
  const front = !activityOpen && heroId ? state.media.find((m) => m.id === heroId) : null;
  const own = front ? jobFor(front) : null;
  const running = jobs.filter((j) => ACTIVE.includes(j.status) && j.id !== own?.id);
  const waiting = jobs.filter((j) => j.status === 'queued' && j.id !== own?.id);
  const tray = $('#tray');
  tray.hidden = (!running.length && !waiting.length) || activityOpen;
  if (tray.hidden) return;
  const first = running[0] || waiting[0];
  const { pct, indeterminate } = jobProgress(first);
  $('#tray-title').textContent = first.title || baseName(first.filename);
  // "46% · about 10 s left": how far and how long. (How fast is in Activity, and in the side panel's details.)
  const left = first.status === 'running' ? formatEta(first.rate?.etaSeconds) : '';
  $('#tray-pct').textContent = [first.status === 'queued' ? 'Waiting' : first.status === 'recording' ? 'Live' : indeterminate ? '' : `${Math.round(pct)}%`, left].filter(Boolean).join(' · ');
  const bar = $('#tray-bar');
  bar.parentElement.classList.toggle('indeterminate', indeterminate && first.status !== 'queued');
  bar.style.width = indeterminate ? '' : `${pct}%`;
  // Conversions and transcriptions are not downloads: the line says what each running job is (lib/jobs.js).
  $('#tray-summary').textContent = traySummary(jobs.filter((j) => j.id !== own?.id));
}

const askingWhy = new Set(); // failed downloads whose "why" is being asked right now

/** "Ask AI why" on a failed download, first click: nothing is sent, and nothing is asked of the file's server. The sheet comes first (askFirst). */
const askWhy = (j) => askFirst('why', { jobId: j.id });

// ------------------------------------------------------------------ AI panel

let aiSig = '';
// The three things that ask your AI about what is in front of you ("Ask your AI to find it", "Summarize",
// "Ask AI why") share one state and one sheet: {loading, action} (getting what would be sent ready) |
// {confirm, action, payload, opener} (the sheet: what would be sent) | {busy, action} (the AI is looking); null otherwise.
let aiState = null;
/** What each of them asks the worker for, and what the page says while the sheet is being made ready. */
const ASKS = {
  find: { type: 'aiFind', reading: 'Reading the page. Nothing has been sent.', off: 'Set up an AI account first. Settings is opening on the AI tab.' },
  summary: { type: 'aiSummarize', reading: 'Reading the captions. Nothing has been sent.', off: 'Summaries are written by an AI account you choose. Settings is opening on the AI tab.' },
  why: { type: 'aiDiagnose', reading: 'Nothing has been sent.', off: 'Set up an AI account first. Settings is opening on the AI tab.' },
};
let aiClosed = 0; // the answer that was closed (by when it came): it is not shown again
let wrongOpen = false; // "Not the right video?" is unfolded

const openAiSettings = () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#ai') });

/**
 * The way out when nothing is listed, or the wrong thing is: "Scan again", then "Ask your AI to find it"
 * when an AI account is set up, or one quiet line on setting one up when none is (lib/rescue.js has the
 * words). The same two actions are under an empty page and behind "Not the right video?".
 * `at`: 'empty' | 'wrong' (the ids of its buttons end in it).
 */
function rescueActions(at) {
  const scan = h('button', { class: 'secondary act-scan', id: at === 'empty' ? 'btn-scan' : `btn-scan-${at}`, title: 'Look at the whole page again. Nothing reloads.', onclick: deepScan },
    svg(['path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }], ['path', { d: 'M20 5v6h-6' }]), SCAN_AGAIN);
  const ask = h('button', { class: 'secondary ai act-ai', id: at === 'empty' ? 'btn-ai-empty' : `btn-ai-${at}`, title: 'Nothing is sent on this click: you see what would be sent first', hidden: true, onclick: askAi },
    svg(['path', { d: 'm12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z' }]), ASK_AI);
  return [
    h('div', { class: 'row-btns center' }, scan, ask),
    h('p', { class: 'muted small ai-note', hidden: true }, ASK_AI_NOTE),
    h('button', { class: 'link ai-setup', id: `btn-ai-setup-${at}`, hidden: true, onclick: openAiSettings }, SET_UP_AI),
  ];
}

/** Which of the two is offered depends on whether an AI account is chosen: asked of the state on every render. */
function paintRescue() {
  const ready = !!state?.ai?.configured;
  for (const box of document.querySelectorAll('.rescue')) {
    box.querySelector('.act-ai').hidden = !ready;
    box.querySelector('.ai-note').hidden = !ready;
    box.querySelector('.ai-setup').hidden = ready;
    box.querySelector('.act-ai').disabled = !!aiState;
  }
}

/** "Scan again": the page, its frames and its embedded players are looked at again (and the site's rule runs again). */
async function deepScan() {
  const btns = [...document.querySelectorAll('.act-scan'), $('#btn-rescan')];
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
    page.key = ''; // ask the page again too (its players, its footer links)
    refresh();
  }
}

/**
 * "Ask your AI to find it", first click: nothing is sent. The worker reads the page and answers with what
 * would be sent, to whom and at whose cost, and the sheet shows it (renderAi). Only its "Ask your AI"
 * button sends anything (sendToAi).
 */
const askAi = () => askFirst('find');

/**
 * The first click of anything that asks your AI: nothing is sent. The worker answers with what would be
 * sent, to whom and at whose cost, and the sheet shows it. `action`: 'find' | 'summary' | 'why';
 * `payload`: what the worker needs to know (the item to summarise, the failed download).
 */
async function askFirst(action, payload = {}) {
  if (aiState) return;
  if (!state?.ai?.configured) {
    banner(ASKS[action].off, true);
    openAiSettings();
    return;
  }
  const opener = document.activeElement?.closest?.('button') || null; // the button that asked gets the focus back
  // (Asked from the ⋯ menu while Activity was showing: what comes of it belongs to the page's view. The
  // answer to "why" is shown in Activity itself, so that stays where it is, under the sheet.)
  if (activityOpen && action !== 'why') activityOpen = false;
  if (action === 'summary') summaryState = null;
  aiState = { loading: true, action };
  render();
  try {
    const res = await send(ASKS[action].type, payload);
    aiState = res?.confirm ? { confirm: res.confirm, action, payload, opener } : null;
  } catch (e) {
    aiState = null;
    // (What a summary cannot be made from, such as a page without captions, is said where the summary would be.)
    if (action === 'summary') summaryState = { error: e.message };
    else banner(e.message, true);
  }
  render();
}

/** The sheet's own button: the one click that sends this page's facts to the AI account. */
async function sendToAi() {
  if (!aiState?.confirm) return;
  const { action, payload, opener } = aiState;
  if (action === 'summary') {
    // The sheet closes and the summary's own panel says what is happening.
    aiState = null;
    summaryState = { loading: true };
    render();
    try {
      summaryState = { result: await send('aiSummarize', { ...payload, confirmed: true }) };
    } catch (e) {
      summaryState = { error: e.message };
    }
    render();
    $('#summary-section').scrollIntoView({ block: 'nearest' });
    return;
  }
  if (action === 'why') {
    // The sheet closes; the failed download's own button says "Asking…", and the answer appears under it.
    aiState = null;
    askingWhy.add(payload.jobId);
    render();
    // (The row was drawn again with its button waiting: the keyboard goes to the row's first button that can be pressed.)
    const row = [...$('#jobs').children].find((el) => el.dataset.key === payload.jobId);
    ([...(row?.querySelectorAll('button') || [])].find((b) => !b.disabled && b.getClientRects().length) || (opener?.isConnected ? opener : $('#btn-tools'))).focus();
    try {
      await send('aiDiagnose', { ...payload, confirmed: true });
    } catch (e) {
      banner(e.message, true);
    }
    askingWhy.delete(payload.jobId);
    await refresh();
    return;
  }
  aiState = { busy: true, action };
  aiClosed = 0;
  render();
  try {
    await send('aiFind', { confirmed: true });
    wrongOpen = false;
  } catch (e) {
    banner(e.message, true);
  } finally {
    aiState = null;
    await refresh();
    $('#ai-section').scrollIntoView({ block: 'nearest' });
  }
}

function closeAiSheet() {
  const { action, opener } = aiState || {};
  aiState = null;
  render();
  // The focus goes back to what asked: the button itself when it is still there, else the tools menu.
  const back = action && action !== 'find' && opener?.isConnected && opener.getClientRects().length ? opener : document.querySelector('.act-ai:not([hidden])') || $('#btn-tools');
  back.focus();
}

/** The sheet before anything is sent: what it looks for, what is sent, to whom, how much, at whose cost. */
function aiSheet(c) {
  const row = (label, ...dd) => [h('dt', {}, label), h('dd', {}, ...dd.filter(Boolean))];
  const exact = h('pre', { class: 'ask-text', id: 'ask-text', tabindex: '0', hidden: true }, c.text);
  // (Where part of it can only be read once you agree, the link does not promise "exactly": the text itself says what is added.)
  const seeIt = c.show || 'See exactly what is sent';
  const show = h('button', {
    class: 'link', 'aria-expanded': 'false', 'aria-controls': 'ask-text',
    onclick: () => {
      exact.hidden = !exact.hidden;
      show.setAttribute('aria-expanded', String(!exact.hidden));
      show.textContent = exact.hidden ? seeIt : 'Hide it';
    },
  }, seeIt);
  return [
    h('div', { class: 'ask-bar' },
      h('button', { class: 'back', title: 'Back without sending anything', onclick: closeAiSheet }, svg(['path', { d: 'm14.5 6-6 6 6 6' }]), h('span', {}, 'Back')),
      h('span', { class: 'eyebrow' }, 'Ask your AI')),
    h('div', { class: 'ask-body' },
      h('h1', { class: 'ask-title', id: 'ask-title' }, c.title || 'Before your AI looks at this page'),
      h('p', { class: 'ask-lead' }, 'Exactly what happens, before anything is sent.'),
      h('dl', { class: 'ask-ledger' }, [
        row('Looks for', h('b', {}, c.looks)),
        row('Sends', h('b', { class: 'ask-sends' }, c.sends), h('span', { class: 'ask-sub ask-detail' }, c.detail), show, exact),
        row('To', h('span', { class: 'ask-line' }, h('b', { class: 'ask-to' }, c.to), h('button', { class: 'link', title: 'Choose another AI account in Settings', onclick: openAiSettings }, 'Change')),
          h('span', { class: 'ask-sub' }, 'Sent from this computer. StreamSnag has no servers.')),
        row('AI use', h('b', { class: 'ask-usage' }, c.usage)),
        row('Cost', h('span', { class: 'ask-cost' }, h('b', {}, c.cost.lead), ` ${c.cost.rest}`)),
        c.then ? row('Then', h('span', { class: 'ask-then' }, c.then)) : [],
      ].flat())),
    h('div', { class: 'ask-foot' },
      h('button', { class: 'quiet', onclick: closeAiSheet }, 'Not now'),
      h('button', { class: 'primary', id: 'ask-go', onclick: sendToAi }, 'Ask your AI')),
  ];
}

/** What the AI's answer came to, in plain words; the rule it wrote and what it said are one fold away. */
function aiAnswer(r) {
  const words = findOutcome({ found: r.found, fresh: r.fresh ?? r.found, captions: r.captions, named: r.named, refused: r.refused?.length || 0 });
  const undo = h('button', { class: 'link', id: 'btn-undo-rule', onclick: () => send('undoRule').then(refresh).catch((e) => banner(e.message, true)) }, 'Undo');
  const pages = r.pages || [];
  const report = [r.summary, r.advice, r.recipe ? `Rule for ${r.recipe.site}:\n${JSON.stringify(r.recipe, null, 1)}` : '', r.recipeError ? `Rule not usable: ${r.recipeError}` : '',
    r.recipeTest?.log?.length ? `Tried on this page:\n${r.recipeTest.log.join('\n')}` : ''].filter(Boolean).join('\n\n');
  return [
    h('p', { class: 'ai-outcome' }, h('strong', {}, words.title)),
    ...words.lines.map((line) => h('p', { class: 'muted small' }, line)),
    // It will be found by itself from now on: said in one line, with the way back.
    r.saved && !r.saved.undone ? h('p', { class: 'remembered' }, h('span', {}, rememberedLine(r.saved.site, r.saved.what)), ' ', undo) : null,
    r.saved?.undone ? h('p', { class: 'remembered muted' }, forgottenLine(r.saved.site)) : null,
    (r.fresh ?? r.found) > 0 && !r.saved ? h('p', { class: 'muted small once-only' }, ONCE_ONLY) : null,
    // (Only when no video was found: a player's own page is somewhere else to look, not one more thing to read.)
    !r.found && pages.length ? h('div', { class: 'ai-pages' }, h('span', {}, 'The video may be in a player with a page of its own: '),
      ...pages.flatMap((c, i) => [i ? ' · ' : '', h('a', { href: c.url, target: '_blank', rel: 'noreferrer', title: c.url }, `Open ${hostOf(c.url)}`)])) : null,
    // (Its own words, when they are short and plain; what it said about the machinery is under Details.)
    !r.found && plainAdvice(r.advice) ? h('p', { class: 'muted ai-said' }, `What it said: ${plainAdvice(r.advice)}`) : null,
    // @site-edition
    !r.found ? ytdlpFallback(state.page.url) : null,
    // @end-site-edition
    h('details', { class: 'fold ai-details' }, h('summary', {}, 'Details'),
      r.via ? h('p', { class: 'muted small' }, `Answered by ${r.via}.`) : null,
      h('pre', {}, report || 'Nothing more was said.'),
      h('div', { class: 'job-actions' },
        h('button', { class: 'secondary', onclick: () => copy(report, 'Report copied') }, 'Copy report'),
        h('button', { class: 'secondary', title: 'The rules saved for sites are listed in Settings, under Backup & advanced', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#backup') }) }, 'Open Settings'))),
    h('div', { class: 'job-actions' }, h('button', { class: 'link', onclick: () => { aiClosed = r.at; render(); } }, 'Close')),
  ].filter(Boolean);
}

function renderAi() {
  const sec = $('#ai-section');
  const panel = $('#ai-panel');
  const r = state?.aiResult && state.aiResult.at !== aiClosed ? state.aiResult : null;
  const sig = JSON.stringify([aiState ? [Object.keys(aiState), aiState.action] : null, r || null, /* @site-edition */ hasYtdlp(), /* @end-site-edition */ ]);
  if (sig === aiSig) return;
  aiSig = sig;
  const sheet = !!aiState?.confirm;
  sec.classList.toggle('ask-sheet', sheet);
  document.body.classList.toggle('asking', sheet);
  for (const [k, v] of Object.entries({ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ask-title', tabindex: '-1' })) {
    if (sheet) sec.setAttribute(k, v); else sec.removeAttribute(k);
  }
  if (!aiState && !r) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  if (sheet) {
    panel.replaceChildren(...aiSheet(aiState.confirm));
    sec.focus();
    return;
  }
  if (aiState) {
    panel.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), aiState.busy ? 'Your AI is looking at this page…' : ASKS[aiState.action || 'find'].reading));
    return;
  }
  panel.replaceChildren(...aiAnswer(r));
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
  const { summary, markdown, via, note } = summaryState.result;
  // append() would print an empty slot as the word "null": keep only what is there.
  panel.append(...[
    h('strong', { dir: 'auto' }, summary.title || state.page.title),
    h('p', {}, summary.summary),
    summary.keyPoints.length ? h('ul', {}, summary.keyPoints.map((k) => h('li', {}, k.timestamp ? h('strong', {}, `${k.timestamp} `) : null, k.point))) : null,
    note ? h('p', { class: 'muted small' }, note) : null, // a long video was condensed, or some captions could not be read
    h('p', { class: 'muted small' }, via),
    h('div', { class: 'job-actions' },
      h('button', { class: 'secondary', onclick: () => copy(markdown, 'Summary copied') }, 'Copy'),
      h('button', { class: 'secondary', onclick: () => send('saveSummary', { markdown, title: summary.title || state.page.title }).then(() => banner('Saved .md file')) }, 'Save .md'),
      h('button', { class: 'link', onclick: () => { summaryState = null; render(); } }, 'Close'),
    ),
  ].filter(Boolean));
}

/**
 * "Summarize this lecture" / "Summarize captions", first click: nothing is sent. The captions are read, and
 * the sheet says what would be sent, to whom and at whose cost (askFirst); its button sends (sendToAi).
 */
const summarize = (mediaId) => askFirst('summary', { mediaId });

// ------------------------------------------------------------------ transcript & study notes

let studySig = '';
function renderStudy() {
  const sec = studySection;
  const panel = studyPanel;
  paintPack();
  const sig = JSON.stringify([studyState, packSig()]);
  if (sig === studySig) return;
  studySig = sig;
  if (!studyState) {
    sec.hidden = true;
    return;
  }
  if (studyState.what === 'pack') {
    renderStudyPack(sec, panel);
    return;
  }
  if (studyState.what === 'read') {
    renderReading(sec, panel);
    return;
  }
  if (studyState.what === 'page') {
    renderStudyPage(sec, panel);
    return;
  }
  const notes = studyState.what === 'notes';
  const close = h('button', { class: 'link', onclick: () => { studyState = null; render(); } }, 'Close');
  sec.hidden = false;
  studySection.querySelector('#study-title').textContent = notes ? 'Study notes' : 'Transcript';
  panel.replaceChildren();
  if (studyState.loading) {
    panel.append(h('div', { class: 'loading' }, h('div', { class: 'spinner' }),
      notes ? 'Reading captions and writing study notes. This can take a minute…' : 'Reading captions…'));
  } else if (studyState.error) {
    panel.append(h('p', { class: 'status err' }, studyState.error), h('div', { class: 'job-actions' }, close));
  } else {
    const r = studyState.result;
    const c = r.counts || {};
    const made = [[c.keyPoints, 'key point'], [c.terms, 'term'], [c.questions, 'question'], [c.flashcards, 'flashcard']]
      .filter(([n]) => n).map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`).join(', ');
    // append() would print an empty slot as the word "null": keep only what is there.
    panel.append(...[
      h('strong', { dir: 'auto' }, r.title),
      h('p', {}, notes ? `Study notes saved${made ? `: ${made}` : ''}.` : 'Transcript saved.'),
      // One line per saved file; the full path is the tooltip.
      ...r.files.map((f) => h('div', { class: 'saved-file' },
        h('span', { class: 'fname', title: f.path, dir: 'auto' }, f.name),
        h('button', { class: 'secondary', onclick: () => showFile({ downloadId: f.downloadId, file: f.path }) }, 'Show file'))),
      r.files.some((f) => f.kind === 'flashcards') ? h('p', { class: 'muted small' }, 'To study the flashcards in Anki: File, then Import, and choose the flashcards file.') : null,
      r.note ? h('p', { class: 'muted small' }, r.note) : null,
      notes && r.via ? h('p', { class: 'muted small' }, r.via) : null,
      // The same words as an article: offered where a transcript was just saved.
      h('div', { class: 'job-actions' }, !notes && studyState.mediaId ? h('button', { class: 'secondary', title: 'The lecture as an article you can read instead of watching', onclick: () => readLecture(studyState.mediaId) }, 'Read the lecture') : null, close),
    ].filter(Boolean));
  }
  // The panel sits under the list: bring it into view when it changes.
  sec.scrollIntoView({ block: 'nearest' });
}

async function saveTranscript(mediaId) {
  if (studyState?.loading) return;
  studyState = { what: 'transcript', loading: true, mediaId };
  render();
  try {
    studyState = { what: 'transcript', result: await send('saveTranscript', { mediaId }), mediaId };
    // (No banner: the panel that opens says "Transcript saved." and names the file. Said once.)
  } catch (e) {
    studyState = { what: 'transcript', error: e.message, mediaId };
  }
  await refresh(); // the stop shows what was just made
  render();
}

/**
 * "Make study page" in the same panel: {what: 'page', loading} | {what, choose, guess, mediaId} (several
 * files on the page that could be the slides, PDFs or PowerPoint files: which one is it?) | {what, result} | {what, error}.
 */
/** Said above the list of files when it cannot be told which one is a lecture's slides. */
const WHICH_SLIDES = 'This page has several files that could be the slides (PDF or PowerPoint).';
/** The type of a file in that list ("PDF", "PowerPoint"…), as a small label after its name. */
const docKind = (type) => (type ? h('span', { class: 'doc-kind' }, type) : null);
/** What is said after a file in that list: that it is the best guess, or that it is too old a file to be read. */
const docHint = (d, guess) => (d.id === guess ? 'best guess' : d.old ? 'cannot be read' : '');
/** The page's files that sit in its footer or a menu (a privacy policy, a press kit), by id: never guessed to be a lecture's slides. */
const asideDocs = () => (state?.docs || []).filter((d) => page.aside.has(d.url)).map((d) => d.id);
/**
 * The files of "which one is the slides?", as radio buttons: the page's own first; the ones from its
 * footer or menu last, under a plain label of their own.
 */
function slideOptions(choose, guess, option) {
  const own = choose.filter((d) => !d.aside);
  const side = choose.filter((d) => d.aside);
  const row = (d) => option(d.id, d.name, docHint(d, guess), d.type);
  return [...own.map(row), side.length ? h('p', { class: 'menu-label pick-aside' }, ASIDE_GROUP) : null, ...side.map(row)].filter(Boolean);
}
function renderStudyPage(sec, panel) {
  const close = h('button', { class: 'link', onclick: () => { studyState = null; render(); } }, 'Close');
  sec.hidden = false;
  studySection.querySelector('#study-title').textContent = 'Study page';
  panel.replaceChildren();
  if (studyState.loading) {
    panel.append(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Reading the slides and lining them up with the captions…'));
  } else if (studyState.error) {
    panel.append(h('p', { class: 'status err' }, studyState.error), h('div', { class: 'job-actions' }, close));
  } else if (studyState.choose) {
    const { choose, guess, mediaId } = studyState;
    const option = (id, label, hint, type) => h('label', { class: 'pick-doc' },
      h('input', { type: 'radio', name: 'study-doc', value: id, checked: id === guess }),
      h('span', { class: 'fname', title: label, dir: 'auto' }, label), docKind(type), hint ? h('span', { class: 'muted small' }, hint) : null);
    panel.append(
      h('p', {}, `${WHICH_SLIDES} Which one is it for this video?`),
      h('div', { class: 'pick-docs', role: 'radiogroup', 'aria-label': 'Slides for this video' },
        slideOptions(choose, guess, option),
        option('none', 'No slides', 'video and transcript only')),
      h('div', { class: 'job-actions' },
        h('button', { class: 'primary', onclick: () => makeStudyPage(mediaId, panel.querySelector('input[name="study-doc"]:checked')?.value || guess) }, 'Make study page'),
        close),
    );
  } else {
    const r = studyState.result;
    // append() would print an empty slot as the word "null": keep only what is there.
    // One way in: "Open study page". The page's own file is listed under the button; what was saved with it comes under "Also saved".
    const main = r.files.find((f) => f.kind === 'study') || r.files.find((f) => /\.study(?: \(\d+\))?\.html$/i.test(f.name));
    const others = r.files.filter((f) => f !== main);
    // The names differ only at the end: a long one is cut before ".slides.pdf", not through it.
    const fileRow = (f) => {
      const [, stem, tail] = /^(.*?)(\.(?:study|slides)(?: \(\d+\))?\.[a-z0-9]+)?$/i.exec(f.name);
      return h('div', { class: 'saved-file' },
        h('span', { class: 'fname split', title: f.path, dir: 'auto' }, h('span', { class: 'fbase' }, stem), tail ? h('span', { class: 'ftail' }, tail) : null),
        h('button', { class: 'secondary', onclick: () => showFile({ downloadId: f.downloadId, file: f.path }) }, 'Show file'));
    };
    const openPage = () => send('openMade', { mediaId: studyState.mediaId, kind: 'page' })
      .then((res) => { if (res?.opened === 'folder') banner(res.why); })
      .catch((e) => banner(e.message, true));
    panel.append(...[
      h('strong', { dir: 'auto' }, r.title),
      h('p', {}, `Study page saved. ${r.summary}`),
      main ? h('div', { class: 'job-actions pack-open' },
        h('button', { class: 'primary', 'data-act': 'open-study-page', title: 'Opens in your browser. It needs no internet.', onclick: openPage }, 'Open study page')) : null,
      main ? fileRow(main) : null,
      main && others.length ? h('p', { class: 'menu-label also-saved' }, 'Also saved') : null,
      ...(main ? others : r.files).map(fileRow),
      r.video ? null : h('p', { class: 'muted small' }, 'The video is not downloaded yet. Download it, then make the study page again to watch it on the page.'),
      r.extra ? h('p', { class: 'muted small' }, r.extra) : null,
      r.note ? h('p', { class: 'muted small' }, r.note) : null,
      h('div', { class: 'job-actions' }, close),
    ].filter(Boolean));
  }
  sec.scrollIntoView({ block: 'nearest' });
}

async function makeStudyPage(mediaId, docId = '') {
  if (studyState?.loading) return;
  const again = () => makeStudyPage(mediaId, docId);
  if (proNote(mediaId, null, again)) return;
  studyState = { what: 'page', loading: true, mediaId };
  render();
  try {
    const result = await send('makeStudyPage', { mediaId, docId, aside: asideDocs() });
    if (result.choose) studyState = { what: 'page', choose: result.choose, guess: result.guess, mediaId };
    else {
      studyState = { what: 'page', result, mediaId };
      // (No banner: the panel that opens says "Study page saved." and what was matched. Said once.)
    }
  } catch (e) {
    if (!proNote(mediaId, e, again)) studyState = { what: 'page', error: e.message, mediaId };
  }
  await refresh(); // the stop shows what was just made
}

// ------------------------------------------------------------------ study pack
// "Make study pack": AI writes a study guide, practice questions and flashcards from a lecture. It runs as
// a job in the worker (it goes on when this window closes); the panel under the list follows that job.

let closedPack = ''; // the study pack whose panel was closed: it is not brought back on the next refresh
try { closedPack = localStorage.getItem('ss-pack-closed') || ''; } catch { /* storage unavailable */ }

/** The study pack job of a video on this page: the one being made, else the last one that finished. */
function packJobFor(m) {
  const mine = (state?.jobs || []).filter((j) => j.kind === 'studypack' && j.forMedia === m.id);
  return mine.find((j) => ACTIVE.includes(j.status)) || mine.find((j) => j.status === 'done') || null;
}

/** Without an AI account there is nothing to write the pack: say so, and open Settings where one is chosen. */
function needAi() {
  banner('Study packs are written by an AI account you choose. Settings is opening on the AI tab.', true);
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#ai') });
}

function openGuide(j) {
  send('openStudyGuide', { jobId: j.id })
    .then((r) => { if (r.opened === 'folder') banner(r.why); })
    .catch((e) => banner(e.message, true));
}

const openReviewPage = (deck = '') => chrome.tabs.create({ url: chrome.runtime.getURL(`review.html${deck ? `?deck=${encodeURIComponent(deck)}` : ''}`) });

/** Ask the worker to make a study pack. It answers with a question (which slides? send this?) or with the job it started. */
async function makeStudyPack(mediaId, { docId = '', confirmed = false, skipShort = false, parts = null, choice = null, styleId = '', courseDefault } = {}) {
  if (studyState?.loading) return;
  const again = () => makeStudyPack(mediaId, { docId, confirmed, skipShort, parts, choice, styleId, courseDefault });
  if (proNote(mediaId, null, again)) return; // (before the AI account: a locked lecture is told about Pro first)
  if (!state?.ai?.configured) {
    needAi();
    return;
  }
  studyState = { what: 'pack', loading: true, mediaId };
  render();
  try {
    const res = await send('makeStudyPack', { mediaId, docId, confirmed, skipShort, parts, choice, styleId, courseDefault, aside: asideDocs() });
    if (res.choose) studyState = { what: 'pack', choose: res.choose, guess: res.guess, mediaId };
    else if (res.confirm) studyState = { what: 'pack', confirm: res.confirm, title: res.title, mediaId, docId };
    else {
      studyState = { what: 'pack', jobId: res.id, mediaId };
      banner('Making the study pack. You can close this window: it keeps going.');
    }
  } catch (e) {
    if (!proNote(mediaId, e, again)) studyState = { what: 'pack', error: e.message, mediaId };
  }
  await refresh();
}

/** What of the followed job decides how the panel is built (its step and percentage are painted in place). */
function packSig() {
  const j = studyState?.jobId ? (state?.jobs || []).find((x) => x.id === studyState.jobId) : null;
  return j ? [j.status, j.error || '', j.pack ? j.finishedAt : 0] : null;
}

/** Move the running pack's step and bar without rebuilding the panel (Cancel must stay under the pointer). */
function paintPack() {
  const j = studyState?.jobId ? (state?.jobs || []).find((x) => x.id === studyState.jobId) : null;
  const box = studyPanel.querySelector('.pack-running');
  if (!j || !box || !ACTIVE.includes(j.status)) return;
  const p = j.progress || {};
  const step = j.step || 'Making the study pack';
  const text = box.querySelector('.pack-step');
  if (text.textContent !== step) text.textContent = step;
  box.querySelector('.progress > div').style.width = `${jobProgress(j).pct}%`;
  const count = p.total ? `Step ${Math.min(p.done + 1, p.total)} of ${p.total}. ` : '';
  const line = `${count}You can close this window: it keeps going.`;
  const sub = box.querySelector('.pack-count');
  if (sub.textContent !== line) sub.textContent = line;
  pro?.running(box, j);
}

/**
 * The study pack in the panel: {what: 'pack', loading} | {choose, guess, mediaId} (which file is the slides?)
 * | {confirm, mediaId, docId} (what is sent, to whom, how much) | {jobId} (the job: running, saved, failed)
 * | {error}.
 */
function renderStudyPack(sec, panel) {
  const s = studyState;
  const j = s.jobId ? (state.jobs || []).find((x) => x.id === s.jobId) : null;
  const shut = () => {
    if (s.jobId) {
      closedPack = s.jobId;
      remember('ss-pack-closed', closedPack);
    }
    studyState = null;
    render();
  };
  const close = h('button', { class: 'link', onclick: shut }, 'Close');
  const again = (label) => (s.mediaId || j?.forMedia ? h('button', { class: 'secondary', onclick: () => makeStudyPack(s.mediaId || j.forMedia) }, label) : null);
  sec.hidden = false;
  studySection.querySelector('#study-title').textContent = 'Study pack';
  panel.replaceChildren();
  if (s.loading) {
    panel.append(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Getting the lecture ready…'));
  } else if (s.error) {
    panel.append(h('p', { class: 'status err' }, s.error), h('div', { class: 'job-actions' }, ...[again('Try again'), close].filter(Boolean)));
  } else if (s.choose) {
    const option = (id, label, hint, type) => h('label', { class: 'pick-doc' },
      h('input', { type: 'radio', name: 'pack-doc', value: id, checked: id === s.guess }),
      h('span', { class: 'fname', title: label, dir: 'auto' }, label), docKind(type), hint ? h('span', { class: 'muted small' }, hint) : null);
    panel.append(
      h('p', {}, `${WHICH_SLIDES} Which one is it for this lecture?`),
      h('div', { class: 'pick-docs', role: 'radiogroup', 'aria-label': 'Slides for this lecture' },
        slideOptions(s.choose, s.guess, option),
        option('none', 'No slides', 'from the transcript only')),
      h('div', { class: 'job-actions' },
        h('button', { class: 'primary', onclick: () => makeStudyPack(s.mediaId, { docId: panel.querySelector('input[name="pack-doc"]:checked')?.value || s.guess }) }, 'Continue'),
        close),
    );
  } else if (s.confirm) {
    // What will be sent, to whom, and what it takes: the before-AI sheet. The parts are ticked as in Settings;
    // unticking one there leaves it out of this run only, and the numbers are counted again as boxes change.
    const c = s.confirm;
    pro?.ledger(panel, {
      kind: 'pack', title: s.title || '', confirm: c, cancel: shut,
      go: ({ skipShort, parts, choice, styleId, courseDefault }) => makeStudyPack(s.mediaId, { docId: s.docId, confirmed: true, skipShort, parts, choice, styleId, courseDefault }),
      count: async (sel, choice) => {
        return [];
      },
    });
  } else if (!j) {
    panel.append(h('p', { class: 'muted' }, 'This study pack is no longer in the list.'), h('div', { class: 'job-actions' }, close));
  } else if (ACTIVE.includes(j.status)) {
    panel.append(h('div', { class: 'pack-running' },
      h('strong', { dir: 'auto' }, j.title),
      h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('span', { class: 'pack-step' }, j.step || 'Making the study pack')),
      h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Study pack progress' }, h('div', {})),
      h('p', { class: 'muted small pack-count' }, ''),
      h('div', { class: 'job-actions' },
        h('button', { class: 'secondary danger', onclick: () => send('cancelJob', { jobId: j.id }).then(refresh) }, 'Cancel'),
        close)));
    paintPack();
  } else if (j.status === 'done' && j.pack) {
    const p = j.pack;
    panel.append(...[
      h('strong', { dir: 'auto' }, p.title),
      h('p', {}, `Study pack saved${p.made ? `: ${p.made}` : ''}.`),
      h('div', { class: 'job-actions pack-open' },
        p.guide ? h('button', { class: 'primary', onclick: () => openGuide(j) }, 'Open study guide') : null,
        p.cards && p.deck ? h('button', { class: 'secondary', title: 'Go through the flashcards here, a few each day. Every card can show you its place in the lecture.', onclick: () => openReviewPage(p.deck) }, 'Review cards') : null,
        p.read ? h('button', { class: 'secondary', title: 'The lecture as an article, made with this pack', onclick: () => openRead({ jobId: j.id }) }, 'Open reading edition')
          : s.mediaId || j.forMedia ? h('button', { class: 'secondary', title: 'The lecture as an article you can read instead of watching', onclick: () => readLecture(s.mediaId || j.forMedia) }, 'Read the lecture') : null),
      // One line per saved file; the names differ only at the end, so a long one is cut before ".guide.html".
      ...p.files.map((f) => {
        const [, stem, tail] = /^(.*?)(\.(?:guide|study|slides|transcript|flashcards|read)(?: \(\d+\))?\.[a-z0-9]+)?$/i.exec(f.name);
        return h('div', { class: 'saved-file' },
          h('span', { class: 'fname split', title: f.path, dir: 'auto' }, h('span', { class: 'fbase' }, stem), tail ? h('span', { class: 'ftail' }, tail) : null),
          h('button', { class: 'secondary', onclick: () => showFile({ downloadId: f.downloadId, file: f.path }) }, 'Show file'));
      }),
      p.notes?.length ? h('ul', { class: 'pack-notes muted small' }, p.notes.map((n) => h('li', {}, n))) : null,
      h('p', { class: 'muted small' }, [p.via ? `Written by ${p.via}.` : '', 'Check anything important against the lecture itself.'].filter(Boolean).join(' ')),
      p.cards ? h('p', { class: 'muted small' }, 'To use the flashcards in Anki instead: File, then Import, and choose the flashcards file.') : null,
      h('div', { class: 'job-actions' }, close),
    ].filter(Boolean));
  } else {
    const canceled = j.status === 'canceled';
    panel.append(
      h('p', { class: canceled ? 'muted' : 'status err' }, canceled ? 'Canceled. What was finished is kept, so making it again carries on from there.' : j.error || 'The study pack could not be made.'),
      h('div', { class: 'job-actions' }, ...[again(canceled ? 'Make study pack' : 'Try again'), close].filter(Boolean)));
  }
  sec.scrollIntoView({ block: 'nearest' });
}

/** A study pack being made for this tab (started here, or on its own after a download) gets its panel without a click. */
const readSeen = new Set(); // tidying jobs this window started or saw running
const readOpened = new Set(); // the ones it has opened

/** A reading edition that was being tidied here has finished: open it, once (the click that asked for it was "Read the lecture"). */
function openFinishedRead() {
  const j = studyState?.what === 'read' && studyState.jobId ? (state?.jobs || []).find((x) => x.id === studyState.jobId) : null;
  if (!j) return;
  if (ACTIVE.includes(j.status) || j.status === 'queued') { readSeen.add(j.id); return; }
  // Only one this window saw running: a finished one found on reopening the popup is not sprung on you.
  if (j.status !== 'done' || !j.reading?.read || !readSeen.has(j.id) || readOpened.has(j.id)) return;
  readOpened.add(j.id);
  openRead({ jobId: j.id });
}

function followPack() {
  if (studyState || !state) return;
  const mine = (state.jobs || []).filter((j) => (j.kind === 'studypack' || j.kind === 'reading') && j.tabId === tabId && j.id !== closedPack);
  const j = mine.find((x) => ACTIVE.includes(x.status)) || mine.find((x) => x.status === 'done' && Date.now() - x.finishedAt < 10 * 60 * 1000);
  if (!j) return;
  studyState = { what: j.kind === 'reading' ? 'read' : 'pack', jobId: j.id, mediaId: j.forMedia || '' };
  render();
}

// ------------------------------------------------------------------ reading edition
// "Read the lecture": the lecture as an article, saved next to the video. Without AI it is made at once;
// "Tidy with AI" is asked about first, then runs as a job in the worker (it goes on when this window closes).

function openRead(which) {
  send('openReading', which)
    .then((r) => { if (r.opened === 'folder') banner(r.why); })
    .catch((e) => banner(e.message, true));
}

/** Ask the worker for a lecture's reading edition. It answers with a question (which slides? tidy with AI?), with the saved files, or with the job it started. */
async function readLecture(mediaId, { docId = '', tidy } = {}) {
  if (studyState?.loading) return;
  const again = () => readLecture(mediaId, { docId, tidy });
  if (proNote(mediaId, null, again)) return;
  studyState = { what: 'read', loading: true, tidy: tidy === true, mediaId };
  render();
  try {
    const res = await send('makeReadingEdition', { mediaId, docId, tidy, aside: asideDocs() });
    if (res.choose) studyState = { what: 'read', choose: res.choose, guess: res.guess, mediaId, tidy };
    else if (res.confirm) studyState = { what: 'read', confirm: res.confirm, title: res.title, mediaId, docId };
    else if (res.result) {
      studyState = { what: 'read', result: res.result, mediaId };
      // (No banner: the panel that opens says "Reading edition saved" and what it holds. Said once.)
      // "Read the lecture" means reading it: the edition opens as soon as it is made (no second click).
      openRead({ key: res.result.key });
    } else {
      studyState = { what: 'read', jobId: res.id, mediaId };
      readSeen.add(res.id); // it opens by itself when it is ready, if this window is still here
      banner('Tidying the reading edition. It opens when it is ready; you can close this window and it keeps going.');
    }
  } catch (e) {
    if (!proNote(mediaId, e, again)) studyState = { what: 'read', error: e.message, mediaId };
  }
  await refresh();
}

/**
 * The reading edition in the panel: {what: 'read', loading} | {choose, guess, mediaId} (which file is the
 * slides?) | {confirm, mediaId, docId} (tidy with AI, or make it without?) | {result} (made without AI)
 * | {jobId} (being tidied, saved, failed) | {error}.
 */
function renderReading(sec, panel) {
  const s = studyState;
  const j = s.jobId ? (state.jobs || []).find((x) => x.id === s.jobId) : null;
  const shut = () => {
    if (s.jobId) {
      closedPack = s.jobId;
      remember('ss-pack-closed', closedPack);
    }
    studyState = null;
    render();
  };
  const close = h('button', { class: 'link', onclick: shut }, 'Close');
  const media = s.mediaId || j?.forMedia || '';
  // One line per saved file; the two names differ only at the end, so a long one is cut before ".read.html".
  const fileRows = (files) => (files || []).map((f) => {
    const [, stem, tail] = /^(.*?)(\.read(?: \(\d+\))?\.[a-z0-9]+)?$/i.exec(f.name);
    return h('div', { class: 'saved-file' },
      h('span', { class: 'fname split', title: f.path, dir: 'auto' }, h('span', { class: 'fbase' }, stem), tail ? h('span', { class: 'ftail' }, tail) : null),
      h('button', { class: 'secondary', onclick: () => showFile({ downloadId: f.downloadId, file: f.path }) }, 'Show file'));
  });
  const saved = (r, which, last) => [
    h('strong', { dir: 'auto' }, r.title),
    h('p', {}, `Reading edition saved${r.made ? `: ${r.made}` : ''}.`),
    h('div', { class: 'job-actions pack-open' }, h('button', { class: 'primary', onclick: () => openRead(which) }, 'Open reading edition')),
    ...fileRows(r.files),
    r.notes?.length ? h('ul', { class: 'pack-notes muted small' }, r.notes.map((n) => h('li', {}, n))) : null,
    h('p', { class: 'muted small read-how' }, last),
    h('div', { class: 'job-actions' }, close),
  ].filter(Boolean);
  sec.hidden = false;
  studySection.querySelector('#study-title').textContent = 'Reading edition';
  panel.replaceChildren();
  if (s.loading) {
    panel.append(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), s.tidy ? 'Getting the lecture ready…' : 'Making the reading edition…'));
  } else if (s.error) {
    panel.append(h('p', { class: 'status err' }, s.error),
      h('div', { class: 'job-actions' }, ...[media ? h('button', { class: 'secondary', onclick: () => readLecture(media) }, 'Try again') : null, close].filter(Boolean)));
  } else if (s.choose) {
    const option = (id, label, hint, type) => h('label', { class: 'pick-doc' },
      h('input', { type: 'radio', name: 'read-doc', value: id, checked: id === s.guess }),
      h('span', { class: 'fname', title: label, dir: 'auto' }, label), docKind(type), hint ? h('span', { class: 'muted small' }, hint) : null);
    panel.append(
      h('p', {}, `${WHICH_SLIDES} Which one is it for this lecture?`),
      h('div', { class: 'pick-docs', role: 'radiogroup', 'aria-label': 'Slides for this lecture' },
        slideOptions(s.choose, s.guess, option),
        option('none', 'No slides', 'from the captions only')),
      h('div', { class: 'job-actions' },
        h('button', { class: 'primary', onclick: () => readLecture(s.mediaId, { docId: panel.querySelector('input[name="read-doc"]:checked')?.value || s.guess, tidy: s.tidy }) }, 'Continue'),
        close),
    );
  } else if (s.confirm && pro) {
    // The student's choice, each time, on the same before-AI sheet as a study pack.
    pro.ledger(panel, {
      kind: 'read', title: s.title || '', confirm: s.confirm, cancel: shut,
      go: () => readLecture(s.mediaId, { docId: s.docId, tidy: true }),
      plain: () => readLecture(s.mediaId, { docId: s.docId, tidy: false }),
    });
  } else if (s.confirm) {
    // Without the study tools (a caption file's own "Read the lecture"): the same question, in the panel.
    const c = s.confirm;
    panel.append(...[
      h('strong', { dir: 'auto' }, s.title || 'Read the lecture'),
      h('p', { class: 'read-ask' }, 'Have AI tidy the wording?'),
      h('p', { class: 'muted small read-what' }, c.what),
      h('p', { class: 'pack-sends read-sends' }, c.sends),
      c.images ? h('p', { class: 'muted small read-images' }, c.images) : null,
      h('p', { class: 'pack-usage read-usage' }, c.usage),
      c.long ? h('p', { class: 'muted small' }, `This is a long lecture (about ${c.minutes} minutes), so it takes more than most.`) : null,
      h('p', { class: 'muted small' }, c.rules),
      h('div', { class: 'job-actions' },
        h('button', { class: 'primary', onclick: () => readLecture(s.mediaId, { docId: s.docId, tidy: true }) }, 'Tidy with AI'),
        h('button', { class: 'secondary', title: 'Made on this computer; nothing is sent anywhere', onclick: () => readLecture(s.mediaId, { docId: s.docId, tidy: false }) }, 'Make it without AI'),
        h('button', { class: 'link', onclick: shut }, 'Cancel')),
    ].filter(Boolean));
  } else if (s.result) {
    panel.append(...saved(s.result, { key: s.result.key }, 'Made on this computer from the captions. Nothing was sent anywhere.'));
  } else if (!j) {
    panel.append(h('p', { class: 'muted' }, 'This reading edition is no longer in the list.'), h('div', { class: 'job-actions' }, close));
  } else if (ACTIVE.includes(j.status)) {
    panel.append(h('div', { class: 'pack-running' },
      h('strong', { dir: 'auto' }, j.title),
      h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('span', { class: 'pack-step' }, j.step || 'Tidying the reading edition')),
      h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Reading edition progress' }, h('div', {})),
      h('p', { class: 'muted small pack-count' }, ''),
      h('div', { class: 'job-actions' },
        h('button', { class: 'secondary danger', onclick: () => send('cancelJob', { jobId: j.id }).then(refresh) }, 'Cancel'),
        close)));
    paintPack();
  } else if (j.status === 'done' && j.reading) {
    panel.append(...saved(j.reading, { jobId: j.id }, [j.reading.via ? `Tidied by ${j.reading.via}.` : '', 'The time next to each paragraph lets you check the original.'].filter(Boolean).join(' ')));
  } else {
    const canceled = j.status === 'canceled';
    panel.append(
      h('p', { class: canceled ? 'muted' : 'status err' }, canceled ? 'Canceled. What was finished is kept, so tidying it again carries on from there.' : j.error || 'The reading edition could not be made.'),
      h('div', { class: 'job-actions' }, ...[
        media ? h('button', { class: 'secondary', onclick: () => readLecture(media, { tidy: true }) }, canceled ? 'Tidy with AI' : 'Try again') : null,
        media ? h('button', { class: 'secondary', onclick: () => readLecture(media, { tidy: false }) }, 'Make it without AI') : null,
        close].filter(Boolean)));
  }
  sec.scrollIntoView({ block: 'nearest' });
}

// @site-edition
/** Hand a page to yt-dlp through the helper: `pageUrl` (the page a failed download came from), else the tab's own. */
async function runYtdlp(pageUrl = '') {
  try {
    await send('ytdlp', typeof pageUrl === 'string' && isHttpUrl(pageUrl) ? { url: pageUrl } : {});
    banner('Started. Its progress is in Activity.');
    refresh();
  } catch (e) {
    banner(e.message, true);
  }
}
// @end-site-edition

// ------------------------------------------------------------------ render loop

function historyCard(x) {
  const files = x.files || [];
  const note = plainNote(x.note);
  return h('li', { class: 'card' },
    h('div', { class: 'meta' },
      nameEl(x.title || baseName(files[0]), `h:${x.at}`),
      h('div', { class: 'sub', title: hostOf(x.pageUrl || x.mediaUrl) }, h('span', { class: 'st st-done' }, ICON.check()), ` ${ago(x.at)}`, x.bytes ? ` · ${formatBytes(x.bytes)}` : '',
        files[0] && /[\\/]/.test(files[0]) ? ` · ${savedWords(files[0], typeof x.folder === 'string' ? x.folder : null)}` : ''),
      files.length ? nameEl(files.map(baseName).join(' + '), `hf:${x.at}`, 'sub') : null,
      // What else was done to it, in plain words and in full (it wraps); what the tool itself reported is the tooltip.
      note.text ? h('div', { class: 'sub muted saved-note', title: note.detail || note.text }, note.text) : null,
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
  // The video playing in the page (or the one you paused) comes first. Otherwise the newest; and once
  // shown it stays, so a video found a second later doesn't swap the card under your pointer (opening the
  // popup again starts fresh). An ad or a short clip is passed over while the page has a real video: a
  // pre-roll that starts playing does not push the lecture off the card (lib/review.js: heroChoice).
  const pick = heroChoice(candidates, { playing: state.playing, kept: heroId, flags: pageFlags });
  if (!pick) return null;
  heroWhy = pick.why;
  heroId = pick.id;
  return candidates.find((m) => m.id === pick.id);
}

function groupHeading(g) {
  return h('li', { class: 'group-h' }, h('span', { class: 'gname', title: g.group, dir: 'auto' }, g.group), h('span', { class: 'gcount' }, `${g.done}/${g.n} saved`));
}

let libSig = '';
/**
 * The folder check's one line, only when it matters: it found some of this page's recordings in your
 * folders (or lost one it knew), or it could not look. Its controls (check now, the folders it looks in)
 * are in Settings, on the Downloads tab.
 */
function renderLibrary() {
  const lib = state.library;
  const box = $('#library');
  const vids = state.media.filter((m) => m.kind !== 'subtitle' && !m.playlist);
  // A match the check itself made (by size, length, id or name: a file saved by another tool, or renamed since).
  // A file StreamSnag saved and that is still where it put it is no news: its own line says where it is.
  const found = vids.filter((m) => m.library?.path && !m.library.missing && !['manual', 'history'].includes(m.library.how)).length;
  const gone = vids.filter((m) => m.library?.missing).length;
  const maybe = vids.filter((m) => m.maybe && !(m.library?.path && !m.library.missing)).length;
  const one = vids.length === 1;
  const noun = nounFor(vids, 1);
  const text = lib?.error
    ? `Your folders could not be checked. ${lib.error}`.replace(/[.!?]\s*$/, '')
    : [found ? (one ? `This ${noun} was found in your folders` : `${found} of the ${vids.length} ${nounFor(vids, vids.length)} here ${found === 1 ? 'was' : 'were'} found in your folders`) : '',
      gone ? (one ? `This ${noun} is no longer where it was saved` : `${gone} ${gone === 1 ? 'is' : 'are'} no longer where ${gone === 1 ? 'it was' : 'they were'} saved`) : '',
      maybe && !found ? (one ? `This ${noun} may already be in your folders` : `${maybe} may already be in your folders`) : ''].filter(Boolean).join(' · ');
  box.hidden = !text;
  if (box.hidden) { libSig = ''; return; }
  const dirs = lib?.dirs || [];
  const sig = JSON.stringify([text, dirs]);
  if (sig === libSig) return;
  libSig = sig;
  box.title = dirs.length ? `Folders checked:\n${dirs.join('\n')}` : '';
  box.classList.toggle('err', !!lib?.error);
  box.replaceChildren(ICON.folder(), h('span', { class: 'lib-text' }, `${text}.`),
    h('button', { class: 'link small', id: 'lib-settings', title: 'Which folders are checked, and "Check now", are in Settings on the Downloads tab', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#downloads') }) }, 'Folder settings'));
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
    // (No banner: the file's own row says it is downloading, then "Downloaded".)
  } catch (e) {
    banner(e.message, true);
  }
  refresh();
}

function docCard(d, st) {
  const busy = st === 'active' || st === 'queued';
  const label = st === 'done' ? 'Download again' : st === 'failed' ? 'Try again' : 'Download';
  // An archive is said to be one, with its size when the page gave it: it may be gigabytes.
  const facts = [d.bundle ? 'ZIP archive' : '', d.size ? formatBytes(d.size) : ''].filter(Boolean).join(' · ');
  return h('li', { class: `card is-${st}` },
    h('div', { class: 'row' },
      h('div', { class: 'thumb subtitle' }, d.label),
      h('div', { class: 'meta' },
        nameEl(d.name, `d:${d.id}`),
        st !== 'new' || facts ? h('div', { class: 'sub', title: facts || null }, st !== 'new' ? h('span', { class: 'stw' }, stTag(st), facts ? ' · ' : '') : null, facts) : null,
      ),
      busy ? null : h('button', { class: 'primary dl', title: label, 'aria-label': `${label}: ${d.name}`, onclick: () => downloadDoc(d) }, ICON.download()),
    ));
}

/**
 * The documents the page links to, in their own collapsed group: never mixed into the videos or their
 * counts. A long list is grouped by type with a count each, folded past a dozen ("Show all N") and, past
 * twenty, has a find-by-name box (lib/wording.js: docRows). Files linked only from the page's footer or
 * menus (legal PDFs, press kits) are not counted as the page's files; they are listed last when the list is
 * opened in full. "Download all" opens the review sheet: nothing starts on that one click.
 */
function renderDocs() {
  const docs = state.docs || [];
  const box = $('#docs-box');
  box.hidden = !docs.length;
  if (box.hidden) return;
  const st = new Map(docs.map((d) => [d.id, docStatus(d, state.jobs, history)]));
  const list = docRows(docs, { aside: page.aside, query: docsQuery, all: docsAll });
  const mine = mainDocs();
  const shownAs = mine.length ? mine : docs; // a page with nothing but footer links lists those, under their heading
  const done = shownAs.filter((d) => st.get(d.id) === 'done').length;
  const left = mine.filter((d) => inDocsBulk(d) && ['new', 'failed'].includes(st.get(d.id))).length;
  const head = mine.length ? 'Files on this page' : 'Files in this page\'s footer or menu';
  const title = $('#docs-title');
  if (title.textContent !== head) title.textContent = head;
  $('#docs-count').textContent = String(shownAs.length);
  const note = done ? `${done} of ${shownAs.length} downloaded` : mine.length ? docsNote(mine) : 'Site-wide links, such as legal documents';
  $('#docs-note').textContent = note;
  $('#docs-note').title = note; // (the line is cut when it is long: its whole text is one hover away)
  $('#docs-toggle').setAttribute('aria-expanded', String(docsOpen));
  const all = $('#docs-all');
  all.hidden = left < 2;
  if (all.textContent !== `Download all (${left})`) all.textContent = `Download all (${left})`;
  const find = $('#docs-search');
  find.hidden = !docsOpen || !list.find;
  // Shown before it is filled: a name is measured as it is added, and a hidden one measures 0.
  $('#docs').hidden = !docsOpen;
  patchList($('#docs'), docsOpen ? list.rows : [], (d) => (d.group ? `g:${d.group}` : d.id),
    (d) => (d.group ? JSON.stringify(d) : JSON.stringify([d.name, d.url, d.label, d.size || 0, st.get(d.id), expanded.has(`d:${d.id}`)])),
    (d) => (d.group ? h('li', { class: 'group-h' }, h('span', { class: 'gname', title: d.group }, d.group), h('span', { class: 'gcount' }, String(d.n))) : docCard(d, st.get(d.id))));
  // "Show all 94" under a folded list (and the way back); with a name typed in, what was found is all there is.
  const more = $('#docs-more');
  const rest = list.hidden + (docsAll || docsQuery.trim() || !mine.length ? 0 : list.aside);
  more.hidden = !docsOpen || !!docsQuery.trim() || (!docsAll && !rest);
  // "Show all 94" of a folded list; with nothing folded, the way to the files in the page's footer or menu.
  const moreText = docsAll ? 'Show fewer' : list.hidden ? `Show all ${list.total}` : `Also show ${list.aside} from the page's footer or menu`;
  if (more.textContent !== moreText) more.textContent = moreText;
  more.setAttribute('aria-expanded', String(docsAll));
  const nothing = $('#docs-none');
  nothing.hidden = !docsOpen || !docsQuery.trim() || list.rows.length > 0;
}

/**
 * Ask the page itself two things no list can say: whether it has a player that has not loaded its video
 * yet (so the empty state can say "Press play"), and which of its file links sit in its footer or menus
 * (site-wide legal PDFs and press kits are not the page's files). True when the answer changed.
 * Asked when the page or its number of files changes, and now and then while nothing is listed.
 */
async function probePage(force = false) {
  const videos = state.media.filter((m) => m.kind !== 'subtitle').length;
  const key = `${tabId}|${state.page.url}|${state.docs?.length || 0}|${videos > 0}`;
  const stale = !videos && Date.now() - (page.at || 0) > 4000;
  if (!force && page.key === key && !stale) return false;
  const was = JSON.stringify([page.players, page.playing, [...page.aside]]);
  let frames = [];
  if (/^(https?|file):/i.test(state.page.url || '') && chrome.scripting?.executeScript) {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const side = 'footer, nav, [role="contentinfo"], [role="navigation"]';
        const links = [...document.querySelectorAll('a[href]')].filter((a) => /\.[a-z0-9]{2,8}(?:[?#]|$)/i.test(a.getAttribute('href') || '')).slice(0, 600)
          .map((a) => [a.href.split('#')[0], !!a.closest(side)]);
        // A player on the page: a media element, or a frame or box that names itself a player.
        const players = document.querySelectorAll('video, audio, iframe[src*="player" i], iframe[src*="/embed" i], iframe[allow*="autoplay" i], .video-js, .jwplayer, .plyr, [class*="video-player" i]').length;
        // One that is already running (or was): pressing play again would not help.
        const playing = [...document.querySelectorAll('video, audio')].filter((m) => !m.paused || m.currentTime > 0).length;
        return { players, playing, links };
      },
    }).catch(() => []);
  }
  const answers = frames.map((f) => f?.result).filter(Boolean);
  const where = new Map(); // address -> is every link to it in a footer or a menu?
  for (const [href, side] of answers.flatMap((a) => a.links || [])) where.set(href, (where.get(href) ?? true) && side);
  const sum = (k) => answers.reduce((n, a) => n + (a[k] || 0), 0);
  page = { key, at: Date.now(), players: sum('players'), playing: sum('playing'), aside: new Set([...where].filter(([, side]) => side).map(([href]) => href)) };
  return JSON.stringify([page.players, page.playing, [...page.aside]]) !== was;
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
  $('#site').title = state.page.site || ''; // (cut when the window is narrow: its whole name is one hover away)
  renderSetup();
  // Subtitle files are kept apart (collapsed): stream downloads already include their subtitles.
  const videos = state.media.filter((m) => m.kind !== 'subtitle');
  const subs = state.media.filter((m) => m.kind === 'subtitle');
  nameCaptions(subs); // each caption file is called by its language (and its format when two share one)
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
  const statusOf = new Map(withStatus.map(({ m, st }) => [m.id, st]));
  // Why a video might not be one you want (lib/review.js): small tags in the list, and the review sheet's groups.
  pageOrder = new Map((state.order || []).map((id, i) => [id, i]));
  pageFlags = flagItems(withStatus.map(({ m, st }) => reviewItem(m, st)), { site: hostOf(state.page.url || '') });
  offered = shown.map((m) => ({ m, st: statusOf.get(m.id) }));
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
  // The path or the plain downloader for the video in front (the study tools decide; without them, the downloader).
  view = pro ? pro.view({ pref: viewPref, lecture: !!hero }) : 'downloader';
  // (Not under a protected lecture: nothing of it can be saved, so no path is offered from it.)
  $('#view-row').hidden = !pro || !hero || view !== 'downloader' || !!(hero.protected || openMedia.get(hero.id)?.protected);
  $('#btn-view').hidden = !pro || !hero;
  $('#view-title').textContent = view === 'path' ? 'Downloads only' : 'Show the lecture\'s path';
  $('#view-note').textContent = view === 'path' ? 'Only the download controls. The study tools move into the ⋯ menu.' : 'Save, transcript, study page, study pack and review, in order';
  renderCourse(withStatus, hero);
  renderBulk(shown, statusOf);
  if (hero && hasChoices(hero) && !hero.protected && ['new', 'failed', 'missing'].includes(statusFor(hero))) {
    const open = openMedia.get(hero.id);
    if (!open?.options && !open?.loading && !open?.error) loadOptions(hero);
  }
  // The percentage is painted onto the card afterwards (paintProgress): a tick must not rebuild the card.
  const progressSig = (m) => { const j = jobFor(m); return j ? j.status : null; };
  const sig = (m) => m.group ? JSON.stringify(m) : JSON.stringify([
    m.listed, m.playlist ? JSON.stringify(playlistEntries(m)) : '', m.playlistIndex, m.label, m.size, m.seen, m.library, m.fingerprint, m.poster, m.hint, m.title, m.customName, m.course, m.nameSource, m.source, m.alsoAi, m.info, m.duration, m.protected, m.mark, m.section, statusFor(m), progressSig(m), state.page.title, m.localCaptions, state.helper?.stt?.ready,
    PANEL && statusFor(m) === 'done' ? ago(lastDownload(m)?.at) : '', PANEL ? ago(m.detectedAt) : '',
    openMedia.get(m.id) || null, expanded.has(`m:${m.id}`), m === hero ? [activeFilter, heroWhy, heroPick.get(m.id) || '', state.preferredQuality] : '',
    pageFlags.get(m.id) || '', startingIds.has(m.id), /* @site-edition */ hasYtdlp(), /* @end-site-edition */ state.helper?.ok, state.helper?.stt?.supported, captionFileFor(m),
    m.variants || '', m.maybe?.path || '',
    state.ai?.configured, packJobFor(m)?.id || '', packJobFor(m)?.status || '',
    // The path, its squares and the view all show on the card.
    m === hero ? [view, placeOnPage(m), mainDocs().length, docsLeft().length, !!courseCounts, m.made?.transcript || '', statusFor(m) === 'done' ? savedLine(m) : '', transcriptShown(m)] : '', pro && m.kind !== 'subtitle' ? pro.sig(m) : '',
    m.kind === 'subtitle' ? [captionNames.get(m.id) || '', captionNotes.get(m.id) || ''] : '', PANEL && statusFor(m) === 'done' ? savedLine(m) : '',
  ]);
  // A second copy, the same lecture as sound only, a preview or ad, a short clip: folded into one quiet line
  // at the end of the list (never the big card's; nothing when that is all there is; never while searching).
  // "Download all" and the review sheet still have them, exactly as before (lib/review.js: foldedIds).
  const foldOut = foldedIds(shown.filter((m) => !m.group), pageFlags, { hero: hero?.id || '', showAll: !!state.foldOff || !!q });
  const rest = arrange(shown.filter((m) => m !== hero && !foldOut.has(m.id)));
  // Show the boxes before filling them: a name is measured as it is added, and a hidden one measures 0.
  $('#box').hidden = !rest.length && !subs.length && !foldOut.size;
  const foldEl = $('#folded');
  foldEl.hidden = !foldOut.size;
  const foldSaid = foldLine(foldOut, pageFlags);
  if (foldOut.size && foldEl.dataset.said !== foldSaid) {
    foldEl.dataset.said = foldSaid;
    foldEl.replaceChildren(`${foldSaid} · `, h('button', {
      class: 'link small', id: 'btn-show-folded', title: 'Show them in the list, on this page',
      onclick: () => send('showFolded').then(refresh).catch((e) => banner(e.message, true)),
    }, 'Show'));
  } else if (!foldOut.size) delete foldEl.dataset.said;
  $('#media').hidden = !rest.length;
  $('#subs-box').hidden = !subs.length;
  // The caption files stay folded while the card itself offers the lecture's transcript ("Save transcript",
  // or the path's Transcript stop): one way to the same thing in sight. Your own click opens them; where
  // the card offers nothing, the list is as you last left it.
  subsShown = subsPick ?? (hero && hasCaptions(hero) ? false : subsOpen);
  $('#subs').hidden = !subsShown;
  patchList($('#hero'), hero ? [hero] : [], (m) => m.id, sig, heroCard);
  const keyOf = (m) => (m.group ? `g:${m.group}` : m.id);
  const build = (m) => (m.group ? groupHeading(m) : mediaCard(m));
  patchList($('#media'), rest, keyOf, sig, build);
  $('#media-count').textContent = videos.length ? String(videos.length) : '';
  // Media links past the number StreamSnag looks at on one page: said in one line under the list's heading (lib/linked.js).
  const leftOut = leftOutNote(state.links?.left);
  let leftLine = $('#links-left');
  if (leftOut && !leftLine) $('#removed').after(leftLine = h('p', { id: 'links-left', class: 'muted small removed', role: 'status' }));
  if (leftLine) { leftLine.hidden = !leftOut; leftLine.textContent = leftOut; }

  renderDocs();
  const docCount = mainDocs().length; // with files to show, the page is not "nothing found": only its videos are missing
  // A lecture's own page (one recording, no list under it): what else is on the page (its captions, its files, the
  // way to the path) reads as one quiet area under the card, headed "More on this page".
  const quiet = !!hero && !rest.length && !courseCounts;
  $('.main').classList.toggle('calm', quiet);
  $('#more-head').hidden = !quiet || ($('#box').hidden && $('#docs-box').hidden && $('#view-row').hidden && $('#library').hidden);

  const empty = $('#empty');
  const nothing = !videos.length && !subs.length && !docCount;
  // Browser pages (settings, new tab, the extension store) can't be looked at by any extension.
  const webPage = /^(https?|file):/i.test(state.page.url || '');
  // (Also with nothing but caption files listed: a page whose player has not started still says "Press play",
  // above the captions and the files it did find.)
  empty.hidden = shown.length > 0;
  empty.classList.toggle('slim', !nothing);
  // One wording (lib/wording.js), which also fits a page that has no video: it says what was found.
  // One state that describes the page (lib/wording.js): no video and no player, a player that has not
  // started, or files and no video. "Scan again" stays within reach whenever no video is listed.
  // (A page whose player comes only in pieces that are never listed reads as a page with no video: state.page.inPieces.)
  const inPieces = !!state.page.inPieces;
  const words = emptyState({ webPage, videos: videos.length, subs: subs.length, docs: docCount, players: inPieces ? 0 : page.players, playing: inPieces ? 0 : page.playing, filter: activeFilter, query: q ? query.trim() : '', checking: state.links?.checking || 0, lectures: state.page.lectures || 0 });
  empty.querySelector('p strong').textContent = words.title;
  const hint = empty.querySelector('p.muted');
  hint.hidden = !words.hint;
  hint.textContent = words.hint;
  $('#empty-actions').hidden = videos.length > 0 || !webPage;
  $('#empty-tip').hidden = !nothing;
  // Something is listed, and it may not be what was meant: one small link under the card opens the same two actions.
  const wrong = $('#wrong');
  wrong.hidden = !hero || !webPage;
  if (wrong.hidden) wrongOpen = false;
  $('#wrong-box').hidden = !wrongOpen;
  $('#btn-wrong').setAttribute('aria-expanded', String(wrongOpen));
  // (Under a sound recording the link, and the line about an AI account, say "recording": it is never called a video.)
  const sound = !!hero && isAudio(hero);
  if ($('#btn-wrong').textContent !== wrongWords(sound)) $('#btn-wrong').textContent = wrongWords(sound);
  const setUp = $('#wrong-box .ai-setup');
  if (setUp.textContent !== setUpAiWords(sound)) setUp.textContent = setUpAiWords(sound);
  paintRescue();

  // "Captions (2)", with how they are saved only when that is true of this page and these settings.
  const subsHead = captionsHeading(subs.length, captionsTravel(state.media, { settings, ffmpeg: !!(state.helper?.ok && state.helper.tools?.ffmpeg) }));
  if ($('#subs-head').textContent !== subsHead) $('#subs-head').textContent = subsHead;
  $('#subs-toggle').setAttribute('aria-expanded', String(subsShown));
  patchList($('#subs'), subsShown ? subs : [], (m) => m.id, sig, mediaCard);
  // Move the bars of running downloads on the cards that were kept as they are.
  for (const m of state.media) {
    if (!jobFor(m)) continue;
    const card = [...document.querySelectorAll('.items > li')].find((el) => el.dataset.key === m.id);
    if (card) paintProgress(card, m);
  }

  const jobs = state.jobs || [];
  renderActivity(jobs);
  renderTray(jobs);

  // The sidebar has room for a log of what was saved before (across all sites).
  const recent = PANEL ? history.slice(0, 25) : [];
  $('#history-section').hidden = !recent.length;
  if (recent.length) {
    patchList($('#history'), recent, (x) => String(x.at), (x) => JSON.stringify([x.at, ago(x.at), expanded.has(`h:${x.at}`), expanded.has(`hf:${x.at}`)]), historyCard);
  }

  renderAi();
  renderSummary();
  renderStudy();
  // The panel takes its seat on the path's stop (or stays under the list), and the foot gets its Review entry.
  pro?.seat(studySection);
  pro?.dock($('#btn-review'));
  renderReview();

}

async function refresh() {
  try {
    // (The study tools read what they keep of their own, on the same tick: the plan, Autopilot's steps.)
    const [s, stored] = await Promise.all([send('getTabState', { panel: PANEL }), chrome.storage.local.get(['history', 'settings']), pro?.load()]);
    state = s;
    history = stored.history || [];
    settings = stored.settings || {};
    render();
    // The page's own menu asked for "Ask your AI to find it": open on the sheet that says what would be sent.
    if (state.askAi && !aiState) askAi();
    announceTranscripts();
    followPack();
    openFinishedRead();
    // What only the page can say (a player that has not started, files in its footer): asked after the first picture.
    probePage().then((changed) => { if (changed) render(); }).catch(() => {});
  } catch (e) {
    banner(e.message, true);
  }
  clearTimeout(pollTimer);
  const busy = state?.jobs?.some((j) => ACTIVE.includes(j.status));
  // (Files the page only links to are being looked at since this opened: read again soon, they are about to be listed.)
  pollTimer = setTimeout(refresh, state?.links?.checking || state?.links?.naming ? 350 : busy ? 700 : 2000);
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
    const items = [...menu.querySelectorAll('button')].filter((b) => b.getClientRects().length);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  });
  const item = (id, fn) => $(id).addEventListener('click', () => { close(); fn(); });
  item('#btn-ai', askAi);
  item('#btn-summarize', () => summarize(null));
  // @site-edition
  item('#btn-ytdlp', runYtdlp);
  // @end-site-edition
  item('#btn-view', () => setView(view === 'path' ? 'downloader' : 'path'));
  // "Scan again" and "Open in the side panel" have their own handlers (see init): the menu just closes.
  for (const id of ['#btn-rescan', '#btn-sidebar']) $(id).addEventListener('click', close);
  // @site-edition
  // What few people need (the other downloader, by name) is one line down.
  $('#btn-tools-adv').addEventListener('click', (e) => {
    e.stopPropagation();
    const box = $('#tools-adv');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
  });
  // @end-site-edition
}

/**
 * What the study tools (extension/pro/) get to work with: this page's builders, what it knows about a
 * video, and the handlers their buttons call. They hand back one object, `pro`, and this page asks it for
 * the path, the squares, the before-AI sheet and the Review entry. Nothing here needs them to be there.
 */
const host = {
  h, svg, ICON, send, banner, panel: PANEL, ACTIVE,
  render: () => render(),
  refresh: () => refresh(),
  get state() { return state; },
  get study() { return studyState; },
  statusFor, lastDownload, hasCaptions, canStudyPage, displayName, packJobFor, transcribeOfferFor,
  isProtected: (m) => !!(m.protected || openMedia.get(m.id)?.protected),
  act: { saveTranscript, readLecture, makeStudyPage, makeStudyPack, startTranscribing, openSttSetup, openGuide, openReviewPage, openDesk },
};

async function loadPro() {
  // This copy has no study tools: the downloader works without them (pro stays null).
}

/** Close the side panel this page is in: chrome.sidePanel.close where Chrome has it, else the page closes itself. */
function closePanel() {
  const viaPage = () => window.close();
  if (typeof chrome.sidePanel?.close === 'function' && windowId != null) chrome.sidePanel.close({ windowId }).catch(viaPage);
  else viaPage();
}

/** "Small window": when the icon opens this sidebar, say so once and ask; otherwise close it at once. */
async function smallWindow() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (settings.sidebarOnClick === true) {
    $('#small-ask').hidden = false;
    $('#small-off').focus();
    return;
  }
  closePanel();
}

/** The study desk: the tab it is open in, else a new one (the worker decides). (The small window closes by itself as the tab comes forward.) */
function openDesk(where = '') {
  send('openDesk', { where }).catch((e) => banner(e.message, true));
}

async function init() {
  // The study tools load while the tab is looked up, so the first picture is not kept waiting for them.
  const studyTools = loadPro();
  // ?tabId=N lets you open popup.html in a normal tab for debugging/screenshots.
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  windowId = tab?.windowId ?? null;
  tabId = forced || (tab?.id ?? null);
  if (PANEL) {
    document.body.classList.add('sidebar');
    $('#btn-sidebar').hidden = true;
    $('#btn-panel').hidden = true;
    // The way back to the small window: closes this sidebar (asking first when the icon opens the sidebar).
    $('#btn-small').hidden = false;
    $('#btn-small').addEventListener('click', smallWindow);
    $('#small-off').addEventListener('click', async () => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, sidebarOnClick: false } });
      await send('panelBehavior').catch(() => null); // the worker has applied it: the icon opens the small window now
      closePanel();
    });
    $('#small-keep').addEventListener('click', () => closePanel());
    // "Always open here": the toolbar icon then opens this sidebar directly (the worker applies it).
    $('#panel-pref').hidden = false;
    chrome.storage.local.get('settings').then(({ settings = {} }) => { $('#panel-always').checked = settings.sidebarOnClick === true; });
    $('#panel-always').addEventListener('change', async (e) => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, sidebarOnClick: e.target.checked } });
    });
    // The side panel stays open while you switch tabs: follow whichever tab is active in this window.
    const follow = (id) => {
      if (forced || id === tabId) return;
      tabId = id;
      closeReview(false); // the sheet was about the other tab's videos
      openMedia.clear();
      summaryState = null;
      studyState = null;
      refresh();
    };
    chrome.tabs.onActivated.addListener(({ tabId: id, windowId: w }) => { if (w === windowId) follow(id); });
    chrome.windows.onFocusChanged.addListener(async (w) => {
      if (w < 0 || w !== windowId) return;
      const [t] = await chrome.tabs.query({ active: true, windowId: w });
      if (t) follow(t.id);
    });
  }
  // One click from the popup's header (and still in the "More" menu).
  const toPanel = () => {
    // Must run inside the click (user gesture), before any await.
    chrome.sidePanel.open({ windowId }).then(() => window.close()).catch((e) => banner(`Couldn't open the sidebar: ${e.message}`, true));
  };
  $('#btn-sidebar').addEventListener('click', toPanel);
  $('#btn-panel').addEventListener('click', toPanel);
  $('#btn-history-all').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#history') }));
  window.addEventListener('resize', () => fitAll());
  // The header and the foot stay put over the list. A control the keyboard lands on is scrolled clear of
  // both (popup.css: scroll-padding), by their real heights: the foot grows when something is running.
  const clear = () => {
    document.documentElement.style.setProperty('--bar-h', `${Math.ceil($('.bar').getBoundingClientRect().height)}px`);
    document.documentElement.style.setProperty('--foot-h', `${Math.ceil($('#foot').getBoundingClientRect().height)}px`);
  };
  clear();
  if (typeof ResizeObserver === 'function') {
    const watch = new ResizeObserver(clear);
    watch.observe($('.bar'));
    watch.observe($('#foot'));
  }
  $('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#btn-setup').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#helper') }));
  $('#btn-setup-later').addEventListener('click', () => { setupLater = Date.now(); remember('ss-setup-later', String(setupLater)); render(); });
  // The two ways out, under an empty page and behind "Not the right video?" (the same buttons).
  $('#empty-actions').replaceChildren(...rescueActions('empty'));
  $('#wrong-box').replaceChildren(...rescueActions('wrong'));
  $('#btn-wrong').addEventListener('click', () => { wrongOpen = !wrongOpen; render(); });
  $('#btn-rescan').addEventListener('click', deepScan);
  // The sheet keeps the keyboard inside it, and Esc means "Not now".
  $('#ai-section').addEventListener('keydown', (e) => {
    if (!aiState?.confirm) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAiSheet();
    } else if (e.key === 'Tab') {
      const stops = [...$('#ai-section').querySelectorAll('button, pre[tabindex]')].filter((el) => !el.disabled && el.getClientRects().length);
      if (!stops.length) return;
      const [first, last] = [stops[0], stops[stops.length - 1]];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === $('#ai-section'))) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  setupToolsMenu();
  setupReview();
  $('#btn-clear').addEventListener('click', () => send('clearJobs').then(refresh));
  $('#btn-tray').addEventListener('click', () => setActivity(true));
  $('#btn-activity').addEventListener('click', () => setActivity(!activityOpen));
  $('#btn-back').addEventListener('click', () => setActivity(false));
  $('#view-row').addEventListener('click', () => setView('path'));
  await studyTools;
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
  $('#subs-toggle').addEventListener('click', () => { subsPick = !subsShown; subsOpen = subsPick; remember('ss-subs', subsOpen ? '1' : '0'); render(); });
  $('#docs-toggle').addEventListener('click', () => { docsOpen = !docsOpen; remember('ss-docs', docsOpen ? '1' : '0'); render(); });
  // "Download all" for the files is the same review sheet as for the videos: nothing starts on this click.
  $('#docs-all').addEventListener('click', () => openReview({ files: true }));
  $('#docs-search').addEventListener('input', (e) => { docsQuery = e.target.value; render(); });
  $('#docs-more').addEventListener('click', () => { docsAll = !docsAll; render(); });
  $('#btn-jobs-history').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#history') }));
  $('#folder-search').addEventListener('input', (e) => { folderQuery = e.target.value; render(); });
  chrome.runtime.sendMessage({ type: 'helperStatus' }).catch(() => {});
  await refresh();
}

init();

import { formatBytes, formatDuration, hostOf, ytdlpCommand, ffmpegCommand } from './lib/util.js';
import { sameItem } from './lib/match.js';

const $ = (sel) => document.querySelector(sel);
// The same page runs as the toolbar popup and (with ?view=panel) as Chrome's side panel.
const PANEL = new URLSearchParams(location.search).get('view') === 'panel';
let tabId = null;
let windowId = null;
let state = null;
let history = [];
const openMedia = new Map(); // mediaId -> {loading, options, error, menu}
const expanded = new Set(); // keys of names the user clicked to show in full
let aiBusy = false;
let summaryState = null; // {loading} | {result} | {error}
let pollTimer = null;
let filter = 'all'; // 'all' | 'new' | 'done'
let sortBy = 'default'; // see SORTS
let query = ''; // search box on the list
let subsOpen = false; // the collapsed "Subtitle files" group
let folderQuery = '';
try {
  filter = localStorage.getItem('ss-filter') || 'all';
  sortBy = localStorage.getItem('ss-sort') || 'default';
  subsOpen = localStorage.getItem('ss-subs') === '1';
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
function nameEl(text, key, cls = 'title') {
  const el = h('div', {
    class: `${cls} marquee${expanded.has(key) ? ' expanded' : ''}`,
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
  const inner = el.firstElementChild;
  const overflow = el.classList.contains('expanded') ? 0 : inner.scrollWidth - el.clientWidth;
  el.classList.toggle('overflow', overflow > 2);
  if (overflow > 2) {
    el.style.setProperty('--shift', `-${overflow + 8}px`);
    el.style.setProperty('--dur', `${Math.max(1, overflow / 75).toFixed(1)}s`); // ~75 px/s
  }
}

function fitAll(root = document) {
  root.querySelectorAll('.marquee').forEach(fitMarquee);
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

/** What happened to this media item: 'active' | 'done' | 'missing' | 'failed' | 'new'. */
function statusFor(m) {
  const mine = (state.jobs || []).filter((j) => sameItem(m, j));
  if (mine.some((j) => ['running', 'recording', 'muxing'].includes(j.status))) return 'active';
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

const STATUS_TAG = {
  active: ['Downloading…', 'st-active'],
  done: ['✓ Downloaded', 'st-done'],
  failed: ['Failed', 'st-failed'],
  missing: ['File not in folder', 'st-failed'],
  new: ['Not downloaded', 'st-new'],
};

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
  box.hidden = !total;
  const chips = [['all', 'All', total], ['new', 'Not downloaded', counts.new + counts.failed + counts.missing], ['done', 'Downloaded', counts.done]];
  box.replaceChildren(...chips.map(([id, label, n]) => h('button', {
    class: `chip${filter === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(filter === id),
    onclick: () => {
      filter = id;
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

function thumbFor(m) {
  if (m.poster) return h('div', { class: 'thumb' }, h('img', { src: m.poster, alt: '' }));
  const label = m.kind === 'embed' ? (m.provider || 'embed').toUpperCase().slice(0, 7)
    : m.kind === 'direct' ? (m.ext || 'file').toUpperCase().slice(0, 4) : m.kind === 'subtitle' ? 'CC' : m.kind.toUpperCase();
  return h('div', { class: `thumb ${m.kind}` }, label);
}

function sourceTag(m) {
  if (m.source === 'ai' || m.alsoAi) return h('span', { class: 'tag ai' }, 'AI');
  if (m.source === 'recipe') return h('span', { class: 'tag ai' }, 'recipe');
  return null;
}

async function toggleOptions(m) {
  const cur = openMedia.get(m.id);
  if (cur?.options || cur?.loading) {
    openMedia.delete(m.id);
    render();
    return;
  }
  openMedia.set(m.id, { loading: true });
  render();
  try {
    const res = await send('inspect', { mediaId: m.id });
    openMedia.set(m.id, { ...res });
  } catch (e) {
    openMedia.set(m.id, { error: e.message });
  }
  render();
}

async function download(m, optionId) {
  try {
    await send('download', { mediaId: m.id, optionId });
    openMedia.delete(m.id);
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

function mediaCard(m) {
  const open = openMedia.get(m.id) || {};
  const isStream = m.kind === 'hls' || m.kind === 'dash';
  const title = displayName(m);

  const primary = m.protected
    ? h('span', { class: 'tag drm' }, 'DRM')
    : isStream
      ? h('button', { class: 'primary', onclick: () => toggleOptions(m) }, open.options ? 'Close' : 'Download ▾')
      : m.kind === 'embed'
        ? h('button', { class: 'primary', title: 'Downloads with yt-dlp through the local helper', onclick: () => download(m, 'file') }, m.playlist ? 'Download all' : 'Download')
        : h('button', { class: 'primary', onclick: () => download(m, 'file') }, 'Download');

  const moreBtn = h('button', {
    class: 'icon more', title: 'More actions', 'aria-label': 'More actions',
    onclick: () => { openMedia.set(m.id, { ...open, menu: !open.menu }); render(); },
  }, '⋯');

  const st = statusFor(m);
  const [stText, stCls] = STATUS_TAG[st];
  const card = h('li', { class: `card is-${st}` },
    h('div', { class: 'row' },
      thumbFor(m),
      h('div', { class: 'meta' },
        nameEl(title, `m:${m.id}`),
        h('div', { class: 'sub', title: m.url }, m.kind === 'subtitle' && st === 'new' ? null : [h('span', { class: `st ${stCls}` }, stText), ' '], m.label, m.section ? ` · ${m.section}` : '', ' · ', m.kind === 'embed' ? (m.playlist ? 'playlist · every video, with yt-dlp' : 'downloads with yt-dlp') : hostOf(m.url),
          m.info?.hasSubtitles ? h('span', { class: 'tag', title: 'Has subtitles: they are saved with the video' }, 'CC') : null,
          m.mark ? h('span', { class: 'tag', title: 'You set this yourself (⋯ menu to undo)' }, 'marked') : null,
          sourceTag(m)),
      ),
      primary,
      moreBtn,
    ),
  );

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
    if (last?.file) {
      card.append(h('div', { class: 'job-actions' },
        h('button', { class: 'secondary', onclick: () => send('openFile', { downloadId: last.downloadId ?? null, path: last.file }) }, 'Show file'),
      ));
    }
  }

  if (open.loading) card.append(h('div', { class: 'options loading' }, h('div', { class: 'spinner' }), 'Reading stream…'));
  if (open.error) card.append(h('div', { class: 'status err' }, open.error));
  if (open.protected) card.append(h('div', { class: 'status err' }, 'This stream is DRM/encrypted — it cannot be downloaded.'));
  if (open.note) card.append(h('div', { class: 'status' }, open.note));
  if (open.options) {
    card.append(h('div', { class: 'options' }, open.options.map((o) =>
      h('button', { class: 'opt', onclick: () => download(m, o.id) },
        h('span', {}, o.label),
        h('span', { class: 'hint' }, o.audio ? 'audio' : o.subtitle ? 'subs' : open.live ? 'live' : 'video'),
      ))));
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
    card.append(h('div', { class: 'menu' },
      m.kind !== 'subtitle' ? h('button', { class: 'secondary', onclick: () => { openMedia.set(m.id, { ...open, menu: false, renaming: true }); render(); } }, '✎ Rename') : null,
      m.kind !== 'subtitle' && !m.mark && st !== 'done' ? h('button', { class: 'secondary', title: 'You already have this video (the folder check missed it)', onclick: () => mark(m, 'done', 'Marked as downloaded') }, '✓ Mark as downloaded') : null,
      m.kind !== 'subtitle' && !m.mark && st === 'done' ? h('button', { class: 'secondary', title: 'The folder check matched the wrong file', onclick: () => mark(m, 'new', 'Marked as not downloaded') }, 'Mark as not downloaded') : null,
      m.mark ? h('button', { class: 'secondary', onclick: () => mark(m, null, 'Back to checking your folder') }, 'Undo my mark') : null,
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
  return card;
}

// ------------------------------------------------------------------ jobs

const STATUS_TEXT = {
  running: 'Downloading', recording: 'Recording live', muxing: 'Merging with ffmpeg', done: 'Done',
  error: 'Failed', canceled: 'Canceled',
};

function jobCard(j) {
  const active = ['running', 'recording', 'muxing'].includes(j.status);
  const p = j.progress || {};
  let pct = 0;
  if (p.percent) pct = p.done;
  else if (p.total) pct = Math.min(100, (p.done / p.total) * 100);
  const indeterminate = active && (j.status === 'muxing' || j.status === 'recording' || !p.total);
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
    h('div', { class: `status ${cls}` }, h('span', {}, j.status === 'error' ? j.error : STATUS_TEXT[j.status] || j.status), h('span', {}, detail.join(' · '))),
    j.note ? h('div', { class: 'status' }, j.note) : null,
  );

  const actions = h('div', { class: 'job-actions' });
  if (j.status === 'recording') actions.append(h('button', { class: 'primary', onclick: () => send('stopLive', { jobId: j.id }).then(refresh) }, '■ Stop & save'));
  if (active) actions.append(h('button', { class: 'secondary danger', onclick: () => send('cancelJob', { jobId: j.id }).then(refresh) }, 'Cancel'));
  if (j.status === 'done') {
    // After an ffmpeg merge the main output has a path but no Chrome download id.
    const main = j.outputs?.[0];
    actions.append(h('button', {
      class: 'secondary',
      onclick: () => send('openFile', { downloadId: main?.downloadId ?? null, path: main?.path || null }),
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
      h('div', { class: 'sub' }, h('span', { class: 'st st-done' }, '✓'), ` ${ago(x.at)}`, x.bytes ? ` · ${formatBytes(x.bytes)}` : '', ` · ${hostOf(x.pageUrl || x.mediaUrl)}`),
      files.length ? nameEl(files.map(baseName).join(' + '), `hf:${x.at}`, 'sub') : null,
      x.note ? h('div', { class: 'sub muted' }, x.note) : null,
    ),
    files.length ? h('div', { class: 'job-actions' },
      h('button', { class: 'secondary', onclick: () => send('openFile', { path: files[0] }) }, 'Show file'),
      h('button', { class: 'link', onclick: () => chrome.tabs.create({ url: x.pageUrl || x.mediaUrl }) }, 'Open page'),
    ) : null,
  );
}

const STATUS_ORDER = { failed: 0, missing: 0, new: 1, active: 2, done: 3 };
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
      h('div', { class: 'thumb' }, ext),
      h('div', { class: 'meta' },
        nameEl(f.name, `f:${f.path}`),
        h('div', { class: 'sub', title: f.path },
          f.here ? h('span', { class: 'st st-done' }, 'On this page') : null, f.here ? ' ' : '',
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

function render() {
  if (!state) return;
  $('#site').textContent = state.page.site || 'No web page';
  // Subtitle files are kept apart (collapsed): stream downloads already include their subtitles.
  const videos = state.media.filter((m) => m.kind !== 'subtitle');
  const subs = state.media.filter((m) => m.kind === 'subtitle');
  const counts = { new: 0, done: 0, failed: 0, active: 0, missing: 0 };
  const withStatus = videos.map((m) => ({ m, st: statusFor(m) }));
  withStatus.forEach(({ st }) => { counts[st]++; });
  const q = query.trim().toLowerCase();
  const shown = withStatus.filter(({ st }) => filter === 'all'
    || (filter === 'done' ? st === 'done' : st === 'new' || st === 'failed' || st === 'missing')).map(({ m }) => m)
    .filter((m) => matchesQuery(m, q));
  renderFilters(counts, videos.length);
  $('#listbar').hidden = videos.length < 4 && !q && sortBy === 'default';
  if ($('#sort').value !== sortBy) $('#sort').value = sortBy;
  renderLibrary();
  renderFolder();
  const removed = $('#removed');
  removed.hidden = !state.removedCount;
  if (state.removedCount) {
    removed.replaceChildren(`${state.removedCount} removed from the list · `,
      h('button', { class: 'link small', onclick: () => send('restoreMedia').then(refresh) }, 'Show again'));
  }
  const sig = (m) => m.group ? JSON.stringify(m) : JSON.stringify([
    m.label, m.size, m.seen, m.library, m.fingerprint, m.poster, m.hint, m.title, m.customName, m.course, m.nameSource, m.source, m.alsoAi, m.info, m.protected, m.mark, m.section, statusFor(m), state.page.title,
    PANEL && statusFor(m) === 'done' ? ago(lastDownload(m)?.at) : '', PANEL ? ago(m.detectedAt) : '',
    openMedia.get(m.id) || null, expanded.has(`m:${m.id}`),
  ]);
  const keyOf = (m) => (m.group ? `g:${m.group}` : m.id);
  const build = (m) => (m.group ? groupHeading(m) : mediaCard(m));
  patchList($('#media'), arrange(shown), keyOf, sig, build);
  $('#media-count').textContent = videos.length
    ? (counts.done ? `${counts.done}/${videos.length} saved` : videos.length) : '';
  $('#empty').hidden = shown.length > 0 || (!videos.length && subs.length > 0);
  $('#empty').querySelector('p strong').textContent = q && videos.length
    ? `No names match “${query.trim()}”.`
    : videos.length
      ? (filter === 'done' ? 'Nothing downloaded from this page yet.' : 'Everything on this page is downloaded.')
      : 'No media found yet.';
  $('#empty').querySelector('p.muted').hidden = videos.length > 0;
  $('#subs-box').hidden = !subs.length;
  $('#subs-count').textContent = String(subs.length);
  $('#subs-toggle').setAttribute('aria-expanded', String(subsOpen));
  $('#subs').hidden = !subsOpen;
  patchList($('#subs'), subsOpen ? subs : [], (m) => m.id, sig, mediaCard);

  const jobs = state.jobs || [];
  $('#jobs-section').hidden = !jobs.length;
  patchList($('#jobs'), jobs, (j) => j.id, (j) => JSON.stringify([j, expanded.has(`j:${j.id}`), expanded.has(`jf:${j.id}`)]), jobCard);

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
  const busy = state?.jobs?.some((j) => ['running', 'recording', 'muxing'].includes(j.status));
  pollTimer = setTimeout(refresh, busy ? 700 : 2000);
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
  $('#btn-ai').addEventListener('click', runAi);
  $('#btn-summarize').addEventListener('click', () => summarize(null));
  $('#btn-ytdlp').addEventListener('click', runYtdlp);
  $('#btn-clear').addEventListener('click', () => send('clearJobs').then(refresh));
  $('#search').addEventListener('input', (e) => { query = e.target.value; render(); });
  $('#sort').addEventListener('change', (e) => { sortBy = e.target.value; remember('ss-sort', sortBy); render(); });
  $('#subs-toggle').addEventListener('click', () => { subsOpen = !subsOpen; remember('ss-subs', subsOpen ? '1' : '0'); render(); });
  $('#folder-search').addEventListener('input', (e) => { folderQuery = e.target.value; render(); });
  chrome.runtime.sendMessage({ type: 'helperStatus' }).catch(() => {});
  await refresh();
}

init();

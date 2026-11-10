import { DEFAULT_SETTINGS, getSettings } from './lib/settings.js';
import { normalizeRecipe } from './lib/recipes.js';
import { formatBytes } from './lib/util.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function flashSaved() {
  const el = $('#saved');
  el.hidden = false;
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => { el.hidden = true; }, 1200);
}

const send = async (type, payload = {}) => {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error || 'Failed');
  return res.data;
};

// ---------------------------------------------------------------- tabs
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  $$('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  if (b.dataset.tab === 'history') renderHistory();
  if (b.dataset.tab === 'recipes') renderRecipes();
  history.replaceState(null, '', `#${b.dataset.tab}`);
}));
const initialTab = location.hash.slice(1);
if (initialTab) document.querySelector(`.tabs button[data-tab="${initialTab}"]`)?.click();

// ---------------------------------------------------------------- settings form
const FIELDS = ['apiKey', 'model', 'effort', 'subscriptionModel', 'minSizeKB', 'concurrency', 'includeSubtitles', 'useFfmpeg',
  'embedSubtitles', 'keepSubtitleFiles', 'aiFilenames', 'filenameTemplate', 'subfolder', 'saveFolder', 'notify', 'autoRecipes', 'checkDownloads', 'maxParallel', 'debugMode'];

function syncProviderSections(provider) {
  $$('[data-when]').forEach((el) => { el.hidden = el.dataset.when !== provider; });
}

async function loadForm() {
  const s = await getSettings();
  $$('input[name="aiProvider"]').forEach((r) => { r.checked = r.value === s.aiProvider; });
  syncProviderSections(s.aiProvider);
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[f];
    else el.value = s[f] ?? '';
  }
}

async function saveForm() {
  const s = { ...(await getSettings()) };
  s.aiProvider = $('input[name="aiProvider"]:checked')?.value || 'off';
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (!el) continue;
    if (el.type === 'checkbox') s[f] = el.checked;
    else if (el.type === 'number') s[f] = Math.max(Number(el.min) || 0, Number(el.value) || DEFAULT_SETTINGS[f]);
    else s[f] = el.value.trim();
  }
  if (s.subscriptionModel && !/^[a-z0-9][a-z0-9.\-[\]]*$/i.test(s.subscriptionModel)) s.subscriptionModel = '';
  s.concurrency = Math.min(16, s.concurrency);
  s.maxParallel = Math.min(6, Math.max(1, s.maxParallel || 2));
  await chrome.storage.local.set({ settings: s });
  syncProviderSections(s.aiProvider);
  flashSaved();
}

document.addEventListener('change', (e) => {
  if (e.target.closest('#siteRules, .rules ~ .row-actions')) return; // the rule editor saves itself
  if (e.target.closest('[data-panel="ai"], [data-panel="downloads"]') || e.target.id === 'debugMode') saveForm();
});

$('#testAI').addEventListener('click', async () => {
  const out = $('#testAIResult');
  out.className = 'muted';
  out.textContent = 'Testing…';
  try {
    await saveForm();
    const r = await send('testAI');
    out.className = 'ok';
    out.textContent = `✓ Connected (${r.via}) — "${r.message}"`;
  } catch (e) {
    out.className = 'bad';
    out.textContent = e.message;
  }
});

// ---------------------------------------------------------------- save folder
const FOLDER_HINT = $('#folder-status').textContent;
function folderStatus(text, cls = 'muted') {
  const el = $('#folder-status');
  el.className = `${cls} small`;
  el.textContent = text;
}

async function checkSaveFolder() {
  const p = $('#saveFolder').value.trim();
  if (!p) {
    folderStatus(FOLDER_HINT);
    return;
  }
  folderStatus('Checking folder…');
  try {
    const r = await send('checkFolder', { path: p });
    if ($('#saveFolder').value !== r.path) {
      $('#saveFolder').value = r.path;
      await saveForm();
    }
    folderStatus(`✓ Videos will be saved to ${r.path}`, 'ok');
  } catch (e) {
    folderStatus(/helper/i.test(e.message)
      ? `${e.message} A custom folder needs the local helper (Settings → Local helper).`
      : `✗ ${e.message}`, 'bad');
  }
}

$('#saveFolder').addEventListener('change', checkSaveFolder);
$('#btn-browse').addEventListener('click', async () => {
  folderStatus('A folder picker opened (check the taskbar if you don\'t see it)…');
  try {
    const r = await send('pickFolder', { start: $('#saveFolder').value.trim() });
    if (!r.path) {
      folderStatus(FOLDER_HINT);
      return;
    }
    $('#saveFolder').value = r.path;
    await saveForm();
    await checkSaveFolder();
  } catch (e) {
    folderStatus(e.message, 'bad');
  }
});
$('#btn-folder-default').addEventListener('click', async () => {
  $('#saveFolder').value = '';
  await saveForm();
  folderStatus(FOLDER_HINT);
});

// ---------------------------------------------------------------- folders to check for videos you already have
function libraryStatus(text, cls = 'muted') {
  const el = $('#library-status');
  el.className = `${cls} small`;
  el.textContent = text;
}

async function renderLibraryFolders() {
  const s = await getSettings();
  const list = s.libraryFolders || [];
  $('#libraryFolders').replaceChildren(...(list.length ? list : [null]).map((d) => (d
    ? h('li', {}, h('code', {}, d), h('button', {
      type: 'button', class: 'link', onclick: async () => {
        await send('removeLibraryFolder', { path: d }).catch((e) => libraryStatus(e.message, 'bad'));
        renderLibraryFolders();
      },
    }, 'Remove'))
    : h('li', { class: 'muted small' }, 'No extra folders yet.'))));
}

$('#btn-add-library').addEventListener('click', async () => {
  libraryStatus('A folder picker opened (check the taskbar if you do not see it)…');
  try {
    const r = await send('addLibraryFolder');
    libraryStatus(r.path ? `Added ${r.path}` : 'No folder chosen', r.path ? 'ok' : 'muted');
    renderLibraryFolders();
  } catch (e) {
    libraryStatus(e.message, 'bad');
  }
});
$('#btn-check-library').addEventListener('click', async () => {
  libraryStatus('Checking…');
  try {
    const r = await send('checkLibrary');
    libraryStatus(r.error || `✓ ${r.count} video files in ${r.dirs.length} folder${r.dirs.length === 1 ? '' : 's'}: ${r.dirs.join(', ')}`, r.error ? 'bad' : 'ok');
  } catch (e) {
    libraryStatus(e.message, 'bad');
  }
});
renderLibraryFolders();

// ---------------------------------------------------------------- site rules
const siteOf = (v) => String(v || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');

async function saveRules(rules) {
  const s = await getSettings();
  await chrome.storage.local.set({ settings: { ...s, siteRules: rules } });
  flashSaved();
}

async function renderRules() {
  const rules = (await getSettings()).siteRules || {};
  const sites = Object.keys(rules).sort();
  $('#siteRules').replaceChildren(...(sites.length ? sites.map((site) => h('tr', {},
    h('td', {}, h('code', {}, site)),
    h('td', {}, rules[site].subfolder || h('span', { class: 'muted' }, 'general')),
    h('td', {}, rules[site].filenameTemplate || h('span', { class: 'muted' }, 'general')),
    h('td', {}, h('button', {
      type: 'button', class: 'link', onclick: async () => {
        const next = { ...rules };
        delete next[site];
        await saveRules(next);
        renderRules();
      },
    }, 'Remove')),
  )) : [h('tr', {}, h('td', { colspan: '4', class: 'muted small' }, 'No site rules yet.'))]));
}

$('#addRule').addEventListener('click', async () => {
  const site = siteOf($('#ruleSite').value);
  const subfolder = $('#ruleFolder').value.trim();
  const filenameTemplate = $('#ruleTemplate').value.trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$|^\d+\.\d+\.\d+\.\d+$/.test(site)) {
    $('#ruleStatus').textContent = 'Enter a site like example.com.';
    return;
  }
  if (!subfolder && !filenameTemplate) {
    $('#ruleStatus').textContent = 'Fill in a subfolder, a file name, or both.';
    return;
  }
  const rules = { ...((await getSettings()).siteRules || {}), [site]: { subfolder, filenameTemplate } };
  await saveRules(rules);
  ['#ruleSite', '#ruleFolder', '#ruleTemplate'].forEach((id) => { $(id).value = ''; });
  $('#ruleStatus').textContent = `Saved a rule for ${site}.`;
  renderRules();
});
renderRules();

// ---------------------------------------------------------------- backup & diagnostics
const BACKUP_KEYS = ['settings', 'recipes', 'history', 'marks'];

$('#exportAll').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(BACKUP_KEYS);
  if (data.settings && !$('#exportKey').checked) data.settings = { ...data.settings, apiKey: '' };
  const file = { app: 'StreamSnag', version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), ...data };
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
  h('a', { href: URL.createObjectURL(blob), download: `streamsnag-backup-${new Date().toISOString().slice(0, 10)}.json` }).click();
  $('#backupStatus').textContent = 'Saved to your Downloads folder.';
});

$('#importAll').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('#backupStatus');
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'StreamSnag') throw new Error('That is not a StreamSnag backup file.');
    const cur = await chrome.storage.local.get(BACKUP_KEYS);
    const next = {};
    // Settings: the backup's values, but an empty API key in the file never wipes the one you have.
    if (data.settings && typeof data.settings === 'object') {
      // Only known settings, with their usual types; folder paths must look like plain folders.
      const plainFolder = (p) => typeof p === 'string' && p.length < 400 && !/["'`$;&|<>\r\n\u2018-\u201f]/.test(p);
      const clean = {};
      for (const [k, v] of Object.entries(data.settings)) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        const want = DEFAULT_SETTINGS[k];
        if (Array.isArray(want) ? Array.isArray(v) : typeof v === typeof want) clean[k] = v;
      }
      if (clean.saveFolder && !plainFolder(clean.saveFolder)) delete clean.saveFolder;
      if (clean.libraryFolders) clean.libraryFolders = clean.libraryFolders.filter(plainFolder).slice(0, 30);
      if (clean.subscriptionModel && !/^[a-z0-9][a-z0-9.\-[\]]*$/i.test(clean.subscriptionModel)) delete clean.subscriptionModel;
      next.settings = { ...(cur.settings || {}), ...clean };
      if (!clean.apiKey) next.settings.apiKey = cur.settings?.apiKey || '';
    }
    if (data.recipes && typeof data.recipes === 'object') {
      next.recipes = { ...(cur.recipes || {}) };
      for (const r of Object.values(data.recipes)) {
        try { const n = normalizeRecipe(r); next.recipes[n.site] = { ...n, savedAt: r.savedAt || Date.now() }; } catch { /* skip bad recipe */ }
      }
    }
    if (Array.isArray(data.history)) {
      const seen = new Set((cur.history || []).map((x) => `${x.at}|${x.title}`));
      next.history = [...(cur.history || []), ...data.history.filter((x) => x && !seen.has(`${x.at}|${x.title}`))]
        .sort((a, b) => b.at - a.at).slice(0, 300);
    }
    if (data.marks && typeof data.marks === 'object') next.marks = { ...(cur.marks || {}), ...data.marks };
    await chrome.storage.local.set(next);
    await loadForm();
    renderRules();
    status.className = 'ok small';
    status.textContent = `Imported ${Object.keys(next).join(', ')}.`;
  } catch (err) {
    status.className = 'bad small';
    status.textContent = err.message;
  }
});

$('#copyDebug').addEventListener('click', async () => {
  const { debugTab } = await chrome.storage.local.get('debugTab');
  const status = $('#debugStatus');
  if (!debugTab) {
    status.textContent = 'No snapshot yet: turn diagnostics on, then open or reload the page with the problem.';
    return;
  }
  const report = { app: 'StreamSnag', version: chrome.runtime.getManifest().version, browser: navigator.userAgent, ...debugTab };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 1));
  status.textContent = `Copied (${new Date(debugTab.at).toLocaleTimeString()}, ${debugTab.media.length} items).`;
});

// ---------------------------------------------------------------- helper
$('#extId').textContent = chrome.runtime.id;

async function showVersions() {
  const box = $('#toolVersions');
  try {
    const v = await send('toolVersions');
    box.textContent = [`helper ${v.helper}`, `Node ${v.node}`, v.ytdlp && `yt-dlp ${v.ytdlp}`, v.ffmpeg && `ffmpeg ${v.ffmpeg}`, v.claude && `Claude CLI ${v.claude}`]
      .filter(Boolean).join(' · ');
  } catch {
    box.textContent = '';
  }
}

$('#updateYtdlp').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const box = $('#toolVersions');
  btn.disabled = true;
  box.textContent = 'Updating yt-dlp…';
  try {
    const r = await send('updateYtdlp');
    box.textContent = r.upToDate ? 'yt-dlp is already up to date.' : `Updated: ${r.output}`;
    setTimeout(showVersions, 1500);
  } catch (err) {
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('#checkHelper').addEventListener('click', async () => {
  const box = $('#helperResult');
  box.replaceChildren(h('p', { class: 'muted' }, 'Checking…'));
  try {
    const r = await send('helperStatus', { force: true });
    if (!r.ok) {
      box.replaceChildren(h('p', { class: 'bad' }, r.error));
      return;
    }
    const tool = (name, path, purpose) => h('li', {}, h('span', { class: path ? 'ok' : 'bad' }, path ? '✓' : '✗'),
      h('span', {}, h('strong', {}, name), ` — ${purpose}`, path ? h('div', { class: 'muted small' }, path) : h('div', { class: 'muted small' }, 'not found on PATH')));
    box.replaceChildren(
      h('p', { class: 'ok' }, `Helper v${r.version} is running.`),
      h('ul', { class: 'tool-list' },
        tool('claude', r.tools.claude, 'AI through your Claude subscription'),
        tool('ffmpeg', r.tools.ffmpeg, 'merge video + audio, convert .ts → .mp4'),
        tool('yt-dlp', r.tools.ytdlp, 'fallback downloader for 1000+ sites, playlists')),
    );
    showVersions();
  } catch (e) {
    box.replaceChildren(h('p', { class: 'bad' }, e.message));
  }
});

// ---------------------------------------------------------------- recipes
async function getRecipes() {
  return (await chrome.storage.local.get('recipes')).recipes || {};
}

async function renderRecipes() {
  const recipes = await getRecipes();
  const list = $('#recipeList');
  const entries = Object.values(recipes).sort((a, b) => a.site.localeCompare(b.site));
  if (!entries.length) {
    list.replaceChildren(h('p', { class: 'muted' }, 'No recipes yet. Use “Find with AI” on a site and save the recipe it suggests.'));
    return;
  }
  list.replaceChildren(...entries.map((r) => recipeCard(r)));
}

function recipeCard(r, isNew = false) {
  const area = h('textarea', { spellcheck: 'false' });
  area.value = JSON.stringify({ site: r.site, description: r.description, rules: r.rules }, null, 2);
  const err = h('div', { class: 'err-text' });
  const card = h('div', { class: 'card stack' },
    h('div', { class: 'recipe-head' },
      h('h3', {}, r.site || 'new recipe'),
      h('span', { class: 'muted small' }, r.savedAt ? `saved ${new Date(r.savedAt).toLocaleString()}` : ''),
    ),
    area,
    err,
    h('div', { class: 'row-actions' },
      h('button', {
        class: 'primary',
        onclick: async () => {
          try {
            const parsed = normalizeRecipe(JSON.parse(area.value));
            const recipes = await getRecipes();
            if (!isNew && r.site && r.site !== parsed.site) delete recipes[r.site];
            recipes[parsed.site] = { ...parsed, savedAt: Date.now() };
            await chrome.storage.local.set({ recipes });
            flashSaved();
            renderRecipes();
          } catch (e) {
            err.textContent = e.message;
          }
        },
      }, 'Save'),
      h('button', {
        class: 'secondary danger',
        onclick: async () => {
          const recipes = await getRecipes();
          delete recipes[r.site];
          await chrome.storage.local.set({ recipes });
          renderRecipes();
        },
      }, isNew ? 'Discard' : 'Delete'),
    ),
  );
  return card;
}

$('#newRecipe').addEventListener('click', () => {
  const tpl = {
    site: 'example.com',
    description: 'Describe what this recipe finds',
    rules: [{ type: 'regex', source: 'scripts', pattern: '"(https?:[^"]+\\.m3u8[^"]*)"', group: 1 }],
  };
  $('#recipeList').prepend(recipeCard(tpl, true));
});

$('#exportRecipes').addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify(await getRecipes(), null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'streamsnag-recipes.json' });
  a.click();
});

$('#importRecipes').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const recipes = await getRecipes();
    let n = 0;
    for (const r of Object.values(data)) {
      try {
        const norm = normalizeRecipe(r);
        recipes[norm.site] = { ...norm, savedAt: Date.now() };
        n++;
      } catch { /* skip invalid */ }
    }
    await chrome.storage.local.set({ recipes });
    alert(`Imported ${n} recipe(s).`);
    renderRecipes();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------- history
async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const list = $('#history');
  if (!history.length) {
    list.replaceChildren(h('li', { class: 'muted' }, 'Nothing downloaded yet.'));
    return;
  }
  list.replaceChildren(...history.map((it) => h('li', {},
    h('strong', {}, it.title || '(untitled)'),
    h('span', { class: 'muted small' }, `${new Date(it.at).toLocaleString()}${it.bytes ? ` · ${formatBytes(it.bytes)}` : ''}${it.note ? ` · ${it.note}` : ''}`),
    h('span', { class: 'files' }, (it.files || []).filter(Boolean).join('  ·  ')),
    it.pageUrl ? h('a', { href: it.pageUrl, target: '_blank', class: 'small' }, it.pageUrl) : null,
  )));
}

$('#clearHistory').addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  renderHistory();
});

loadForm();

// Theme: System / Light / Dark. theme.js (loaded in <head>) keeps the choice and applies it.
{
  const paint = () => {
    for (const b of document.querySelectorAll('#theme .chip')) {
      const on = b.dataset.themeChoice === window.ssTheme.get();
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  document.getElementById('theme').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    window.ssTheme.set(b.dataset.themeChoice);
    paint();
  });
  window.addEventListener('storage', paint);
  paint();
}

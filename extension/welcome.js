// First-run page: three steps, and a live check of the optional helper.
const status = document.getElementById('helper');

async function checkHelper() {
  status.className = 'small muted';
  status.textContent = 'Checking…';
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'helperStatus', force: true });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  const h = res?.ok ? res.data : null;
  if (h?.ok) {
    const missing = [!h.tools?.ffmpeg && 'ffmpeg', /* @site-edition */ !h.tools?.ytdlp && 'yt-dlp', /* @end-site-edition */ ].filter(Boolean);
    status.className = 'small ok';
    status.textContent = missing.length ? `Helper found. Not installed yet: ${missing.join(' and ')}.`
      // @site-edition
      : 'Helper found, with ffmpeg and yt-dlp. You are all set.';
      // @store-edition
      // : 'Helper found, with ffmpeg. You are all set.';
      // @end-site-edition
  } else {
    status.className = 'small bad';
    status.textContent = 'Not set up yet. StreamSnag works without it; you can add it any time.';
  }
  // Something missing: the steps for this computer are one click away (Settings opens on its Local helper tab).
  if (!h?.ok || status.textContent.includes('Not installed yet')) {
    const steps = document.createElement('button');
    steps.className = 'link fix-btn';
    steps.textContent = 'Set-up steps';
    steps.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#helper') }));
    status.append(' ', steps);
  }
}

document.getElementById('check').addEventListener('click', checkHelper);
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
checkHelper();

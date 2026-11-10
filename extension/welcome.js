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
    const missing = [!h.tools?.ffmpeg && 'ffmpeg', !h.tools?.ytdlp && 'yt-dlp'].filter(Boolean);
    status.className = 'small ok';
    status.textContent = missing.length ? `Helper found. Not installed yet: ${missing.join(' and ')}.` : 'Helper found, with ffmpeg and yt-dlp. You are all set.';
  } else {
    status.className = 'small bad';
    status.textContent = 'Not set up yet. StreamSnag works without it; you can add it any time.';
  }
}

document.getElementById('check').addEventListener('click', checkHelper);
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
checkHelper();

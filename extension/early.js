// StreamSnag, as a page starts to load (before its own scripts run): remembers the caption tracks the
// page's markup declares. A player script often replaces the page's <video> (video.js with a plug-in
// player does), and its <track>s go with it before anything else can read them. Nothing is sent from
// here: the content script (content.js) reports what was seen, along with what is still on the page.
(() => {
  if (window.__streamsnagTracks) return;
  const seen = [];
  window.__streamsnagTracks = seen;
  const note = (t) => {
    const raw = t.getAttribute('src');
    if (!raw || /^(metadata|chapters|descriptions)$/i.test(t.getAttribute('kind') || '') || seen.length >= 80) return;
    let url;
    try {
      url = new URL(raw, location.href).href;
    } catch {
      return;
    }
    if (!/^https?:/i.test(url) || seen.some((x) => x.url === url)) return;
    seen.push({ url, label: t.getAttribute('label') || '', lang: t.getAttribute('srclang') || '' });
  };
  const look = (node) => {
    if (node.nodeType !== 1) return;
    if (node.localName === 'track') note(node);
    else if (node.firstElementChild) node.querySelectorAll('track[src]').forEach(note);
  };
  const watcher = new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(look);
  });
  watcher.observe(document.documentElement || document, { childList: true, subtree: true });
  // Once the page has loaded, what is on it is what the content script sees anyway.
  addEventListener('load', () => setTimeout(() => watcher.disconnect(), 3000), { once: true });
})();

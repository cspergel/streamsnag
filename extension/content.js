// StreamSnag content script: reports <video>/<audio>/<track> URLs found in the page and answers
// snapshot requests used by site recipes and AI analysis. Runs in every frame.
(() => {
  if (window.__streamsnag) return;
  window.__streamsnag = true;

  const MEDIA_HINT = /\.(m3u8|mpd|mp4|webm|m4v|mov|mp3|m4a|vtt|srt)(\?|"|'|\s|$)|manifest|playlist|hls|dash|videoUrl|video_url|playback|stream_url|file"?\s*:/i;
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return null;
    }
  };
  const isHttp = (u) => typeof u === 'string' && /^https?:/i.test(u);

  /** querySelectorAll that also looks inside open shadow roots (web-component players). */
  function deepAll(selector, root = document, out = [], depth = 0) {
    out.push(...root.querySelectorAll(selector));
    if (depth < 6) {
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(selector, el.shadowRoot, out, depth + 1);
    }
    return out;
  }

  function mediaElements() {
    return deepAll('video, audio');
  }

  function collectItems() {
    const items = [];
    const push = (url, extra) => {
      const a = abs(url);
      if (a && isHttp(a)) items.push({ url: a, ...extra });
    };
    for (const el of mediaElements()) {
      const meta = {
        mediaType: el.tagName === 'AUDIO' ? 'audio' : 'video',
        poster: el.poster ? abs(el.poster) : '',
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
      };
      if (el.currentSrc) push(el.currentSrc, meta);
      if (el.src) push(el.src, meta);
      el.querySelectorAll('source[src]').forEach((s) => push(s.getAttribute('src'), { ...meta, contentType: s.type || '' }));
      el.querySelectorAll('track[src]').forEach((t) =>
        push(t.getAttribute('src'), { mediaType: 'subtitle', label: t.label || t.srclang || 'subtitles', lang: t.srclang || '' }));
    }
    document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]')
      .forEach((m) => push(m.content, { mediaType: 'video', from: 'meta' }));
    // Embedded players (Vimeo, Wistia, YouTube...), including ones in tabs/accordions that haven't been
    // opened yet: those never touch the network until shown, so sniffing alone can't see them.
    for (const e of embeds()) items.push(e);
    return items;
  }

  const EMBEDS = [
    // Vimeo showcases (playlists) and live events: one player, many videos. Handed to yt-dlp as a whole.
    { provider: 'vimeo-showcase', re: /^https?:\/\/(?:www\.)?vimeo\.com\/(?:showcase|album)\/(\d+)/i },
    { provider: 'vimeo-event', re: /^https?:\/\/(?:www\.)?vimeo\.com\/event\/(\d+)/i },
    { provider: 'vimeo', re: /^https?:\/\/(?:player\.)?vimeo\.com\/(?:video\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?/i },
    { provider: 'wistia', re: /^https?:\/\/(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([a-z0-9]{6,})/i },
    { provider: 'youtube', re: /^https?:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{11})/i },
    { provider: 'loom', re: /^https?:\/\/(?:www\.)?loom\.com\/(?:embed|share)\/([0-9a-f]{20,})/i },
    { provider: 'dailymotion', re: /^https?:\/\/(?:www\.)?(?:dailymotion\.com\/embed\/video|geo\.dailymotion\.com\/player[^?]*\?video=)\/?([a-z0-9]+)/i },
    { provider: 'jwplayer', re: /^https?:\/\/(?:cdn|content)\.jwplatform\.com\/players\/([a-z0-9]{8})/i },
    { provider: 'brightcove', re: /^https?:\/\/players\.brightcove\.net\/\d+\/[^/]+\/index\.html\?videoId=(\d+)/i },
    { provider: 'kaltura', re: /^https?:\/\/[^/]*kaltura\.com\/.*(?:entry_id[=/])([0-9]_[a-z0-9]{8})/i },
  ];

  /** The label of the tab/accordion section an element sits in, e.g. "Part 2" or "Demo". */
  function sectionLabel(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.getAttribute('role') === 'tabpanel' || /tab-?pane|tab-?panel|tab-content|accordion|collapse/i.test(typeof p.className === 'string' ? p.className : '')) {
        const by = p.getAttribute('aria-labelledby');
        const ctrl = (by && document.getElementById(by))
          || (p.id && document.querySelector(`[aria-controls="${CSS.escape(p.id)}"], [href="#${CSS.escape(p.id)}"], [data-target="#${CSS.escape(p.id)}"], [data-bs-target="#${CSS.escape(p.id)}"]`));
        const t = (ctrl?.textContent || p.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 120) return t;
      }
    }
    return '';
  }

  function embeds() {
    const out = [];
    const seen = new Set();
    const consider = (rawUrl, el) => {
      const url = abs(rawUrl || '');
      if (!url) return;
      for (const { provider, re } of EMBEDS) {
        const m = re.exec(url);
        if (!m) continue;
        const id = m[1];
        if (seen.has(`${provider}:${id}`)) return;
        seen.add(`${provider}:${id}`);
        let hash = m[2] || '';
        try { hash = hash || new URL(url).searchParams.get('h') || ''; } catch { /* ignore */ }
        const title = (el?.getAttribute('title') || el?.getAttribute('aria-label') || '').trim();
        out.push({
          url,
          mediaType: 'video',
          embed: { provider, id, hash },
          label: /^(.*\bplayer|video|embedded (video|content)|iframe)$/i.test(title) ? '' : title,
          section: el ? sectionLabel(el) : '',
          visible: el ? el.getBoundingClientRect().width > 0 : false,
        });
        return;
      }
    };
    for (const f of deepAll('iframe')) {
      if (/localstorage proxy/i.test(f.title || '')) continue; // Vimeo's hidden storage helper, not a video
      consider(f.getAttribute('src'), f);
      consider(f.getAttribute('data-src') || f.getAttribute('data-lazy-src') || f.getAttribute('data-url'), f);
    }
    // Script-based embeds: <div class="wistia_embed wistia_async_abc123">, <div data-vimeo-id="123">.
    // Same shadow-DOM walk as the iframes above: a div-based player in the last tab is often inside a
    // web component, where plain querySelectorAll would never see it.
    for (const el of deepAll('[class*="wistia_async_"]')) {
      const id = /wistia_async_([a-z0-9]+)/i.exec(el.className)?.[1];
      if (id) consider(`https://fast.wistia.net/embed/iframe/${id}`, el);
    }
    for (const el of deepAll('[data-vimeo-id], [data-vimeo-url]')) {
      consider(el.getAttribute('data-vimeo-url') || `https://player.vimeo.com/video/${el.getAttribute('data-vimeo-id')}`, el);
    }
    return out;
  }

  let lastSent = '';
  function report() {
    const items = collectItems();
    // Everything that changes what the list should show counts — not just the URL list. A player that is
    // re-mounted with the same src, or a tab that becomes visible, must still be reported to the worker.
    const sig = items
      .map((i) => `${i.url}\u0000${i.section || ''}\u0000${i.label || ''}\u0000${i.visible ? 1 : 0}`)
      .join('|');
    if (sig === lastSent) return;
    lastSent = sig;
    chrome.runtime.sendMessage({
      type: 'contentMedia',
      items,
      pageTitle: window.top === window ? document.title : '',
      frameUrl: location.href,
      isTop: window.top === window,
    }).catch(() => { lastSent = ''; }); // a worker that was asleep mid-send must not swallow this report
  }

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(report, 800);
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'data-src', 'data-lazy-src', 'data-url', 'data-vimeo-id', 'data-vimeo-url'],
  });
  document.addEventListener('loadedmetadata', schedule, true);
  document.addEventListener('play', schedule, true);
  // Remember the player that was started last, so the popup can show "the video you are watching".
  let lastPlayed = null;
  let lastPlayedAt = 0;
  const notePlay = (e) => {
    if (e.target?.tagName !== 'VIDEO') return;
    lastPlayed = new WeakRef(e.target);
    lastPlayedAt = Date.now();
  };
  document.addEventListener('play', notePlay, true);
  document.addEventListener('playing', notePlay, true);

  /** This frame's player: the one playing now (the biggest, if several), else the one played last. */
  function nowPlaying() {
    const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
    const running = deepAll('video').filter((v) => !v.paused && !v.ended && v.readyState > 1 && area(v) > 0)
      .sort((a, b) => Number(a.muted) - Number(b.muted) || area(b) - area(a))[0];
    // Paused: the one started last, or (if it started before this script was loaded) the biggest one
    // that has been played at all.
    const started = (x) => x?.isConnected && x.currentTime > 0 && !x.ended;
    const last = lastPlayed?.deref();
    const v = running || (started(last) ? last : deepAll('video').filter((x) => started(x) && area(x) > 0).sort((a, b) => area(b) - area(a))[0]);
    if (!v) return null;
    return {
      src: v.currentSrc || '', page: location.href, playing: v === running,
      duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0,
      at: v === last ? lastPlayedAt : 0,
    };
  }
  document.addEventListener('visibilitychange', schedule);
  // On a busy page the 800 ms debounce above is reset forever, so a player mounted into a later tab is
  // never reported. Re-check on a slow timer; report() still sends nothing unless something changed.
  let heartbeat = setInterval(() => { if (!document.hidden) schedule(); }, 3000);
  document.addEventListener('pagehide', () => { clearInterval(heartbeat); heartbeat = null; });
  document.addEventListener('pageshow', () => {
    if (!heartbeat) heartbeat = setInterval(() => { if (!document.hidden) schedule(); }, 3000);
    schedule();
  });
  schedule();

  function snippetsAround(text, max = 40) {
    const out = [];
    const re = new RegExp(MEDIA_HINT.source, 'gi');
    let m;
    while ((m = re.exec(text)) && out.length < max) {
      const start = Math.max(0, m.index - 220);
      out.push(text.slice(start, m.index + 280).replace(/\s+/g, ' '));
      re.lastIndex = m.index + 280;
    }
    return out;
  }

  function snapshot(selectors = []) {
    const html = document.documentElement.outerHTML;
    const scripts = [...document.scripts]
      .filter((s) => !s.src && s.textContent)
      .map((s) => s.textContent.slice(0, 200000));
    const selectorHits = {};
    for (const { selector, attr } of selectors) {
      const key = `${selector}@@${attr}`;
      try {
        selectorHits[key] = [...document.querySelectorAll(selector)]
          .map((el) => (attr === 'text' ? el.textContent : el.getAttribute(attr) || el[attr]))
          .filter(Boolean)
          .slice(0, 50)
          .map(String);
      } catch {
        selectorHits[key] = [];
      }
    }
    const videos = mediaElements().map((v) => ({
      src: v.getAttribute('src') || '',
      currentSrc: v.currentSrc || '',
      sources: [...v.querySelectorAll('source')].map((s) => `${s.getAttribute('src') || ''} ${s.type || ''}`.trim()),
      tracks: [...v.querySelectorAll('track')].map((t) => `${t.getAttribute('src') || ''} ${t.srclang || ''}`.trim()),
      duration: Number.isFinite(v.duration) ? Math.round(v.duration) : '',
    }));
    const iframes = [...document.querySelectorAll('iframe[src]')].map((f) => abs(f.getAttribute('src'))).filter(Boolean).slice(0, 30);
    const meta = [...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')]
      .map((m) => `${m.getAttribute('property') || m.getAttribute('name')}=${m.content}`)
      .slice(0, 40);
    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent.slice(0, 4000)).slice(0, 5);
    const snippets = [...snippetsAround(scripts.join('\n'), 40), ...snippetsAround(html.replace(/<script[\s\S]*?<\/script>/gi, ''), 15)];
    return {
      url: location.href,
      title: document.title,
      html: html.slice(0, 600000),
      scripts,
      selectorHits,
      dom: { videos, iframes, meta, jsonLd },
      snippets: [...new Set(snippets)].slice(0, 50),
    };
  }

  // ---------------------------------------------------------------- what is this video called?
  // Course and streaming sites put the program name in document.title and the lecture/episode name in
  // the page: the highlighted item in the curriculum sidebar, a heading by the player, the player's own
  // label, or structured data. Collect those, best first.

  const clean = (s) => String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/\b(completed|complete|in progress|now playing|playing|current|start|resume|play|locked|preview)\b\s*$/gi, '')
    .replace(/\(?\b\d{1,2}:\d{2}(?::\d{2})?\b\)?\s*$/g, '') // trailing duration "12:30"
    .replace(/\(?\b\d+\s*(?:min|mins|minutes|sec|s)\b\.?\)?\s*$/gi, '') // "12 min"
    .replace(/^[\s✓✔☑●○•▶►|:-]+|[\s✓✔☑●○•▶►|:-]+$/g, '')
    .trim();
  const usable = (s) => s.length >= 3 && s.length <= 180 && /\p{L}/u.test(s);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const LIST_HINT = /curriculum|lecture|lesson|chapter|playlist|syllabus|module|course|toc|outline|sidebar|episode|unit|section|item|step|nav/i;
  const ACTIVE_CLASS = /(^|[\s_-])(active|current|selected|is-active|is-current|is-selected|playing|now-playing)($|[\s_-])/i;

  /** The text that names a list item: prefer an inner title element over the whole row's text. */
  function itemText(el) {
    const inner = el.querySelector('[class*="title" i], [class*="name" i], [data-purpose*="title" i], h3, h4, h5, strong');
    const t = clean(inner?.textContent || '');
    if (usable(t)) return t;
    return clean(el.getAttribute('aria-label') || el.textContent || '');
  }

  function activeListItem() {
    const found = [];
    const sel = '[aria-current]:not([aria-current="false"]), [aria-selected="true"], li[class], a[class], [role="listitem"][class], [role="treeitem"], [class*="item" i][class]';
    for (const el of document.querySelectorAll(sel)) {
      const flagged = (el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false')
        || el.getAttribute('aria-selected') === 'true'
        || ACTIVE_CLASS.test(typeof el.className === 'string' ? el.className : '');
      if (!flagged || !visible(el)) continue;
      if (el.closest('header, footer') && !el.closest('aside, [class*="sidebar" i], [class*="curriculum" i]')) continue;
      // Inside something that looks like a lesson list, and not a menu/tab bar of the site itself.
      let ctx = el.parentElement;
      let inList = false;
      for (let i = 0; ctx && i < 8; i++, ctx = ctx.parentElement) {
        const id = `${ctx.id} ${typeof ctx.className === 'string' ? ctx.className : ''} ${ctx.getAttribute('aria-label') || ''}`;
        if (LIST_HINT.test(id) || ctx.tagName === 'ASIDE' || ctx.tagName === 'OL') { inList = true; break; }
      }
      if (!inList) continue;
      const text = itemText(el);
      if (usable(text)) found.push({ el, text });
    }
    // Nested highlights (active module > active lesson): keep the innermost.
    const inner = found.filter((f) => !found.some((g) => g !== f && f.el.contains(g.el)));
    return inner[0]?.text || '';
  }

  const urlKey = (u) => { try { return new URL(u, location.href).href.split('#')[0]; } catch { return ''; } };

  /**
   * Players on the page, the one most likely playing this video first: the element whose source IS the
   * video, else the one playing right now (streams play from blob: URLs), else the biggest.
   */
  function players(url) {
    const big = deepAll('video, iframe').filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 200 && r.height >= 110;
    }).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    const want = url ? urlKey(url) : '';
    const exact = want && deepAll('video, audio, iframe').find((el) => [el.currentSrc, el.getAttribute('src'), el.getAttribute('data-src'),
      ...[...el.querySelectorAll('source[src]')].map((x) => x.getAttribute('src'))].some((u) => u && !u.startsWith('blob:') && urlKey(u) === want));
    const playing = deepAll('video').find((v) => !v.paused && !v.ended && v.readyState > 1);
    const first = exact || playing;
    return first ? [first, ...big.filter((el) => el !== first)] : big;
  }

  function playerLabel(p) {
    if (!p) return '';
    for (const attr of ['title', 'aria-label', 'data-title', 'data-video-title', 'data-name']) {
      const t = clean(p.getAttribute(attr));
      // Skip generic labels like "Vimeo video player" or "Embedded video".
      if (usable(t) && !/^(.*\bplayer|video|media|embedded (video|content)|iframe)$/i.test(t)) return t;
    }
    for (let el = p.parentElement, i = 0; el && i < 4; el = el.parentElement, i++) {
      const t = clean(el.getAttribute('data-title') || el.getAttribute('data-video-title') || '');
      if (usable(t)) return t;
    }
    return '';
  }

  /** The heading closest to the player (lecture pages usually title the video right above or below it). */
  function nearestHeading(p) {
    const hs = [...document.querySelectorAll('h1, h2, h3, [role="heading"]')].filter(visible);
    if (!hs.length) return '';
    const pr = p?.getBoundingClientRect();
    let best = null;
    for (const hd of hs) {
      const t = clean(hd.textContent);
      if (!usable(t)) continue;
      const r = hd.getBoundingClientRect();
      const d = pr ? Math.min(Math.abs(r.bottom - pr.top), Math.abs(r.top - pr.bottom)) : (hd.tagName === 'H1' ? 0 : 500);
      if (pr && d > 450) continue;
      if (!best || d < best.d) best = { t, d };
    }
    return best?.t || '';
  }

  function structuredName() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = [JSON.parse(s.textContent)].flat();
        for (const d of data.flatMap((x) => [x, ...(x['@graph'] || [])])) {
          if (/VideoObject|Episode|LearningResource/i.test(String(d?.['@type'])) && usable(clean(d.name))) return clean(d.name);
        }
      } catch { /* ignore bad JSON-LD */ }
    }
    const og = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.content;
    return usable(clean(og)) ? clean(og) : '';
  }

  /** Strip the site/course part from a title like "Lecture 3 | Big Course | Academy". */
  function withoutSuffix(title, course) {
    let t = clean(title);
    if (course && t.toLowerCase().includes(course.toLowerCase()) && t.length > course.length + 3) {
      t = clean(t.replace(new RegExp(course.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ''));
    }
    return t;
  }

  function videoName(url) {
    const p = players(url)[0];
    const pageTitle = clean(document.title).replace(/\s+(?:from\s+.+\s+)?on\s+Vimeo$/i, '');
    const site = clean(document.querySelector('meta[property="og:site_name"]')?.content);
    const candidates = [
      ['player', playerLabel(p)],
      ['list', activeListItem()],
      ['heading', nearestHeading(p)],
      ['structured', structuredName()],
    ].filter(([, t]) => t);
    // A "lecture name" that is just the page/program title is no better than the page title.
    const distinct = candidates.filter(([, t]) => t.toLowerCase() !== pageTitle.toLowerCase());
    const [source, name] = distinct[0] || candidates[0] || ['title', withoutSuffix(pageTitle, site)];
    let course = '';
    if (name && name.toLowerCase() !== pageTitle.toLowerCase()) {
      course = withoutSuffix(pageTitle.replace(name, ''), site) || site;
    }
    const h1 = [...document.querySelectorAll('h1')].filter(visible).map((x) => clean(x.textContent)).find(usable) || '';
    // How long the video in that player is: tells the worker which stream this name belongs to.
    const duration = p?.tagName === 'VIDEO' && Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0;
    return { name, source, course: course || site, heading: h1, pageTitle, duration, candidates: candidates.map(([s, t]) => `${s}: ${t}`) };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'videoName') {
      try {
        sendResponse(window.top === window || msg.frame ? videoName(msg.url) : null);
      } catch (e) {
        sendResponse({ error: e.message });
      }
      return;
    }
    if (msg?.type === 'playing') {
      try {
        sendResponse(nowPlaying());
      } catch {
        sendResponse(null);
      }
      return;
    }
    if (msg?.type === 'snapshot') {
      // Only the top frame answers full snapshots; sub-frames answer when targeted by frameId.
      try {
        sendResponse(snapshot(msg.selectors || []));
      } catch (e) {
        sendResponse({ error: e.message });
      }
    } else if (msg?.type === 'rescan') {
      lastSent = '';
      report();
      sendResponse({ ok: true, frame: location.href });
    }
  });
})();

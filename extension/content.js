// StreamSnag content script: reports <video>/<audio>/<track> URLs found in the page and answers
// snapshot requests used by site recipes and AI analysis. Runs in every frame.
(() => {
  if (window.__streamsnag) return;
  window.__streamsnag = true;

  const MEDIA_HINT = /\.(m3u8|mpd|mp4|webm|m4v|mov|mp3|m4a|vtt|srt)(\?|"|'|\s|$)|manifest|playlist|hls|dash|videoUrl|video_url|playback|stream_url|file"?\s*:/i;
  // (An address that is not there, a frame with no src or src="", is nothing: never the page's own address.)
  const abs = (u) => {
    if (typeof u !== 'string' || !u.trim()) return null;
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
      // A player offered several files (<source>s: the same video in other sizes or types) is still one
      // video: its files share a group, named after the first of them, and so do its caption tracks.
      const sources = [...el.querySelectorAll('source[src]')];
      const files = [...new Set(sources.map((s) => abs(s.getAttribute('src'))).filter(isHttp))];
      const group = files.length > 1 ? `el:${files[0]}` : '';
      const own = group ? { ...meta, group } : meta;
      if (el.currentSrc) push(el.currentSrc, own);
      if (el.src) push(el.src, own);
      sources.forEach((s) => push(s.getAttribute('src'), {
        ...own, contentType: s.type || '',
        // What the page says of this file: its picture height, or a label like "Low quality WebM (240P)".
        height: Number(s.getAttribute('data-height') || s.getAttribute('res') || s.getAttribute('size') || s.getAttribute('height')) || 0,
        quality: s.getAttribute('label') || s.getAttribute('data-title') || s.getAttribute('title') || s.getAttribute('data-quality') || '',
      }));
      el.querySelectorAll('track[src]').forEach((t) => {
        if (/^(metadata|chapters|descriptions)$/i.test(t.getAttribute('kind') || '')) return; // thumbnails and chapter marks are not captions
        push(t.getAttribute('src'), { mediaType: 'subtitle', label: t.label || t.srclang || 'subtitles', lang: t.srclang || '', group });
      });
    }
    // Caption tracks the page's own markup declared (extension/early.js saw them as the page was read):
    // a player script may have taken its <video>, and the <track>s in it, off the page since.
    for (const t of window.__streamsnagTracks || []) {
      if (!items.some((i) => i.url === t.url)) items.push({ url: t.url, mediaType: 'subtitle', label: t.label || t.lang || 'subtitles', lang: t.lang || '' });
    }
    document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]')
      .forEach((m) => push(m.content, { mediaType: 'video', from: 'meta' }));
    // Video and sound files the page links to ("Download video", a list of lectures to download): each is
    // reported under the name its link gives it, and what its row says (the worker decides which of them
    // says anything). Nothing is asked of the links here, nor by the worker until StreamSnag is opened.
    // (At most MAX_LINKS of them: the rest are counted, so StreamSnag can say how many it left out.)
    const found = new Map(); // address -> { as: every link to it, mediaType }
    const listed = new Set(items.map((i) => i.url));
    const over = new Set();
    for (const a of deepAll('a[href]')) {
      const raw = a.getAttribute('href') || '';
      const kind = LINKED_MEDIA.exec(raw);
      if (!kind) continue;
      const url = abs(raw);
      if (!url || !isHttp(url) || !LINKED_MEDIA.test(new URL(url).pathname) || listed.has(url)) continue;
      if (found.has(url)) found.get(url).as.push(a);
      else if (found.size >= MAX_LINKS) over.add(url);
      else found.set(url, { as: [a], mediaType: LINKED_AUDIO.test(kind[1]) ? 'audio' : 'video' });
    }
    linksLeft = over.size;
    const words = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const where = found.size > 1 ? linkBlocks(found) : null;
    for (const [url, { as, mediaType }] of found) {
      // A file linked twice (a "latest episode" button above the list, and the list's own row): the link that is one of the list's.
      const a = (where && as.length > 1 && as.find((x) => where.inList(x, url))) || as[0];
      // (One link alone is the page's own lecture: the page names it. A row is worked out once while the page has the same links.)
      const known = rows.get(a);
      const said = !where ? { row: '', near: '' } : known?.n === found.size ? known : { row: words(rowOf(a, url, where)), near: words(nearOf(a)) };
      rows.set(a, { n: found.size, row: said.row, near: said.near });
      items.push({ url, mediaType, linked: true, label: words(a.innerText || a.textContent) || words(a.getAttribute('aria-label') || a.getAttribute('title')), row: said.row, near: said.near });
    }
    // Embedded players (Vimeo, Wistia, Loom...), including ones in tabs/accordions that haven't been
    // opened yet: those never touch the network until shown, so sniffing alone can't see them.
    for (const e of embeds()) items.push(e);
    return items;
  }

  // A link to a video or sound file, by the end of its address (before any query).
  const LINKED_MEDIA = /\.(mp4|m4v|webm|mov|mkv|ogv|mp3|m4a|ogg|oga|opus|wav|flac)(?:$|[?#])/i;
  const LINKED_AUDIO = /^(?:mp3|m4a|ogg|oga|opus|wav|flac)$/i;
  const MAX_LINKS = 150; // media links reported from one frame (the worker keeps as many: lib/linked.js)
  let linksLeft = 0; // media links past that, counted and not reported
  const rows = new WeakMap(); // a media link -> { n, row, near }: what its row says, as found when the page had n such links

  /**
   * Where the page's media links sit: for every element above one of them, which file's links it holds
   * (one file's alone, or several files'). `block(a, url)`: the largest block that holds this link and
   * no other file's (a lecture's panel, a row); `beside(el)`: does this element hold, or is it, a media
   * link; `inList(a, url)`: is the link's block one of a list of like blocks (the element next to it, of
   * the same kind, holds another file's link).
   */
  function linkBlocks(found) {
    const MANY = Symbol('several files');
    const holds = new Map(); // element -> the one address linked under it, or MANY
    const anchors = new Set();
    for (const [url, { as }] of found) {
      for (const a of as) {
        anchors.add(a);
        for (let p = a.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
          const had = holds.get(p);
          if (had === MANY) break; // everything above it is marked already
          holds.set(p, had === undefined || had === url ? url : MANY);
        }
      }
    }
    const block = (a, url) => {
      let top = null;
      for (let p = a.parentElement; p && holds.get(p) === url; p = p.parentElement) top = p;
      return top;
    };
    const beside = (el) => holds.has(el) || anchors.has(el);
    const inList = (a, url) => {
      const b = block(a, url);
      return !!b?.parentElement && [...b.parentElement.children].some((el) => el !== b && el.localName === b.localName && holds.has(el));
    };
    return { block, beside, inList };
  }

  /**
   * What the row a media link sits in says of it, for a link that only says "Download": the heading of
   * the largest block that holds this link and no other file's link (a lecture's panel), else the words
   * of its row of a table or a list, without its links and buttons ("Lecture 5", "Counting"). Only in a
   * list of such blocks (a block beside it holds another of the links); '' when the row says too much to
   * be a name.
   */
  function rowOf(a, url, where) {
    const block = where.block(a, url);
    const beside = block?.parentElement ? [...block.parentElement.children] : [];
    if (!block || !beside.some((el) => el !== block && where.beside(el))) return '';
    const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const head = [...block.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], th, dt, caption, summary, legend')]
      .map((el) => tidy(el.innerText || el.textContent)).find((t) => t.length >= 2 && t.length <= 160);
    if (head) return head;
    // Else the words of the link's own row of a table or a list, cell by cell (two cells are two words).
    const row = a.closest('tr, li, dd, [role="row"], [role="listitem"]');
    if (!row || !block.contains(row)) return '';
    const said = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest('a, button, script, style')) said.push(n.nodeValue);
    const text = tidy(said.join(' '));
    return text.length <= 160 ? text : '';
  }

  /**
   * The words of the main link of a media link's own row of a table or a list: beside a link that only
   * says "Play" stands the link that carries the chapter's or the episode's title. The longest text among
   * the row's other links; '' where the link is in no such row, or the "row" is a whole part of the page
   * (more than a handful of links).
   */
  function nearOf(a) {
    const row = a.closest('tr, li, dd, [role="row"], [role="listitem"]');
    if (!row) return '';
    const others = [...row.querySelectorAll('a[href]')].filter((x) => x !== a);
    if (!others.length || others.length > 8) return '';
    const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return others.map((x) => tidy(x.innerText || x.textContent)).filter((t) => t.length >= 3 && t.length <= 160 && /\p{L}/u.test(t))
      .sort((x, y) => y.length - x.length)[0] || '';
  }

  /**
   * Playlists written into the page: the JSON a player is set up with (an attribute named "playlist", a
   * hidden field, a JSON data block). Only text that could be one is taken; the worker reads it (lib/variants.js).
   */
  function collectLists() {
    const out = [];
    const take = (text) => {
      const t = String(text || '').trim();
      if (out.length < 3 && t.length > 40 && t.length < 1500000 && /^[[{]/.test(t) && /"(?:sources|file|src)"\s*:/.test(t) && !out.includes(t)) out.push(t);
    };
    for (const el of document.querySelectorAll('[playlist], [data-playlist]')) take(el.getAttribute('playlist') || el.getAttribute('data-playlist'));
    for (const el of document.querySelectorAll('input[type="hidden"][value^="["]')) take(el.value);
    for (const el of document.querySelectorAll('script[type="application/json"]')) take(el.textContent);
    return out;
  }

  const EMBEDS = [
    // Vimeo showcases (playlists) and live events: one player, many videos.
    { provider: 'vimeo-showcase', re: /^https?:\/\/(?:www\.)?vimeo\.com\/(?:showcase|album)\/(\d+)/i },
    { provider: 'vimeo-event', re: /^https?:\/\/(?:www\.)?vimeo\.com\/event\/(\d+)/i },
    { provider: 'vimeo', re: /^https?:\/\/(?:player\.)?vimeo\.com\/(?:video\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?/i },
    { provider: 'wistia', re: /^https?:\/\/(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([a-z0-9]{6,})/i },
    // @site-edition
    { provider: 'youtube', re: /^https?:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{11})/i },
    // @end-site-edition
    { provider: 'loom', re: /^https?:\/\/(?:www\.)?loom\.com\/(?:embed|share)\/([0-9a-f]{20,})/i },
    { provider: 'dailymotion', re: /^https?:\/\/(?:www\.)?(?:dailymotion\.com\/embed\/video|geo\.dailymotion\.com\/player[^?]*\?video=)\/?([a-z0-9]+)/i },
    { provider: 'jwplayer', re: /^https?:\/\/(?:cdn|content)\.jwplatform\.com\/players\/([a-z0-9]{8})/i },
    { provider: 'brightcove', re: /^https?:\/\/players\.brightcove\.net\/\d+\/[^/]+\/index\.html\?videoId=(\d+)/i },
    { provider: 'kaltura', re: /^https?:\/\/[^/]*kaltura\.com\/.*(?:entry_id[=/])([0-9]_[a-z0-9]{8})/i },
  ];

  /** The tab/accordion section an element sits in: { label: its label, e.g. "Part 2" or "Demo", panel: the section itself }. */
  function sectionOf(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.getAttribute('role') === 'tabpanel' || /tab-?pane|tab-?panel|tab-content|accordion|collapse/i.test(typeof p.className === 'string' ? p.className : '')) {
        const by = p.getAttribute('aria-labelledby');
        const ctrl = (by && document.getElementById(by))
          || (p.id && document.querySelector(`[aria-controls="${CSS.escape(p.id)}"], [href="#${CSS.escape(p.id)}"], [data-target="#${CSS.escape(p.id)}"], [data-bs-target="#${CSS.escape(p.id)}"]`));
        const t = (ctrl?.textContent || p.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 120) return { label: t, panel: p };
      }
    }
    return { label: '', panel: null };
  }

  /** The heading that stands before an element inside its section (the nearest one above it there); '' when there is none. */
  function headingBefore(el, panel) {
    let last = '';
    for (const hd of panel.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
      if (!(hd.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) break; // this heading, and the ones after it, come after the player
      const t = (hd.innerText || hd.textContent || '').replace(/\s+/g, ' ').trim().replace(/[\s:]+$/, '');
      if (t.length >= 3 && t.length <= 160) last = t;
    }
    return last;
  }

  function embeds() {
    const out = [];
    const seen = new Set();
    const panels = new Map(); // a listed player -> { el, panel }: where it sits
    const consider = (rawUrl, el) => {
      const url = abs(rawUrl || '');
      // (A frame with no address, a cookie banner's, or one that points back at this very page is not a player in the page.)
      if (!url || url.split('#')[0] === location.href.split('#')[0]) return;
      for (const { provider, re } of EMBEDS) {
        const m = re.exec(url);
        if (!m) continue;
        const id = m[1];
        if (seen.has(`${provider}:${id}`)) return;
        seen.add(`${provider}:${id}`);
        let hash = m[2] || '';
        try { hash = hash || new URL(url).searchParams.get('h') || ''; } catch { /* ignore */ }
        const title = (el?.getAttribute('title') || el?.getAttribute('aria-label') || '').trim();
        const sect = el ? sectionOf(el) : { label: '', panel: null };
        const item = {
          url,
          mediaType: 'video',
          embed: { provider, id, hash },
          label: /^(.*\bplayer|video|embedded (video|content)|iframe)$/i.test(title) ? '' : title,
          section: sect.label,
          visible: el ? el.getBoundingClientRect().width > 0 : false,
        };
        if (sect.panel) panels.set(item, { el, panel: sect.panel });
        out.push(item);
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
    // Several players in one section (a tab that holds two videos) that say nothing of themselves: the
    // section's label would name them all alike. Each takes the heading that stands before it inside the
    // section when that heading is its alone; the ones left are told apart by their place ("Licensing",
    // "Licensing (2)"): two players are two videos.
    const bySection = new Map();
    for (const item of out) {
      const at = panels.get(item);
      if (!at || item.label) continue;
      if (!bySection.has(at.panel)) bySection.set(at.panel, []);
      bySection.get(at.panel).push(item);
    }
    for (const [panel, group] of bySection) {
      if (group.length < 2) continue;
      const heads = group.map((item) => headingBefore(panels.get(item).el, panel));
      let alike = 0;
      group.forEach((item, i) => {
        if (heads[i] && heads.filter((x) => x === heads[i]).length === 1) item.label = heads[i];
        else if (++alike > 1) item.label = `${item.section} (${alike})`;
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- documents linked on the page
  // Course pages link their slides and handouts next to the video. Which file types count is the worker's
  // list (lib/files.js, which this script can't import): until it has answered, nothing is collected.
  let docExts = null;
  function askDocTypes() {
    chrome.runtime.sendMessage({ type: 'docTypes' }).then((r) => {
      if (!Array.isArray(r?.exts)) return;
      docExts = new Set(r.exts);
      schedule();
    }).catch(() => {});
  }

  const DOC_HINT = /\.[a-z0-9]{1,8}\s*(?:[?#]|$)/i; // cheap first look, before each link is parsed
  /** Links and embeds whose address ends in a document type: [{url, text, alt}], or null (types not known yet). */
  function collectDocs() {
    if (!docExts) return null;
    const out = [];
    const seen = new Set();
    const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    for (const el of deepAll('a[href], embed[src], object[data], iframe[src]')) {
      if (out.length >= 200) break;
      const tag = el.localName;
      const raw = el.getAttribute(tag === 'a' ? 'href' : tag === 'object' ? 'data' : 'src') || '';
      if (!DOC_HINT.test(raw)) continue;
      let u;
      try {
        u = new URL(raw, location.href);
      } catch {
        continue;
      }
      if (!isHttp(u.href) || !docExts.has(/\.([a-z0-9]{1,8})$/i.exec(u.pathname)?.[1].toLowerCase())) continue;
      u.hash = '';
      // The visible text names the file; the worker decides whether it says anything ("Download" doesn't).
      const text = tag === 'a' ? short(el.innerText || el.textContent) : '';
      const id = `${u.href}\u0000${text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ url: u.href, text, alt: short(el.getAttribute('title') || el.getAttribute('aria-label')) });
    }
    return out;
  }
  const docsSig = (docs) => (docs?.length ? `\u0001${docs.map((d) => `${d.url}\u0000${d.text}\u0000${d.alt}`).join('|')}` : '');

  /**
   * How many pages of single lectures this page links to, when it is plainly a list of them (a course's
   * page, a series): links of this site that are each the heading or the title of a block ("<h2><a>", a
   * table's title cell), to addresses of one shape, three or more, numbered the way lectures are
   * ("Vorlesung Analysis 2, 1. Stunde", "8.4 Persons, Humans and Brains"). 0 when the page is not such a
   * list: a front page of headlines has no numbers to go by. Nothing is asked of any of them.
   */
  function lectureLinks() {
    const here = location.href.split('#')[0];
    const groups = new Map(); // the shape of the addresses -> Map(address -> the link's words)
    let looked = 0;
    for (const a of document.querySelectorAll('h2 a[href], h3 a[href], h4 a[href], [class~="title" i] a[href], [class*="-title" i] a[href], [class*="_title" i] a[href]')) {
      if (++looked > 1500) break;
      const raw = a.getAttribute('href') || '';
      if (!raw || raw.startsWith('#') || LINKED_MEDIA.test(raw)) continue;
      let u;
      try { u = new URL(raw, location.href); } catch { continue; }
      const url = u.href.split('#')[0];
      // (Not the site's menus or its footer. A list of lectures may well sit in an <aside>: that is not left out.)
      if (u.origin !== location.origin || url === here || a.closest('nav, footer, header, [role="navigation"], [role="contentinfo"], [role="banner"], [role="menu"]')) continue;
      const text = clean(a.innerText || a.textContent);
      if (!usable(text)) continue;
      const parts = u.pathname.split('/').filter(Boolean);
      const shape = [...parts.slice(0, -1), '*'].join('/');
      if (!groups.has(shape)) groups.set(shape, new Map());
      if (!groups.get(shape).has(url)) groups.get(shape).set(url, text);
    }
    let best = 0;
    for (const links of groups.values()) {
      const numbers = [...links.values()].map((t) => (t.match(/\d+/g) || []).join('.')).filter(Boolean);
      if (links.size >= 3 && links.size > best && numbers.length >= links.size * 0.7 && new Set(numbers).size >= Math.max(3, numbers.length * 0.7)) best = links.size;
    }
    return Math.min(best, 999);
  }

  let lastSent = '';
  let pageAt = location.href.split('#')[0];
  function report() {
    // The address changed without a load (a single-page app went on to its next page): the caption
    // tracks the page declared as it loaded were the previous page's, not this one's.
    const here = location.href.split('#')[0];
    if (here !== pageAt) {
      pageAt = here;
      if (window.__streamsnagTracks) window.__streamsnagTracks.length = 0;
    }
    const items = collectItems();
    const docs = collectDocs();
    const lists = collectLists();
    // The sources of players that play a stream (an address of the player's own making): they tell the
    // worker whether a player still has what it had before the page's address changed.
    const blobs = [...new Set(mediaElements().map((el) => el.currentSrc || '').filter((s) => s.startsWith('blob:')))].slice(0, 8);
    // (Only where nothing to save was found: a page with no video that lists its lectures, each on a page of its own.)
    const lectures = window.top === window && !items.length ? lectureLinks() : 0;
    // Everything that changes what the list should show counts — not just the URL list. A player that is
    // re-mounted with the same src, or a tab that becomes visible, must still be reported to the worker.
    const sig = items
      .map((i) => `${i.url}\u0000${i.section || ''}\u0000${i.label || ''}\u0000${i.row || ''}\u0000${i.near || ''}\u0000${i.visible ? 1 : 0}\u0000${i.group || ''}\u0000${Math.round(i.duration || 0)}`)
      .join('|') + `\u0004${linksLeft}\u0005${lectures}` + docsSig(docs) + lists.map((l) => `\u0002${l.length}:${l.slice(0, 80)}`).join('') + blobs.map((b) => `\u0003${b}`).join('');
    if (sig === lastSent) return;
    lastSent = sig;
    chrome.runtime.sendMessage({
      type: 'contentMedia',
      items,
      blobs,
      docs: docs || undefined,
      lists: lists.length ? lists : undefined,
      linksLeft: linksLeft || undefined, // media links past the limit: counted, not reported
      lectures: lectures || undefined, // pages of single lectures this page lists (only where it has nothing to save itself)
      pageLang: window.top === window ? document.documentElement.lang || '' : '',
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
  // When the page was last clicked (or a key pressed in it). A single-page app changes its address after a
  // click: what was found before that click belongs to the page left behind (the worker asks: 'clickedAt').
  // A script that has seen the page under another address knows the page was not loaded anew.
  const bornAt = location.href.split('#')[0];
  let lastAddress = bornAt;
  let clickedAt = 0;
  const noteClick = () => { clickedAt = Date.now(); };
  addEventListener('pointerdown', noteClick, { capture: true, passive: true });
  addEventListener('keydown', noteClick, { capture: true, passive: true });

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
  askDocTypes();

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
    // The page's headings as its markup has them ('<h1 class="title"> Lecture 3: Sorting'), for a rule that says where the lecture's title is.
    const headings = [...document.querySelectorAll('h1, h2')].slice(0, 12).map((el) => {
      const cls = typeof el.className === 'string' && el.className.trim() ? ` class="${el.className.trim().slice(0, 80)}"` : '';
      const said = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      return said ? `<${el.localName}${el.id ? ` id="${el.id.slice(0, 60)}"` : ''}${cls}> ${said}` : '';
    }).filter(Boolean);
    const snippets = [...snippetsAround(scripts.join('\n'), 40), ...snippetsAround(html.replace(/<script[\s\S]*?<\/script>/gi, ''), 15)];
    return {
      url: location.href,
      title: document.title,
      html: html.slice(0, 600000),
      scripts,
      selectorHits,
      dom: { videos, iframes, meta, jsonLd, headings },
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
  const LIST_HINT = /curriculum|lecture|lesson|chapter|playlist|syllabus|module|course|outline|sidebar|episode|unit|section|item|step|nav/i;
  const ACTIVE_CLASS = /(^|[\s_-])(active|current|selected|is-active|is-current|is-selected|playing|now-playing)($|[\s_-])/i;
  // Lists that have a highlighted entry and are not lessons: this page's table of contents, a strip of
  // tabs, a breadcrumb, page numbers, a menu of languages or of player settings.
  const NOT_LESSONS = /(^|[\s_-])(toc|table-of-contents|breadcrumbs?|pagination|pager|controlbar)($|[\s_-])/i;
  // (Only on the entry itself or just above it: a lesson list may well sit inside a tab's panel.)
  const NOT_LESSONS_NEAR = /(^|[\s_-])(tabs?|tablist|tabbar|dropdown|languages?|lang|settings|controls?|toolbar)($|[\s_-])/i;
  const NOT_LESSON_ROLE = /^(tab|tablist|option|listbox|menu|menubar|menuitem|menuitemradio|menuitemcheckbox|radio|toolbar|combobox)$/;
  const idOf = (el) => `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;

  /** A highlighted entry that belongs to a table of contents, a tab strip or a menu: never a lesson's name. */
  function notLesson(el) {
    let p = el;
    for (let i = 0; p && p !== document.body && i < 6; i++, p = p.parentElement) {
      if (NOT_LESSONS.test(idOf(p))) return true;
      if (i < 3 && (NOT_LESSON_ROLE.test(p.getAttribute('role') || '') || NOT_LESSONS_NEAR.test(idOf(p)))) return true;
    }
    // Entries that point into this same page ("#summary", "#") are its table of contents or its tabs.
    const list = el.closest('ul, ol, [role="list"], [role="tree"], nav') || el.parentElement;
    const links = list ? [...list.querySelectorAll('a[href]')] : [];
    const here = links.filter((a) => /^#(?![/!])/.test(a.getAttribute('href') || ''));
    return links.length >= 2 && here.length * 2 >= links.length;
  }

  /**
   * Does this list hold the player, or sit next to it (beside it, or right above or below)? A lesson list
   * does; a menu at the other end of the page does not. With no player on the page nothing can be told.
   */
  function byPlayer(el, p) {
    if (!p) return true;
    const list = el.closest('ul, ol, aside, nav, [role="list"], [role="tree"]') || el.parentElement;
    if (!list) return false;
    for (let a = list, i = 0; a && a !== document.body && i < 3; i++, a = a.parentElement) if (a.contains(p)) return true;
    const l = list.getBoundingClientRect();
    const r = p.getBoundingClientRect();
    const beside = l.top < r.bottom && l.bottom > r.top; // shares the player's rows: a sidebar
    const under = l.left < r.right && l.right > r.left && l.top >= r.bottom - 10 && l.top - r.bottom <= 200; // a playlist right below it
    return beside || under;
  }

  /** The text that names a list item: prefer an inner title element over the whole row's text. */
  function itemText(el) {
    const inner = el.querySelector('[class*="title" i], [class*="name" i], [data-purpose*="title" i], h3, h4, h5, strong');
    const t = clean(inner?.textContent || '');
    if (usable(t)) return t;
    return clean(el.getAttribute('aria-label') || el.textContent || '');
  }

  function activeListItem(p) {
    const found = [];
    const sel = '[aria-current]:not([aria-current="false"]), [aria-selected="true"], li[class], a[class], [role="listitem"][class], [role="treeitem"], [class*="item" i][class]';
    for (const el of document.querySelectorAll(sel)) {
      const flagged = (el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false')
        || el.getAttribute('aria-selected') === 'true'
        || ACTIVE_CLASS.test(typeof el.className === 'string' ? el.className : '');
      if (!flagged || !visible(el)) continue;
      if (el.closest('header, footer') && !el.closest('aside, [class*="sidebar" i], [class*="curriculum" i]')) continue;
      // Only a list of lessons, with more than this one entry, that holds the player or sits next to it.
      if (notLesson(el) || !byPlayer(el, p)) continue;
      const row = el.closest('li, [role="listitem"], [role="treeitem"]') || el;
      if ((row.parentElement?.children.length || 0) < 2) continue;
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
  // A heading of the page's furniture, not of its content: in the navigation or the footer, in a table
  // of contents, or the site's own name in its top bar.
  // (Also the notice about cookies that sits over the foot of a page, right under a player: "We use cookies on this site…".)
  const FURNITURE = /(^|[\s_-])(logo|brand|masthead|navbar|topbar|header-bar|site-(?:title|name|header)|toc|table-of-contents|menu|footer|cookies?|cookiebar|cookieconsent|consent|gdpr)($|[\s_-])/i;
  function furniture(hd) {
    if (hd.closest('nav, footer, aside, [role="navigation"], [role="contentinfo"], [role="banner"], [role="menu"], [role="complementary"], [role="dialog"], [role="alertdialog"]')) return true;
    // The page's own header (right under <body>, or holding the site's menu), not the header of an article or a lesson.
    const top = hd.closest('header');
    if (top && (top.parentElement === document.body || top.querySelector('nav, [role="navigation"]'))) return true;
    for (let p = hd, i = 0; p && p !== document.body && i < 4; i++, p = p.parentElement) if (FURNITURE.test(idOf(p))) return true;
    return false;
  }

  function nearestHeading(p) {
    const hs = [...document.querySelectorAll('h1, h2, h3, [role="heading"]')].filter((hd) => visible(hd) && !furniture(hd));
    const pr = p?.getBoundingClientRect();
    if (!hs.length) return titleBy(pr);
    let best = null;
    for (const hd of hs) {
      const t = clean(hd.textContent);
      if (!usable(t)) continue;
      const r = hd.getBoundingClientRect();
      const d = pr ? Math.min(Math.abs(r.bottom - pr.top), Math.abs(r.top - pr.bottom)) : (hd.tagName === 'H1' ? 0 : 500);
      if (pr && d > 450) continue;
      // Above or below the player, in its own column: a heading in a column beside it titles that column.
      if (pr && !(r.left < pr.right && r.right > pr.left)) continue;
      if (!best || d < best.d) best = { t, d };
    }
    return best?.t || titleBy(pr);
  }

  /**
   * On a page with no heading by its player: the line right above or below the player that the page's own
   * markup calls the title (`<div class="title">Vorlesung Analysis 2, 1. Stunde</div>`). Only one line of
   * plain words, in the player's column, within a short reach of it, and not the page's furniture; ''
   * when there is none or more than one at that reach (a row of cards, each with its title).
   */
  function titleBy(pr) {
    if (!pr) return '';
    const near = [];
    for (const el of document.querySelectorAll('[class~="title" i], [class~="video-title" i], [class~="videotitle" i], [class~="lecture-title" i], [class~="media-title" i]')) {
      if (el.children.length > 2 || !visible(el) || furniture(el) || el.closest('a, button, li, [role="listitem"]')) continue;
      const t = clean(el.innerText || el.textContent);
      if (!usable(t) || t.length > 160) continue;
      const r = el.getBoundingClientRect();
      const d = Math.min(Math.abs(r.bottom - pr.top), Math.abs(r.top - pr.bottom));
      if (d > 160 || !(r.left < pr.right && r.right > pr.left)) continue;
      near.push({ t, d });
    }
    near.sort((a, b) => a.d - b.d);
    return near.length && (near.length === 1 || near[1].d - near[0].d > 40) ? near[0].t : '';
  }

  /** The names the page's video data (JSON-LD) gives: a VideoObject's, an Episode's, a LearningResource's. */
  function videoDataNames() {
    const names = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = [JSON.parse(s.textContent)].flat();
        for (const d of data.flatMap((x) => [x, ...(x['@graph'] || [])])) {
          if (/VideoObject|Episode|LearningResource/i.test(String(d?.['@type'])) && usable(clean(d.name))) names.push(clean(d.name));
        }
      } catch { /* ignore bad JSON-LD */ }
    }
    return names;
  }

  function structuredName() {
    const og = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.content;
    return videoDataNames()[0] || (usable(clean(og)) ? clean(og) : '');
  }

  /**
   * What the page itself says its video is called, when it says so of one video: the one name in its
   * video data, or its own title where the page declares that it is a video (og:type "video.other",
   * "video.episode"…). '' on a page that names several videos or does not say what it is.
   */
  function declaredVideo() {
    const names = [...new Set(videoDataNames())];
    if (names.length) return names.length === 1 ? names[0] : '';
    if (!/^video\b/i.test(document.querySelector('meta[property="og:type"]')?.content || '')) return '';
    const og = clean(document.querySelector('meta[property="og:title"]')?.content);
    return usable(og) ? og : '';
  }

  /**
   * What this page offers as the name of the video at `url`: the player's own label, the highlighted
   * lesson of a list by the player, the heading by the player, the page's video data, and its title.
   * Which of them a person would use is decided by the worker (lib/naming.js: chooseName).
   */
  function videoName(url) {
    const p = players(url)[0];
    const h1 = [...document.querySelectorAll('h1')].filter((x) => visible(x) && !furniture(x)).map((x) => clean(x.textContent)).find(usable) || '';
    // How long the video in that player is: tells the worker which stream this name belongs to.
    const duration = p?.tagName === 'VIDEO' && Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0;
    return {
      signals: true, player: playerLabel(p), list: activeListItem(p), heading: nearestHeading(p), structured: structuredName(), video: declaredVideo(),
      title: clean(document.title), site: clean(document.querySelector('meta[property="og:site_name"]')?.content), host: location.hostname, h1, duration,
      lang: document.documentElement.lang || '', // the page's language: its subtitles are among the first saved with a video
      // The page has gone on to another address without a load: its data may still be the first page's.
      moved: location.href.split('#')[0] !== bornAt,
    };
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
    if (msg?.type === 'clickedAt') {
      // (`moved`: the address is not the one this script last saw, so the page went on without a load.)
      const here = location.href.split('#')[0];
      sendResponse({ at: clickedAt, moved: here !== lastAddress });
      lastAddress = here;
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
      if (!docExts) askDocTypes(); // the worker was not there to answer the first time
      lastSent = '';
      report();
      sendResponse({ ok: true, frame: location.href });
    }
  });
})();

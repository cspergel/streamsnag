// The store edition's one transformation of the source: blocks marked as belonging to the website edition
// are taken out. Pure (text in, text out), so the tests run it on its own; scripts/build-release.mjs uses it.
//
// The markers, in any of the three comment styles (the one the file uses):
//
//   // @site-edition            /* @site-edition */            <!-- @site-edition -->
//   …website edition only…       …                              …
//   // @end-site-edition        /* @end-site-edition */        <!-- @end-site-edition -->
//
// A marker on a line of its own takes its whole line with it, so a block of lines leaves no blank line
// behind. A /* */ or <!-- --> marker may also sit inside a line, around a few words of it:
//
//   const KINDS = ['hls', 'dash', /* @site-edition */ 'extra', /* @end-site-edition */ 'doc'];
//
// (Such a block takes the one space after it when there is one before it: ['hls', 'dash', 'doc'].)
//
// A block of lines may end in what the store edition has instead, written as comments that it uncomments:
//
//   // @site-edition
//   offerTheOtherWay();
//   // @store-edition
//   // sayNothingMore();
//   // @end-site-edition
//
// (In HTML and CSS each of those lines is a comment of its own: <!-- <p>…</p> --> or /* .a { } */.)
//
// Blocks never nest; a marker without its partner, a nested one, or a misspelt one is an error, so a
// mistake stops the build instead of shipping half a block.

// Two kinds of marked blocks, each with its own three markers; one kind's markers are never read as the other's:
//   'site'  @site-edition … [@store-edition …] @end-site-edition   taken out of the Chrome Web Store edition
//   'pro'   @pro … [@free …] @end-pro                              taken out of the public, free source (Pro is private)
// Every comment that opens with "@" and a word that looks like a marker of that kind is read as one, so a
// misspelling is caught too (for 'site': any word with "site", "store" or "edit" in it; for 'pro': "pro",
// "end-pro" or "free", with anything joined on by a hyphen).
export const KINDS = {
  site: { open: 'site-edition', alt: 'store-edition', close: 'end-site-edition', word: String.raw`@([\w-]*(?:site|store|edit)[\w-]*)` },
  pro: { open: 'pro', alt: 'free', close: 'end-pro', word: String.raw`@((?:end-)?pro(?:-[\w-]+)?|free(?:-[\w-]+)?)(?![\w-])` },
};
const tokenOf = (kind) => {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown kind of marker "${kind}"`);
  return new RegExp(String.raw`\/\/[ \t]*${k.word}[^\n]*|\/\*[ \t]*${k.word}[ \t]*\*\/|<!--[ \t]*${k.word}[ \t]*-->`, 'g');
};

/** Where a line starts and ends (without its line break), for the character at `at`. */
function lineAround(text, at) {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  let end = text.indexOf('\n', at);
  if (end < 0) end = text.length;
  return { start, end };
}

/** The markers in a text, in order: [{ name, start, end, alone, line: { start, end }, slashes }]. */
export function findMarkers(text, file = '', kind = 'site') {
  const out = [];
  const k = KINDS[kind];
  for (const m of String(text).matchAll(tokenOf(kind))) {
    const found = m[1] || m[2] || m[3];
    const lineNo = text.slice(0, m.index).split('\n').length;
    // (Named by their role, so the rest of this file reads the same for both kinds.)
    const name = found === k.open ? 'site-edition' : found === k.alt ? 'store-edition' : found === k.close ? 'end-site-edition' : '';
    if (!name) throw new Error(`${file}:${lineNo}: unknown ${kind === 'pro' ? 'Pro' : 'edition'} marker "@${found}"`);
    const slashes = m[0].startsWith('//');
    if (slashes && m[0].replace(/^\/\/[ \t]*@[\w-]+/, '').trim()) {
      throw new Error(`${file}:${lineNo}: a // marker must be alone on its line ("${m[0].trim()}")`);
    }
    const line = lineAround(text, m.index);
    const before = text.slice(line.start, m.index);
    const after = text.slice(m.index + m[0].length, line.end);
    const alone = !before.trim() && !after.trim();
    if (slashes && !alone) throw new Error(`${file}:${lineNo}: a // marker must be alone on its line`);
    out.push({ name, start: m.index, end: m.index + m[0].length, alone, line, slashes, lineNo });
  }
  return out;
}

/**
 * The marked blocks of a text: [{ open, alt, close }] (alt: the @store-edition marker, or null). Throws on
 * nesting, a marker without its partner, or a @store-edition outside a block of whole lines.
 */
export function findBlocks(text, file = '', kind = 'site') {
  const blocks = [];
  let cur = null;
  for (const mk of findMarkers(text, file, kind)) {
    if (mk.name === 'site-edition') {
      if (cur) throw new Error(`${file}:${mk.lineNo}: @site-edition inside the block opened on line ${cur.open.lineNo} (blocks do not nest)`);
      cur = { open: mk, alt: null, close: null };
    } else if (mk.name === 'store-edition') {
      if (!cur) throw new Error(`${file}:${mk.lineNo}: @store-edition outside a block`);
      if (cur.alt) throw new Error(`${file}:${mk.lineNo}: a second @store-edition in the block opened on line ${cur.open.lineNo}`);
      cur.alt = mk;
    } else {
      if (!cur) throw new Error(`${file}:${mk.lineNo}: @end-site-edition without its @site-edition`);
      cur.close = mk;
      if (cur.alt && !(cur.open.alone && cur.alt.alone && mk.alone)) {
        throw new Error(`${file}:${cur.open.lineNo}: a block with @store-edition must have every marker on a line of its own`);
      }
      blocks.push(cur);
      cur = null;
    }
  }
  if (cur) throw new Error(`${file}:${cur.open.lineNo}: @site-edition is never closed`);
  return blocks;
}

/** The store edition's lines of a block: its commented lines after @store-edition, uncommented. */
function storeLines(text, alt, close, file) {
  const from = alt.line.end + 1;
  const to = close.line.start;
  if (to <= from) return '';
  const lines = text.slice(from, to).replace(/\n$/, '').split('\n');
  // (Each line a comment in the style of the @store-edition marker itself: //, /* … */ or <!-- … -->.)
  const style = alt.slashes ? { re: /^([ \t]*)\/\/ ?(.*)$/, name: '// comment' }
    : text.startsWith('<!--', alt.start) ? { re: /^([ \t]*)<!-- ?(.*?) ?-->[ \t]*$/, name: '<!-- … --> comment' }
      : { re: /^([ \t]*)\/\* ?(.*?) ?\*\/[ \t]*$/, name: '/* … */ comment' };
  return `${lines.map((l, i) => {
    if (!l.trim()) return '';
    const m = style.re.exec(l.replace(/\r$/, ''));
    if (!m) throw new Error(`${file}:${alt.lineNo + 1 + i}: a line after @store-edition must be a ${style.name}`);
    return `${m[1]}${m[2]}${l.endsWith('\r') ? '\r' : ''}`;
  }).join('\n')}\n`;
}

/**
 * The text with every marked block taken out (the store edition), or as it is when it has none.
 * `file`: its name, for the error messages.
 */
export function stripEdition(text, file = '', kind = 'site') {
  text = String(text);
  const blocks = findBlocks(text, file, kind);
  if (!blocks.length) return text;
  let out = '';
  let at = 0;
  for (const b of blocks) {
    const whole = b.open.alone && b.close.alone;
    const from = whole ? b.open.line.start : b.open.start;
    // (A block of whole lines goes with the close marker's line break; one inside a line leaves the line,
    // and takes the one space after it when there is one before it, so no double space is left.)
    let to = whole ? Math.min(text.length, b.close.line.end + 1) : b.close.end;
    if (!whole && / $/.test(text.slice(0, from)) && text[to] === ' ') to += 1;
    out += text.slice(at, from);
    if (b.alt) out += storeLines(text, b.alt, b.close, file);
    at = to;
  }
  return out + text.slice(at);
}

/** How many blocks a text has (for the build's summary). */
export const countBlocks = (text, file = '', kind = 'site') => findBlocks(String(text), file, kind).length;

/** What the store edition must never contain, in any file, in any case. */
export const FORBIDDEN = /youtube|youtu\.be|yt-dlp|ytdlp|googlevideo/i;

/** And it never speaks of the other edition, nor carries a marker that was left behind. */
export const NO_OTHER_EDITION = /site[- ]edition|website edition|store[- ]edition|@end-site/i;

/**
 * Top-level names a block declares (function, class, const, let, var at the start of a line, exported or
 * not): once the block is gone, the rest of the file (and the files that import it) must not use them.
 */
export function declaredIn(text, file = '', kind = 'site') {
  const names = new Set();
  for (const b of findBlocks(text, file, kind)) {
    const body = text.slice(b.open.end, (b.alt || b.close).start);
    for (const n of declaredNames(body)) names.add(n);
    // (A Pro block often holds whole import lines: the names they bring in are gone with them.)
    if (kind === 'pro') for (const n of importedNames(body)) names.add(n);
  }
  return names;
}

/** The local names a text imports: import { a, b as c } from …, import d from …, import * as e from …. */
export function importedNames(text) {
  const names = new Set();
  for (const m of String(text).matchAll(/^[ \t]*import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/gm)) {
    const what = m[1].trim();
    const brace = /\{([\s\S]*)\}/.exec(what);
    if (brace) {
      for (const part of brace[1].replace(/\/\*[\s\S]*?\*\//g, ' ').split(',').map((x) => x.trim()).filter(Boolean)) names.add(part.split(/\s+as\s+/).pop().trim());
    }
    const head = what.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim();
    const star = /^\*\s+as\s+([\w$]+)/.exec(head);
    if (star) names.add(star[1]);
    else if (head) names.add(head.split(/\s+/)[0]);
  }
  return names;
}

/**
 * The names declared at the very start of a line in a text (see declaredIn); with `indented`, also those
 * declared further in (a name declared anywhere in what is left is not gone).
 */
export function declaredNames(text, { indented = false } = {}) {
  const re = indented ? /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
    : /^(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  return new Set([...String(text).matchAll(re)].map((m) => m[1]));
}

// Minimal, dependency-free XML parser — enough for DASH manifests (works in service workers,
// which have no DOMParser). Produces { name, attrs, children, text }. Namespace prefixes are
// dropped from element/attribute names ("cenc:pssh" -> "pssh").

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const local = (n) => n.slice(n.indexOf(':') + 1);

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) attrs[local(m[1])] = decodeEntities(m[3] ?? m[4] ?? '');
  return attrs;
}

export function parseXML(text) {
  const src = String(text || '')
    .replace(/^﻿/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?>/gi, '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) {
      top.text += m[1];
    } else if (m[6] != null) {
      top.text += decodeEntities(m[6]);
    } else if (m[2] === '/') {
      const name = local(m[3]);
      // Pop to the matching element (tolerates small mismatches).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
    } else {
      const el = { name: local(m[3]), attrs: parseAttrs(m[4] || ''), children: [], text: '' };
      top.children.push(el);
      if (m[5] !== '/') stack.push(el);
    }
  }
  const doc = root.children[0];
  if (!doc) throw new Error('Empty or invalid XML');
  trimText(doc);
  return doc;
}

function trimText(el) {
  el.text = el.text.trim();
  el.children.forEach(trimText);
}

export const child = (el, name) => el?.children.find((c) => c.name === name) || null;
export const childrenOf = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);

/** Depth-first search for any descendant with this name. */
export function findAll(el, name, out = []) {
  if (!el) return out;
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

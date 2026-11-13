// Builds the two release packages of StreamSnag from extension/ (no dependencies, no network):
//
//   dist/site/   and dist/streamsnag-website-<version>.zip   the extension exactly as it is in extension/
//   dist/store/  and dist/streamsnag-store-<version>.zip     the Chrome Web Store edition: every block
//                marked "@site-edition" taken out (scripts/edition-strip.mjs) and the manifest overlay
//                (scripts/manifest.store.json) applied
//   dist/store-helper/ and dist/streamsnag-store-helper-<version>.zip   the local helper (native-host/)
//                for that edition, stripped the same way, its installer given the store's extension id
//                (scripts/helper.store.json) so it answers that extension and no other
//
// Usage:  node scripts/build-release.mjs            both
//         node scripts/build-release.mjs --store    the store edition only
//         node scripts/build-release.mjs --site     the website edition only
//         node scripts/build-release.mjs --helper   the store helper only
//         add --no-zip to build the folders only (the store checks still run)
//
// The build fails (exit code 1, nothing half-made left in dist/) when:
//  - a marker is unbalanced, nested or misspelt;
//  - any file of the store edition matches FORBIDDEN (the words it must never contain), or names the
//    other edition, or still carries a marker;
//  - a JavaScript file of the store edition does not parse, imports a file that is not there, imports a
//    name its module no longer exports, or still uses a name that was declared only in a removed block;
//  - the website edition differs by a single byte from extension/ (apart from LEFT_OUT).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripEdition, countBlocks, declaredIn, declaredNames, FORBIDDEN, NO_OTHER_EDITION } from './edition-strip.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const OVERLAY = path.join(ROOT, 'scripts', 'manifest.store.json');
const HELPER_SRC = path.join(ROOT, 'native-host');
const HELPER_CONFIG = path.join(ROOT, 'scripts', 'helper.store.json');
/** The helper's own files (the rest of native-host/ is made on each computer by its installer). */
export const HELPER_FILES = ['host.js', 'protocol.js', 'install.js'];
/** What the store helper's installer has in place of the extension id until the build writes it in. */
export const ID_SLOT = '__STORE_EXTENSION_ID__';

/** Files never packaged: they are not needed at runtime (operating-system leftovers). */
export const LEFT_OUT = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.[^/]*\.swp)$/i;
/** Files the strip reads as text (everything else is copied byte for byte, and still searched). */
const TEXT = /\.(?:js|mjs|cjs|html|css|json|txt|md|svg|webmanifest)$/i;

/** Every file under a folder, as forward-slash paths relative to it, sorted (so a zip is always the same). */
export function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** RFC 7396 JSON merge patch: an object merges into the one it replaces, null removes a key. */
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('//')) continue; // a note in the overlay, not a manifest key
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

// ---------------------------------------------------------------- a small zip writer (stored + deflate)

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of [{ name, data }] with a fixed date on every entry, so the same files always make the same zip. */
export function makeZip(entries) {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(useDeflate ? 8 : 0, 8); head.writeUInt16LE(DOS_TIME, 10); head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    local.push(head, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10); cen.writeUInt16LE(DOS_TIME, 12); cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** The entries of a zip this script wrote: [{ name, data }] (for the checks). */
export function readZip(buf) {
  const out = [];
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const body = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body) });
    p += 30 + nameLen + extra + size;
  }
  return out;
}

// ---------------------------------------------------------------- the store edition's checks

/** Which JavaScript files run as classic scripts (content scripts, <script> without type=module); the rest are modules. */
function classicScripts(dir, manifest) {
  const classic = new Set();
  for (const cs of manifest?.content_scripts || []) for (const f of cs.js || []) classic.add(f);
  for (const f of listFiles(dir).filter((x) => /\.html$/i.test(x))) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
      const src = /\bsrc="([^"]+)"/i.exec(m[1])?.[1];
      if (src && !/type="module"/i.test(m[1])) classic.add(path.posix.normalize(path.posix.join(path.posix.dirname(f), src)));
    }
  }
  return classic;
}

/** What a module exports by name (export function/const/class, export { a as b }, export * from …). */
function exportsOf(code) {
  const names = new Set();
  const starFrom = [];
  for (const m of code.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  // (Also where a bundle puts it, after other code on its last line: "…})();export{V_ as Anthropic};".)
  for (const m of code.matchAll(/(?:^|[;}\s])export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm)) {
    for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) names.add(part.split(/\s+as\s+/).pop().trim());
  }
  for (const m of code.matchAll(/^export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) starFrom.push(m[1]);
  if (/^export\s+default\b/m.test(code)) names.add('default');
  return { names, starFrom };
}

/** Every static import of a module: [{ from, names: [...] }] (names: the imported names, 'default', or '*'). */
function importsOf(code) {
  const out = [];
  for (const m of code.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const what = m[1].trim();
    const names = [];
    const brace = /\{([\s\S]*)\}/.exec(what);
    // (Comments inside the braces, such as edition markers, are not names.)
    if (brace) for (const part of brace[1].replace(/\/\*[\s\S]*?\*\//g, ' ').split(',').map((s) => s.trim()).filter(Boolean)) names.push(part.split(/\s+as\s+/)[0].trim());
    const head = what.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim();
    if (/^\*\s+as\s+/.test(head)) names.push('*');
    else if (head) names.push('default');
    out.push({ from: m[2], names });
  }
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push({ from: m[1], names: [] });
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ from: m[1], names: ['*'] });
  return out;
}

/**
 * Each of these files parsed as an ES module (as the browser loads it), whatever folder it is in: one
 * Node process, `vm.SourceTextModule` (parsed, never linked or run). Returns { file: error } for the ones
 * that do not parse.
 */
function parseModules(dir, files) {
  const checker = `
    const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
    const [dir, list] = [process.argv[1], JSON.parse(process.argv[2])]; const bad = {};
    for (const f of list) {
      try { new vm.SourceTextModule(fs.readFileSync(path.join(dir, f), 'utf8'), { identifier: f }); }
      catch (e) { bad[f] = String((e && e.message) || e); }
    }
    process.stdout.write(JSON.stringify(bad));`;
  const out = execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', checker, dir, JSON.stringify(files)],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out || '{}');
}

/**
 * The JavaScript of a built folder: every file parses (modules as modules, classic scripts as
 * scripts), every relative import is there and exports what is asked of it. `removed`: { file: Set of
 * names declared only in a removed block }; none of them may still be used in that file or by name in
 * a file that imports it. Returns a list of problems ([] when all is well).
 */
export function checkScripts(dir, removed = {}) {
  const problems = [];
  // (The helper's folder has no manifest: every file of it is a module.)
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const classic = classicScripts(dir, manifest);
  const files = listFiles(dir).filter((f) => /\.(?:m?js)$/i.test(f));
  const code = new Map(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
  const unparsed = parseModules(dir, files.filter((f) => !classic.has(f)));
  for (const f of files) {
    const src = code.get(f);
    if (classic.has(f)) {
      try { new vm.Script(src, { filename: f }); } catch (e) { problems.push(`${f}: does not parse: ${e.message}`); }
      continue;
    }
    if (unparsed[f]) {
      problems.push(`${f}: does not parse: ${unparsed[f]}`);
      continue;
    }
    for (const imp of importsOf(src)) {
      if (!imp.from.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), imp.from));
      if (!code.has(target)) { problems.push(`${f}: imports ${imp.from}, which is not in the build`); continue; }
      const ex = exportsOf(code.get(target));
      if (ex.starFrom.length) continue; // re-exports: not followed (none in the extension today)
      for (const n of imp.names) {
        if (n !== '*' && !ex.names.has(n)) problems.push(`${f}: imports "${n}" from ${imp.from}, which does not export it`);
      }
    }
  }
  // Names only a removed block declared: still used (outside comments) in the file, or in a file that imports it?
  for (const [file, names] of Object.entries(removed)) {
    if (!names.size || !code.has(file)) continue;
    const users = [file, ...files.filter((f) => importsOf(code.get(f)).some((i) => i.from.startsWith('.') && path.posix.normalize(path.posix.join(path.posix.dirname(f), i.from)) === file))];
    for (const u of users) {
      const body = strip(code.get(u));
      // In a file that imports it, only the names it takes from it (or all of them, for "import * as"): a name of
      // its own, or one it imports from elsewhere, is not this module's.
      const from = u === file ? null : importsOf(code.get(u)).filter((i) => i.from.startsWith('.') && path.posix.normalize(path.posix.join(path.posix.dirname(u), i.from)) === file).flatMap((i) => i.names);
      const check = from && !from.includes('*') ? [...names].filter((n) => from.includes(n)) : names;
      // (Not a property's name, as in "{ madeKeys: … }".)
      for (const n of check) if (new RegExp(`(?<![\\w$.'"])${n.replace(/\$/g, '\\$')}(?![\\w$]|\\s*:(?!:))`).test(body)) problems.push(`${u}: still uses "${n}", which only a removed block declared${u === file ? '' : ` (in ${file})`}`);
    }
  }
  return problems;
}

/** Every file of a folder that contains a forbidden word or names the other edition: ["file:line: …"]. */
export function searchForbidden(dir) {
  const hits = [];
  for (const f of listFiles(dir)) {
    if (FORBIDDEN.test(f)) hits.push(`${f}: its name`);
    const text = fs.readFileSync(path.join(dir, f)).toString('latin1');
    for (const re of [FORBIDDEN, NO_OTHER_EDITION]) {
      const g = new RegExp(re.source, 'gi');
      for (const m of text.matchAll(g)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${f}:${line}: "${text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ')}"`);
        if (hits.length > 200) return hits;
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------- the builds

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function fresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(dir, { recursive: true });
}

function writeZip(dir, zipPath) {
  const entries = listFiles(dir).map((name) => ({ name, data: fs.readFileSync(path.join(dir, name)) }));
  const zip = makeZip(entries);
  fs.writeFileSync(zipPath, zip);
  return { files: entries.length, bytes: zip.length };
}

/** The store edition into `out`: { blocks: { file: n }, removed: { file: Set } }. Throws on a bad marker. */
export function buildStore(out, src = SRC, overlayFile = OVERLAY) {
  fresh(out);
  const blocks = {};
  const removed = {};
  for (const f of listFiles(src)) {
    if (LEFT_OUT.test(f)) continue;
    const from = path.join(src, f);
    const to = path.join(out, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (TEXT.test(f)) {
      const text = fs.readFileSync(from, 'utf8');
      const n = countBlocks(text, f);
      const store = n ? stripEdition(text, f) : text;
      if (n) {
        blocks[f] = n;
        // (A name the store edition declares again, in its own lines or elsewhere, is not gone.)
        const still = declaredNames(store, { indented: true });
        removed[f] = new Set([...declaredIn(text, f)].filter((x) => !still.has(x)));
      }
      fs.writeFileSync(to, store);
    } else fs.copyFileSync(from, to);
  }
  const manifestPath = path.join(out, 'manifest.json');
  const overlay = JSON.parse(fs.readFileSync(overlayFile, 'utf8'));
  const before = fs.readFileSync(manifestPath, 'utf8');
  const manifest = mergePatch(JSON.parse(before), overlay);
  // (Written the way extension/manifest.json is, so the two differ only by what the overlay changes.)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}${before.endsWith('\n') ? '\n' : ''}`);
  return { blocks, removed, manifest };
}

const HELPER_README = (id) => `StreamSnag local helper

The small program on your computer that StreamSnag uses to join a video's picture and sound, convert
files, turn a lecture's speech into text, and run your own AI subscription. It needs Node.js 20 or newer
(https://nodejs.org) and, for joining and converting, ffmpeg.

To set it up, open a terminal in this folder and run:

    node install.js${id ? '' : ' --id <the id of StreamSnag shown in chrome://extensions>'}

then restart the browser. To remove it:

    node install.js --uninstall
`;

/**
 * The store edition's helper into `out`: HELPER_FILES stripped like the extension, the installer given the
 * extension id (when one is set), a package.json so Node reads the files as modules, and a short README.
 * Returns { blocks, removed, id }. Throws on a bad marker, or an id that is not one.
 */
export function buildHelper(out, src = HELPER_SRC, configFile = HELPER_CONFIG) {
  fresh(out);
  const id = String(JSON.parse(fs.readFileSync(configFile, 'utf8')).extensionId || '').trim();
  if (id && !/^[a-p]{32}$/.test(id)) throw new Error(`${rel(configFile)}: "${id}" is not an extension id (32 letters, a to p)`);
  const blocks = {};
  const removed = {};
  for (const f of HELPER_FILES) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    const n = countBlocks(text, f);
    let store = n ? stripEdition(text, f) : text;
    if (n) {
      blocks[f] = n;
      const still = declaredNames(store, { indented: true });
      removed[f] = new Set([...declaredIn(text, f)].filter((x) => !still.has(x)));
    }
    if (f === 'install.js') {
      if (!store.includes(`'${ID_SLOT}'`)) throw new Error(`install.js: its store lines have no '${ID_SLOT}' to write the extension id into`);
      if (id) store = store.replace(`'${ID_SLOT}'`, `'${id}'`);
    }
    fs.writeFileSync(path.join(out, f), store);
  }
  const version = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')).version;
  fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify({ name: 'streamsnag-helper', version, private: true, type: 'module' }, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'README.txt'), HELPER_README(id));
  return { blocks, removed, id };
}

/** The website edition into `out`: extension/ as it is (minus LEFT_OUT). */
export function buildSite(out, src = SRC) {
  fresh(out);
  for (const f of listFiles(src)) {
    if (LEFT_OUT.test(f)) continue;
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(out, f));
  }
}

/** Differences between extension/ and a folder or a zip of the website edition: [] when they are the same. */
export function siteDrift(src, files) {
  const want = listFiles(src).filter((f) => !LEFT_OUT.test(f));
  const have = new Map(files.map((e) => [e.name, e.data]));
  const out = [];
  for (const f of want) {
    if (!have.has(f)) out.push(`${f}: missing`);
    else if (!fs.readFileSync(path.join(src, f)).equals(have.get(f))) out.push(`${f}: differs`);
  }
  for (const f of have.keys()) if (!want.includes(f)) out.push(`${f}: not in extension/`);
  return out;
}

const folderEntries = (dir) => listFiles(dir).map((name) => ({ name, data: fs.readFileSync(path.join(dir, name)) }));

function main(argv) {
  const only = argv.includes('--store') ? 'store' : argv.includes('--site') ? 'site' : argv.includes('--helper') ? 'helper' : '';
  const zip = !argv.includes('--no-zip');
  const version = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')).version;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (pkg !== version) console.warn(`note: package.json says ${pkg}, the manifest ${version}; the packages take the manifest's`);
  fs.mkdirSync(DIST, { recursive: true });
  let failed = false;
  const fail = (title, list) => {
    failed = true;
    console.error(`FAIL  ${title}`);
    for (const p of list.slice(0, 60)) console.error(`      ${p}`);
    if (list.length > 60) console.error(`      … and ${list.length - 60} more`);
  };

  if (!only || only === 'store') {
    const out = path.join(DIST, 'store');
    const zipPath = path.join(DIST, `streamsnag-store-${version}.zip`);
    fs.rmSync(zipPath, { force: true });
    let built;
    try {
      built = buildStore(out);
    } catch (e) {
      fail('the store edition could not be built', [e.message]);
    }
    if (built) {
      const total = Object.values(built.blocks).reduce((a, b) => a + b, 0);
      console.log(`store edition: ${total} marked blocks taken out of ${Object.keys(built.blocks).length} files`);
      for (const [f, n] of Object.entries(built.blocks)) console.log(`      ${String(n).padStart(3)}  ${f}`);
      const hits = searchForbidden(out);
      if (hits.length) fail(`the store edition still contains words it must not (${hits.length})`, hits);
      else console.log('PASS  no file of the store edition matches the forbidden words or names another edition');
      const problems = checkScripts(out, built.removed);
      if (problems.length) fail(`the store edition's JavaScript has problems (${problems.length})`, problems);
      else console.log('PASS  every JavaScript file of the store edition parses, and every import is there');
      if (!failed && zip) {
        const z = writeZip(out, zipPath);
        console.log(`      ${rel(zipPath)}: ${z.files} files, ${(z.bytes / 1024).toFixed(1)} KB`);
      }
      if (failed) fs.rmSync(zipPath, { force: true });
    }
  }

  if (!only || only === 'helper') {
    const out = path.join(DIST, 'store-helper');
    const zipPath = path.join(DIST, `streamsnag-store-helper-${version}.zip`);
    fs.rmSync(zipPath, { force: true });
    let built;
    try {
      built = buildHelper(out);
    } catch (e) {
      fail('the store helper could not be built', [e.message]);
    }
    if (built) {
      const total = Object.values(built.blocks).reduce((a, b) => a + b, 0);
      console.log(`store helper: ${total} marked blocks taken out of ${Object.keys(built.blocks).length} files`);
      const hits = searchForbidden(out);
      if (hits.length) fail(`the store helper still contains words it must not (${hits.length})`, hits);
      const problems = checkScripts(out, built.removed);
      if (problems.length) fail(`the store helper's JavaScript has problems (${problems.length})`, problems);
      if (!hits.length && !problems.length) console.log('PASS  the store helper: no forbidden word, every module parses, every import is there');
      if (built.id) console.log(`      its installer answers the extension ${built.id}`);
      else console.warn(`note: no extension id in ${rel(HELPER_CONFIG)} yet; the helper's installer will ask for --id`);
      if (!failed && zip) {
        const z = writeZip(out, zipPath);
        console.log(`      ${rel(zipPath)}: ${z.files} files, ${(z.bytes / 1024).toFixed(1)} KB`);
      }
      if (failed) fs.rmSync(zipPath, { force: true });
    }
  }

  if (!only || only === 'site') {
    const out = path.join(DIST, 'site');
    const zipPath = path.join(DIST, `streamsnag-website-${version}.zip`);
    fs.rmSync(zipPath, { force: true });
    buildSite(out);
    let drift = siteDrift(SRC, folderEntries(out));
    if (!drift.length && zip) {
      const z = writeZip(out, zipPath);
      drift = siteDrift(SRC, readZip(fs.readFileSync(zipPath)));
      if (!drift.length) console.log(`      ${rel(zipPath)}: ${z.files} files, ${(z.bytes / 1024).toFixed(1)} KB`);
    }
    if (drift.length) {
      fs.rmSync(zipPath, { force: true });
      fail('the website edition is not the same as extension/', drift);
    } else console.log('PASS  the website edition is extension/ byte for byte');
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

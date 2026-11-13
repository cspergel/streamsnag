// The public, free source of StreamSnag (GPL-3.0): dist/public/, from what is committed on HEAD.
//
//   - Pro is private: whole files (extension/pro/, the study engine in extension/lib/, the helper's
//     transcription, the desk's pictures and own files, their tests and checks) are left out, and every block
//     marked "@pro" … "@end-pro" in the files that stay is taken out (scripts/edition-strip.mjs, kind 'pro').
//   - The website edition: "@site-edition" blocks stay (the public source is the full downloader).
//   - Never public: planning/, the website (docs/ is published on its own), key files, dist/.
//   - LICENSE becomes GPL-3.0 and README.md the public one (both from scripts/public/); package.json says so.
//
// The export stops (exit 1, nothing left in dist/public/) when:
//   - a marker is unbalanced, nested or misspelt;
//   - a JavaScript file left in does not parse, imports a file that is not there (dynamic imports too), imports a
//     name its module no longer exports, or still uses a name only a removed block declared or imported;
//   - any file left in names a Pro file, or looks like it holds a secret.
// Files of extension/lib/ that nothing left in uses any more are listed and left out too.
//
// Usage:  node scripts/export-public.mjs            build and check dist/public/
//         node scripts/export-public.mjs --test     also run the unit tests in it
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripEdition, countBlocks, declaredIn, declaredNames, importedNames } from './edition-strip.mjs';
import { checkScripts, listFiles, mergePatch } from './build-release.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'dist', 'public');

/** Never public, whatever else is decided below. */
// (CHANGELOG.md tells the story of Pro's making too: the public repository gets its own at launch.)
const NEVER = /^(planning|docs|dist|brand)\/|^CHANGELOG\.md$|(^|\/)(deepseek|gpt|cloudflare)\.txt$|\.key$|(^|\/)\.env(\.|$)|token.*\.txt$|api-?key/i;

/** Pro, as whole files (the owner's list: transcription, reading edition, study page, study pack, review cards, slide sync, mock exams, the licence and the desk). */
export const PRO_FILES = [
  /^extension\/pro\//,
  /^extension\/lib\/(studypack|reading)\//,
  /^extension\/(review\.html|review\.css|reviewpage\.js)$/,
  /^extension\/lib\/(align|studypage|readerbar|slidedecks|pptx|pptximage|pdftext|pdfimage|zipread|studyrun|packstyles|examrun|readrun|decks|entitlement|licence)\.js$/,
  /^extension\/vendor\/pdfjs\//,
  /^extension\/fonts\//,
  /^native-host\/(stt|own|covers)\.js$/,
  /^scripts\/(e2e-(desk|licence|mockexam|own|path|pptx|reading|studypack)\.js|eval-studypack\.mjs|vendor-pdfjs\.js|embed-fonts\.js)$/,
  /^tests\/fixtures\/(studypack|pptx)\//,
  /^tests\/desk[\w-]*\.test\.js$/,
  /^tests\/export-public\.test\.js$/, // (it needs the private repository: it checks what the export leaves out of it)
  // The browser checks (scripts/e2e*.js) all lean on Pro's own (the licence's test server, the study tools'
  // lessons): they stay private for now. The unit tests (tests/) are public.
  /^scripts\/e2e[\w-]*\.js$/,
  // The fresh-computer run (it uses the study tools on the sample lecture) and the workflow that runs it.
  /^scripts\/clean-install\.mjs$/,
  /^\.github\/workflows\/clean-install\.yml$/,
];

/** The words a public file must never contain: a Pro file's path, or a secret's shape. */
const PRO_NAMES = /(?:^|[^\w-])(?:pro\/(?:index|desk|desklogic|keyscreen|ledger|mockexam|path|pathlogic|settings)\.js|lib\/studypack\/|lib\/reading\/|studyrun\.js|readrun\.js|examrun\.js|entitlement\.js|licence\.js|native-host\/stt\.js)/;
const SECRET = /sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{30,}/;
const EMAIL = /[\w.+-]+@gmail\.com/i;
const TEXT = /\.(?:js|mjs|cjs|html|css|json|txt|md|svg|yml|yaml|ps1|cmd|bat|sh|gitignore|gitattributes)$|(^|\/)\.[\w]+$/i;
/** Files that write about the markers (their examples are text, not blocks): copied as they are. */
const AS_IS = new Set(['scripts/edition-strip.mjs', 'scripts/export-public.mjs', 'tests/edition-strip.test.js']);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });

/**
 * The files git tracks (never an untracked file, such as a key file), as forward-slash paths, read from disk.
 * (Publishing takes the export of a clean, committed tree: see the publishing steps in planning/STATUS.md.)
 */
function committedFiles() {
  return sh('git', ['ls-files']).split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
}
const committed = (f) => fs.readFileSync(path.join(ROOT, f));

/** Relative imports of a module (static and dynamic), resolved against its folder. */
function importsOfFile(f, code) {
  const out = [];
  for (const m of code.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) out.push(m[1]);
  return out.filter((s) => s.startsWith('.')).map((s) => path.posix.normalize(path.posix.join(path.posix.dirname(f), s)));
}

/** extension/lib files nothing else in the export reaches any more (from every page, script and the manifest). */
function unreached(out) {
  const ext = path.join(out, 'extension');
  const files = listFiles(ext);
  const code = new Map(files.filter((f) => /\.m?js$/.test(f)).map((f) => [f, fs.readFileSync(path.join(ext, f), 'utf8')]));
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  const start = new Set(files.filter((f) => /^[^/]+\.m?js$/.test(f))); // every script at the top of the extension
  if (manifest.background?.service_worker) start.add(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) for (const j of cs.js || []) start.add(j);
  for (const f of files.filter((x) => /\.html$/.test(x))) {
    for (const m of fs.readFileSync(path.join(ext, f), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) start.add(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])));
  }
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f) || !code.has(f)) return;
    seen.add(f);
    for (const t of importsOfFile(f, code.get(f))) visit(t);
  };
  for (const f of start) visit(f);
  return [...code.keys()].filter((f) => f.startsWith('lib/') && !seen.has(f)).map((f) => `extension/${f}`);
}

/** Tests and test helpers whose imports are all in the export (the rest test Pro, and stay private). */
function testsThatStay(out) {
  const all = listFiles(path.join(out, 'tests')).map((f) => `tests/${f}`);
  const there = (f) => fs.existsSync(path.join(out, f));
  const keep = new Set();
  let changed = true;
  // (A helper stays only while a test that stays uses it; a test stays only while all it imports is there.)
  const ok = new Map(all.map((f) => [f, true]));
  while (changed) {
    changed = false;
    for (const f of all) {
      if (!ok.get(f) || !/\.m?js$/.test(f)) continue;
      const code = fs.readFileSync(path.join(out, f), 'utf8');
      if (importsOfFile(f, code).some((t) => !there(t) || ok.get(t) === false)) { ok.set(f, false); changed = true; }
    }
  }
  for (const f of all) if (ok.get(f) && /\.test\.m?js$/.test(f)) keep.add(f);
  // Helpers and fixtures: only those a kept test (or a kept helper) names.
  const named = new Set();
  const take = (f) => {
    if (named.has(f)) return;
    named.add(f);
    if (/\.m?js$/.test(f)) for (const t of importsOfFile(f, fs.readFileSync(path.join(out, f), 'utf8'))) if (t.startsWith('tests/')) take(t);
  };
  for (const f of keep) take(f);
  const keptText = [...named].map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
  for (const f of all) if (!/\.m?js$/.test(f) && keptText.includes(path.posix.basename(f))) named.add(f);
  return { keep: named, drop: all.filter((f) => !named.has(f)) };
}

export function exportPublic({ out = OUT, runTests = false } = {}) {
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(out, { recursive: true });
  const problems = [];
  const left = { never: [], pro: [], unused: [], tests: [] };
  const blocks = {};
  const removed = {};
  for (const f of committedFiles()) {
    if (NEVER.test(f)) { left.never.push(f); continue; }
    if (PRO_FILES.some((re) => re.test(f))) { left.pro.push(f); continue; }
    const to = path.join(out, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const data = committed(f);
    if (TEXT.test(f)) {
      const text = data.toString('utf8');
      // (The markers' own tool and its tests are about the markers: their examples are text, copied as they are.)
      const n = AS_IS.has(f) ? 0 : countBlocks(text, f, 'pro');
      let kept = text;
      if (n) {
        kept = stripEdition(text, f, 'pro');
        blocks[f] = n;
        const still = new Set([...declaredNames(kept, { indented: true }), ...importedNames(kept)]);
        removed[f] = new Set([...declaredIn(text, f, 'pro')].filter((x) => !still.has(x)));
      }
      fs.writeFileSync(to, kept);
    } else fs.writeFileSync(to, data);
  }
  // The public licence and README, and package.json saying so.
  fs.copyFileSync(path.join(ROOT, 'scripts', 'public', 'LICENSE'), path.join(out, 'LICENSE'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'public', 'README.md'), path.join(out, 'README.md'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'public', 'CONTRIBUTING.md'), path.join(out, 'CONTRIBUTING.md'));
  // The free downloader's own name and description in the manifest, and no shortcut to the desk (scripts/public/manifest.patch.json).
  const mPath = path.join(out, 'extension', 'manifest.json');
  const mText = fs.readFileSync(mPath, 'utf8');
  const patched = mergePatch(JSON.parse(mText), JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'public', 'manifest.patch.json'), 'utf8')));
  fs.writeFileSync(mPath, `${JSON.stringify(patched, null, 2)}${mText.endsWith('\n') ? '\n' : ''}`);
  fs.rmSync(path.join(out, 'scripts', 'public'), { recursive: true, force: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  pkg.license = 'GPL-3.0-only';
  pkg.description = 'StreamSnag: a free, open-source video downloader for Chrome, Edge and Brave';
  pkg.homepage = 'https://streamsnag.app';
  // (The dev dependencies stay as they are, so package-lock.json still matches and CI's "npm ci" works.)
  if (pkg.scripts?.build) pkg.scripts.build = 'node scripts/build-sdk.js && node scripts/make-icons.js';
  for (const k of Object.keys(pkg.scripts || {})) if (/^e2e/.test(k)) delete pkg.scripts[k]; // (the browser checks stay private)
  fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  // extension/lib files nothing uses any more.
  for (const f of unreached(out)) { fs.rmSync(path.join(out, f)); left.unused.push(f); }
  // Tests of what is not there.
  const t = testsThatStay(out);
  for (const f of t.drop) { fs.rmSync(path.join(out, f)); left.tests.push(f); }

  // The checks.
  for (const p of checkScripts(path.join(out, 'extension'), Object.fromEntries(Object.entries(removed).filter(([f]) => f.startsWith('extension/')).map(([f, s]) => [f.slice('extension/'.length), s])))) problems.push(`extension/${p}`);
  // The helper too: every module parses and imports what is there.
  for (const p of checkScripts(path.join(out, 'native-host'), Object.fromEntries(Object.entries(removed).filter(([f]) => f.startsWith('native-host/')).map(([f, s]) => [f.slice('native-host/'.length), s])))) problems.push(`native-host/${p}`);
  for (const [f, names] of Object.entries(removed)) {
    if (f.startsWith('extension/') || f.startsWith('native-host/') || !names.size || !/\.m?js$/.test(f) || !fs.existsSync(path.join(out, f))) continue;
    const body = fs.readFileSync(path.join(out, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    // (Not a property's name, as in "{ madeKeys: … }".)
    for (const n of names) if (new RegExp(`(?<![\\w$.'"])${n.replace(/\$/g, '\\$')}(?![\\w$]|\\s*:(?!:))`).test(body)) problems.push(`${f}: still uses "${n}", which only a removed block declared or imported`);
  }
  for (const f of listFiles(out)) {
    if (!TEXT.test(f)) continue;
    const text = fs.readFileSync(path.join(out, f), 'utf8');
    const pro = PRO_NAMES.exec(text);
    if (pro && f !== 'scripts/export-public.mjs') problems.push(`${f}: names a Pro file ("${pro[0].trim()}")`);
    // (The tests' own stand-in, "sk-ant-e2e-not-a-real-key", says what it is.)
    if (SECRET.test(text.replace(/sk-[\w-]*not-a-real-key/g, ''))) problems.push(`${f}: looks like it holds a secret`);
    if (EMAIL.test(text)) problems.push(`${f}: has a personal email address`);
    if (/@end-pro\b|\/\/ @pro\b|\/\* @pro \*\//.test(text) && f !== 'scripts/export-public.mjs' && f !== 'scripts/edition-strip.mjs' && !/^tests\/edition-strip/.test(f)) problems.push(`${f}: a Pro marker was left behind`);
  }
  for (const f of listFiles(out)) if (NEVER.test(f) || PRO_FILES.some((re) => re.test(f))) problems.push(`${f}: must not be public`);

  let tests = null;
  if (runTests && !problems.length) {
    // (Node reads the export's files as modules through its own package.json; node_modules from the repo.)
    const link = path.join(out, 'node_modules');
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(ROOT, 'node_modules'), link, 'junction');
    const r = spawnSync(process.execPath, ['--test', 'tests/*.test.js'], { cwd: out, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const out2 = `${r.stdout}${r.stderr}`;
    tests = { code: r.status, pass: Number(/# pass (\d+)/.exec(out2)?.[1] || 0), fail: Number(/# fail (\d+)/.exec(out2)?.[1] || 0), failed: [...out2.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]) };
    fs.rmSync(link, { force: true, recursive: false });
    if (tests.fail || tests.code) problems.push(`the unit tests in the export: ${tests.fail} failed (${tests.failed.slice(0, 5).join('; ')})`);
  }
  return { problems, left, blocks, tests };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = exportPublic({ runTests: process.argv.includes('--test') });
  console.log(`left out: ${r.left.never.length} never public, ${r.left.pro.length} Pro files, ${r.left.unused.length} unused (${r.left.unused.join(', ') || 'none'}), ${r.left.tests.length} tests and test files of Pro`);
  const total = Object.values(r.blocks).reduce((a, b) => a + b, 0);
  console.log(`${total} @pro blocks taken out of ${Object.keys(r.blocks).length} files`);
  for (const [f, n] of Object.entries(r.blocks)) console.log(`      ${String(n).padStart(3)}  ${f}`);
  if (r.tests) console.log(`unit tests in the export: ${r.tests.pass} pass, ${r.tests.fail} fail${r.tests.failed.length ? `\n      ${r.tests.failed.slice(0, 40).join('\n      ')}` : ''}`);
  if (r.problems.length) {
    console.error(`FAIL  ${r.problems.length} problems`);
    for (const p of r.problems.slice(0, 120)) console.error(`      ${p}`);
    process.exit(1);
  }
  console.log(`PASS  dist/public: ${listFiles(OUT).length} files, nothing of Pro, every import there`);
}

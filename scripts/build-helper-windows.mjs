// The helper package for Windows computers that have nothing installed: dist/streamsnag-helper-windows-<v>.zip
//
//   StreamSnag helper/
//     Set up StreamSnag helper.cmd     double-click: copies the helper into the user's folder, offers ffmpeg,
//     Remove StreamSnag helper.cmd     registers it with the browsers, adds it to Installed apps (setup.ps1)
//     README.txt
//     files/   the store helper (scripts/build-release.mjs buildHelper), setup.ps1, and the official node.exe
//              with its licence
//
// node.exe is the version pinned in scripts/helper.store.json, downloaded once into dist/cache/ and checked
// against the pinned sha256 (and, on Windows, its signature: valid, signed by the OpenJS Foundation).
//
// Usage:  node scripts/build-helper-windows.mjs           the store edition's package
//         node scripts/build-helper-windows.mjs --site    the website edition's: the full helper (yt-dlp offered
//                                                         too), its extension id in files/id.txt
//         (STREAMSNAG_NODE_EXE=<a node.exe> uses that file instead, unchecked: for the tests, never for a release)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHelper, checkScripts, searchForbidden, makeZip, listFiles, HELPER_FILES } from './build-release.mjs';
import { extensionIdFromKey } from '../native-host/install.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const CONFIG = path.join(ROOT, 'scripts', 'helper.store.json');
const WINDOWS = path.join(ROOT, 'native-host', 'windows');
export const TOP = 'StreamSnag helper';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'streamsnag-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** A pinned file: from dist/cache/ when it is there and right, else downloaded and checked. */
async function pinned(name, url, want) {
  const cache = path.join(DIST, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, name);
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === want) return file;
  const buf = await download(url);
  const got = sha256(buf);
  if (got !== want) throw new Error(`${url}: sha256 ${got}, not the pinned ${want}`);
  fs.writeFileSync(file, buf);
  return file;
}

/** On Windows: the file's Authenticode signature is valid and the OpenJS Foundation's. */
export function checkSignature(file) {
  if (process.platform !== 'win32') return 'not checked (not on Windows)';
  const ps = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
  const [status, subject] = out.split('|');
  if (status !== 'Valid' || !/OpenJS Foundation/i.test(subject)) throw new Error(`node.exe's signature: ${out}`);
  return subject.match(/CN="?([^,"]+)/)?.[1] || subject;
}

const README = (version, id, site = false) => `StreamSnag helper ${version} for Windows

The small program StreamSnag uses on your computer to save into any folder, join a video's picture and
sound into one MP4, convert files, turn a lecture's speech into text, and run your own AI subscription.
It brings everything it needs with it (including its own copy of Node.js), and needs no admin rights.${site ? `
Setup also offers ffmpeg and yt-dlp (both free): one finished MP4, playlists, and more sites.` : ''}

To set it up: double-click "Set up StreamSnag helper.cmd". Then restart your browser, and in StreamSnag
open Settings > Local helper and press Check helper.${id ? '' : `

(If it asks for an ID: StreamSnag shows it in Settings > Local helper.)`}

To remove it: Windows Settings > Apps > Installed apps > StreamSnag helper, or double-click
"Remove StreamSnag helper.cmd".

files\\NODE-LICENSE.txt is the licence of Node.js, which this package includes unchanged.
`;

/**
 * Builds the package folder into `out`/StreamSnag helper and, unless `zip` is false, the zip beside it.
 * Returns { folder, zipPath, files, bytes, signer, id }. Throws when a check fails.
 */
export async function buildWindowsHelper({ edition = 'store', out = path.join(DIST, edition === 'site' ? 'helper-windows-site' : 'helper-windows'), zip = true, nodeExe = process.env.STREAMSNAG_NODE_EXE, config = CONFIG } = {}) {
  const site = edition === 'site';
  const cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
  const { version: nodeVersion, sha256: nodeSha, licenseSha256 } = cfg.node || {};
  if (!nodeExe && !(nodeVersion && nodeSha && licenseSha256)) throw new Error(`${config}: no pinned node (version, sha256, licenseSha256)`);
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 3 });
  const folder = path.join(out, TOP);
  const files = path.join(folder, 'files');
  let built;
  if (site) {
    // The website edition: native-host/ as it is (yt-dlp included), and the id its manifest "key" gives it.
    fs.mkdirSync(files, { recursive: true });
    for (const f of HELPER_FILES) fs.copyFileSync(path.join(ROOT, 'native-host', f), path.join(files, f));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
    const id = extensionIdFromKey(manifest.key);
    fs.writeFileSync(path.join(files, 'id.txt'), `${id}\n`);
    fs.writeFileSync(path.join(files, 'package.json'), `${JSON.stringify({ name: 'streamsnag-helper', version: manifest.version, private: true, type: 'module' }, null, 2)}\n`);
    fs.copyFileSync(path.join(WINDOWS, 'extras-site.ps1'), path.join(files, 'extras.ps1'));
    const problems = checkScripts(files, {});
    if (problems.length) throw new Error(`the helper has problems:\n  ${problems.join('\n  ')}`);
    built = { id };
  } else {
    built = buildHelper(files, undefined, config);
    const problems = [...searchForbidden(files).map((h) => `forbidden: ${h}`), ...checkScripts(files, built.removed)];
    if (problems.length) throw new Error(`the store helper has problems:\n  ${problems.join('\n  ')}`);
    fs.rmSync(path.join(files, 'README.txt')); // (the package has its own, one folder up)
  }
  fs.copyFileSync(path.join(WINDOWS, 'setup.ps1'), path.join(files, 'setup.ps1'));
  for (const f of ['Set up StreamSnag helper.cmd', 'Remove StreamSnag helper.cmd']) fs.copyFileSync(path.join(WINDOWS, f), path.join(folder, f));
  const version = JSON.parse(fs.readFileSync(path.join(files, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(folder, 'README.txt'), README(version, built.id, site).replace(/\n/g, '\r\n'));
  // (Everything of ours is searched; node.exe is Node's own, checked by its hash and signature instead.)
  const ours = site ? [] : searchForbidden(folder);
  if (ours.length) throw new Error(`the package has words it must not:\n  ${ours.join('\n  ')}`);

  let signer = 'not checked (a test copy)';
  if (nodeExe) {
    fs.copyFileSync(nodeExe, path.join(files, 'node.exe'));
    fs.writeFileSync(path.join(files, 'NODE-LICENSE.txt'), 'A test copy of node.exe.\n');
  } else {
    const exe = await pinned(`node-v${nodeVersion}-win-x64.exe`, `https://nodejs.org/dist/v${nodeVersion}/win-x64/node.exe`, nodeSha);
    const lic = await pinned(`node-v${nodeVersion}-LICENSE`, `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`, licenseSha256);
    signer = checkSignature(exe);
    fs.copyFileSync(exe, path.join(files, 'node.exe'));
    fs.copyFileSync(lic, path.join(files, 'NODE-LICENSE.txt'));
  }
  let zipPath = '';
  let bytes = 0;
  if (zip) {
    zipPath = path.join(out, '..', `streamsnag-${site ? 'website-' : ''}helper-windows-${version}.zip`);
    const entries = listFiles(folder).map((name) => ({ name: `${TOP}/${name}`, data: fs.readFileSync(path.join(folder, name)) }));
    const z = makeZip(entries);
    fs.writeFileSync(zipPath, z);
    bytes = z.length;
  }
  return { folder, zipPath, files: listFiles(folder), bytes, signer, id: built.id, nodeVersion: nodeExe ? 'test copy' : nodeVersion };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const edition = process.argv.includes('--site') ? 'site' : 'store';
    const r = await buildWindowsHelper({ edition });
    console.log(`Windows helper package (${edition === 'site' ? 'website' : 'store'} edition): Node.js ${r.nodeVersion}, signed by ${r.signer}`);
    if (edition === 'site') console.log(`      for the extension ${r.id}`);
    for (const f of r.files) console.log(`      ${f}`);
    if (r.zipPath) console.log(`      ${path.relative(ROOT, r.zipPath).split(path.sep).join('/')}: ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
    if (!r.id) console.warn('note: no extension id in scripts/helper.store.json yet; setup will ask for it');
  } catch (e) {
    console.error(`FAIL  ${e.message}`);
    process.exit(1);
  }
}

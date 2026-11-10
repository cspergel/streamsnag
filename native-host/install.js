#!/usr/bin/env node
// Registers the StreamSnag local helper with Chrome (and Edge/Brave/Chromium) for the current user.
//   node native-host/install.js            install
//   node native-host/install.js --uninstall
//   node native-host/install.js --id <extension-id>   (only if you changed the manifest "key")
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.streamsnag.helper';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');

/** Chrome derives an unpacked extension's ID from the manifest "key": sha256(DER) -> first 32 hex -> a-p. */
export function extensionIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function extensionId() {
  const i = args.indexOf('--id');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  if (!manifest.key) throw new Error('manifest.json has no "key"; pass --id <extension id> from chrome://extensions');
  return extensionIdFromKey(manifest.key);
}

function writeLauncher() {
  const node = process.execPath;
  const hostJs = path.join(here, 'host.js');
  if (process.platform === 'win32') {
    const bat = path.join(here, 'host.bat');
    fs.writeFileSync(bat, `@echo off\r\n"${node}" "${hostJs}" %*\r\n`);
    return bat;
  }
  const sh = path.join(here, 'host.sh');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${node}" "${hostJs}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

function writeManifest(launcher, id) {
  const manifest = {
    name: HOST_NAME,
    description: 'StreamSnag local helper (Claude CLI, ffmpeg, yt-dlp)',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  };
  const file = path.join(here, `${HOST_NAME}.json`);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

const WIN_KEYS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
];

function unixDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Chromium'].map((b) => path.join(base, b, 'NativeMessagingHosts'));
  }
  const base = path.join(home, '.config');
  return ['google-chrome', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'chromium'].map((b) => path.join(base, b, 'NativeMessagingHosts'));
}

function main() {
  if (process.platform === 'win32') {
    for (const k of WIN_KEYS) {
      const key = `${k}\\${HOST_NAME}`;
      try {
        if (uninstall) execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
      } catch { /* not present */ }
    }
  } else if (uninstall) {
    for (const d of unixDirs()) fs.rmSync(path.join(d, `${HOST_NAME}.json`), { force: true });
  }
  if (uninstall) {
    console.log('StreamSnag helper unregistered.');
    return;
  }

  const id = extensionId();
  const launcher = writeLauncher();
  const manifestFile = writeManifest(launcher, id);
  if (process.platform === 'win32') {
    for (const k of WIN_KEYS) {
      execFileSync('reg', ['add', `${k}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestFile, '/f'], { stdio: 'ignore' });
    }
  } else {
    for (const d of unixDirs()) {
      if (!fs.existsSync(path.dirname(d))) continue; // browser not installed
      fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(manifestFile, path.join(d, `${HOST_NAME}.json`));
    }
  }
  console.log(`StreamSnag helper registered for extension ${id}`);
  console.log(`  manifest: ${manifestFile}`);
  console.log(`  launcher: ${launcher}`);
  console.log('Restart Chrome, then use Settings -> Local helper -> "Check helper".');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  try {
    main();
  } catch (e) {
    console.error(`Install failed: ${e.message}`);
    process.exit(1);
  }
}

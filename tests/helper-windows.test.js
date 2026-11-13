// The Windows helper package (scripts/build-helper-windows.mjs), set up and removed for real by its own
// setup.ps1: copied into a folder of the test's own, registered under a registry key of the test's own
// (STREAMSNAG_TEST_HOME, STREAMSNAG_TEST_REG_ROOT), so the browsers' real registration is never touched,
// which the test checks too. The helper it installs is then started the way the browser starts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { buildWindowsHelper, TOP } from '../scripts/build-helper-windows.mjs';
import { readZip } from '../scripts/build-release.mjs';
import { encodeMessage, createDecoder } from '../native-host/protocol.js';

const skip = process.platform !== 'win32' && 'Windows only';
const ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const ROOT_KEY = `StreamSnagTest-${process.pid}`;
const HOST = 'com.streamsnag.helper';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'streamsnag-winhelper-'));
const home = path.join(work, 'home');
test.after(() => {
  spawnSync('reg', ['delete', `HKCU\\Software\\${ROOT_KEY}`, '/f'], { stdio: 'ignore' });
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
});

/** The default value of a registry key, or '' when it is not there. */
function regDefault(key) {
  const r = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8' });
  if (r.status !== 0) return '';
  return (/REG_SZ\s+(.*)$/m.exec(r.stdout)?.[1] || '').trim();
}
const regValue = (key, name) => {
  const r = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8' });
  return r.status === 0 ? (new RegExp(`${name}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(r.stdout)?.[1] || '').trim() : '';
};
const REAL_KEYS = ['Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser', 'Chromium'].map((b) => `HKCU\\Software\\${b}\\NativeMessagingHosts\\${HOST}`);

function setup(folder, args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(folder, 'files', 'setup.ps1'), ...args], {
    encoding: 'utf8', env: { ...process.env, STREAMSNAG_TEST_HOME: home, STREAMSNAG_TEST_REG_ROOT: ROOT_KEY }, timeout: 120000,
  });
}

/** One ping through the launcher the host manifest names, started as the browser starts it (cmd /c). */
function pingThrough(launcher) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/c', launcher], { stdio: ['pipe', 'pipe', 'ignore'] });
    const t = setTimeout(() => { child.kill(); reject(new Error('the installed helper did not answer')); }, 30000);
    let answer = null;
    child.stdout.on('data', createDecoder((m) => { answer = m; child.stdin.end(); }));
    child.on('close', () => { clearTimeout(t); resolve(answer); });
    child.stdin.write(encodeMessage({ id: 7, type: 'ping' }));
  });
}

test('the Windows helper package: its files and its zip', { skip }, async () => {
  const r = await buildWindowsHelper({ out: path.join(work, 'pkg'), nodeExe: process.execPath, config: writeConfig(ID) });
  assert.deepEqual(r.files, ['README.txt', 'Remove StreamSnag helper.cmd', 'Set up StreamSnag helper.cmd', 'files/NODE-LICENSE.txt', 'files/host.js',
    'files/install.js', 'files/node.exe', 'files/package.json', 'files/protocol.js', 'files/setup.ps1', ]);
  const names = readZip(fs.readFileSync(r.zipPath)).map((e) => e.name);
  assert.deepEqual(names, r.files.map((f) => `${TOP}/${f}`));
  assert.match(fs.readFileSync(path.join(r.folder, 'files', 'install.js'), 'utf8'), new RegExp(`STORE_EXTENSION_ID = '${ID}'`));
});

let pkg;
function writeConfig(id) {
  const real = JSON.parse(fs.readFileSync(new URL('../scripts/helper.store.json', import.meta.url), 'utf8'));
  const file = path.join(work, `config-${id.length}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...real, extensionId: id }));
  return file;
}

test('set up for real: copied into its folder, registered, in Installed apps, the browsers\' own keys untouched, and it answers', { skip }, async () => {
  const before = REAL_KEYS.map(regDefault);
  pkg = await buildWindowsHelper({ out: path.join(work, 'pkg2'), zip: false, nodeExe: process.execPath, config: writeConfig(ID) });
  const r = setup(pkg.folder, ['-SkipFfmpeg']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dest = path.join(home, '1.6.0');
  for (const f of ['node.exe', 'host.js', 'install.js', 'setup.ps1', 'host.bat', `${HOST}.json`]) assert.ok(fs.existsSync(path.join(dest, f)), f);
  // The launcher runs the helper's own node.exe from its own folder (not the Node that ran the test, not the zip's folder).
  const bat = fs.readFileSync(path.join(dest, 'host.bat'), 'utf8');
  assert.ok(bat.includes(`"${path.join(dest, 'node.exe')}" "${path.join(dest, 'host.js')}"`), bat);
  const manifestFile = path.join(dest, `${HOST}.json`);
  assert.equal(regDefault(`HKCU\\Software\\${ROOT_KEY}\\NativeMessagingHosts\\${HOST}`), manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
  assert.equal(manifest.path, path.join(dest, 'host.bat'));
  const app = `HKCU\\Software\\${ROOT_KEY}\\Uninstall\\StreamSnagHelper`;
  assert.equal(regValue(app, 'DisplayName'), 'StreamSnag helper');
  assert.equal(regValue(app, 'DisplayVersion'), '1.6.0');
  assert.match(regValue(app, 'UninstallString'), /setup\.ps1" -Uninstall$/);
  assert.deepEqual(REAL_KEYS.map(regDefault), before, 'the browsers\' own registration is as it was');
  const pong = await pingThrough(manifest.path);
  assert.equal(pong?.type, 'result');
  assert.equal(pong.version, '1.6.0');
  assert.deepEqual(Object.keys(pong.tools).sort(), ['claude', 'codex', 'ffmpeg']);
});

test('set up again over itself, then a newer version replaces the older folder', { skip }, async () => {
  assert.ok(pkg, 'the set-up test ran first');
  assert.equal(setup(pkg.folder, ['-SkipFfmpeg']).status, 0, 'the same version again');
  const old = path.join(home, '0.9.0');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'host.js'), '');
  const r = setup(pkg.folder, ['-SkipFfmpeg']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(old), 'an older copy is removed');
  assert.ok(fs.existsSync(path.join(home, '1.6.0', 'host.js')));
});

test('removed: the registration, the Installed apps entry and the folder are gone', { skip }, async () => {
  assert.ok(pkg, 'the set-up test ran first');
  const before = REAL_KEYS.map(regDefault);
  // (Removed by the installed copy, the way Installed apps runs it.)
  const un = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(home, '1.6.0', 'setup.ps1'), '-Uninstall'], {
    encoding: 'utf8', env: { ...process.env, STREAMSNAG_TEST_HOME: home, STREAMSNAG_TEST_REG_ROOT: ROOT_KEY }, timeout: 120000,
  });
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.equal(regDefault(`HKCU\\Software\\${ROOT_KEY}\\NativeMessagingHosts\\${HOST}`), '');
  assert.equal(regValue(`HKCU\\Software\\${ROOT_KEY}\\Uninstall\\StreamSnagHelper`, 'DisplayName'), '');
  assert.ok(!fs.existsSync(home), 'the helper\'s folder is gone');
  assert.deepEqual(REAL_KEYS.map(regDefault), before);
});

/** setup.ps1 -Uninstall run by the installed copy, without blocking (so the test can let go of a file meanwhile). */
function uninstallLater() {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(home, '1.6.0', 'setup.ps1'), '-Uninstall'], {
      env: { ...process.env, STREAMSNAG_TEST_HOME: home, STREAMSNAG_TEST_REG_ROOT: ROOT_KEY }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
  });
}
/** The installed node.exe kept running, which holds its file the way a busy helper does. */
const holdNode = () => spawn(path.join(home, '1.6.0', 'node.exe'), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const exited = (child) => new Promise((r) => { if (child.exitCode !== null || child.signalCode) r(); else child.once('exit', r); });

test('removing waits a few seconds for a file held a moment longer, and says so when one stays held', { skip }, async () => {
  assert.ok(pkg, 'the set-up test ran first');
  // Held for 1.5 s after removing starts: removed all the same.
  assert.equal(setup(pkg.folder, ['-SkipFfmpeg']).status, 0);
  const brief = holdNode();
  const done = uninstallLater();
  setTimeout(() => brief.kill(), 1500);
  const r = await done;
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(home), 'the helper\'s folder is gone');
  // Held throughout: unregistered and it says why, but nothing else is removed, so it can be removed again
  // from Installed apps once the helper has stopped.
  assert.equal(setup(pkg.folder, ['-SkipFfmpeg']).status, 0);
  const app = `HKCU\\Software\\${ROOT_KEY}\\Uninstall\\StreamSnagHelper`;
  const held = holdNode();
  try {
    const stuck = await uninstallLater();
    assert.equal(stuck.status, 1, stuck.out);
    assert.match(stuck.out, /still running/);
    assert.equal(regDefault(`HKCU\\Software\\${ROOT_KEY}\\NativeMessagingHosts\\${HOST}`), '');
    assert.equal(regValue(app, 'DisplayName'), 'StreamSnag helper', 'still in Installed apps');
    for (const f of ['node.exe', 'setup.ps1', 'install.js']) assert.ok(fs.existsSync(path.join(home, '1.6.0', f)), f);
  } finally { held.kill(); }
  await exited(held);
  const again = await uninstallLater();
  assert.equal(again.status, 0, again.out);
  assert.ok(!fs.existsSync(home));
  assert.equal(regValue(app, 'DisplayName'), '');
});

test('without an extension id, setup asks for one and, with no one to answer, stops before registering anything', { skip }, async () => {
  const bare = await buildWindowsHelper({ out: path.join(work, 'pkg3'), zip: false, nodeExe: process.execPath, config: writeConfig('') });
  const r = setup(bare.folder, ['-SkipFfmpeg']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /No extension id/);
  assert.equal(regDefault(`HKCU\\Software\\${ROOT_KEY}\\NativeMessagingHosts\\${HOST}`), '');
  assert.ok(!fs.existsSync(path.join(home, '1.6.0', `${HOST}.json`)));
  // Given with -Id, the same copy registers.
  const ok = setup(bare.folder, ['-SkipFfmpeg', '-Id', ID]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(regDefault(`HKCU\\Software\\${ROOT_KEY}\\NativeMessagingHosts\\${HOST}`));
  execFileSync('reg', ['delete', `HKCU\\Software\\${ROOT_KEY}`, '/f'], { stdio: 'ignore' });
});

test('the website edition\'s package: the full helper, registered for the extension its manifest names without asking, yt-dlp offered', { skip }, async () => {
  const site = await buildWindowsHelper({ edition: 'site', out: path.join(work, 'pkg-site'), zip: false, nodeExe: process.execPath, config: writeConfig('') });
  const manifestKeyId = fs.readFileSync(path.join(site.folder, 'files', 'id.txt'), 'utf8').trim();
  assert.match(manifestKeyId, /^[a-p]{32}$/);
  assert.ok(fs.readFileSync(path.join(site.folder, 'files', 'host.js'), 'utf8').includes('handleYtdlp'), 'the full helper');
  assert.ok(fs.existsSync(path.join(site.folder, 'files', 'extras.ps1')));
  const r = setup(site.folder, ['-SkipFfmpeg']); // no -Id: id.txt gives it
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /yt-dlp (found|\. You can install it later)|Skipped yt-dlp/);
  const manifest = JSON.parse(fs.readFileSync(path.join(home, '1.6.0', `${HOST}.json`), 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${manifestKeyId}/`]);
  const pong = await pingThrough(manifest.path);
  assert.ok('ytdlp' in pong.tools, 'the installed helper has the other downloader');
  execFileSync('reg', ['delete', `HKCU\\Software\\${ROOT_KEY}`, '/f'], { stdio: 'ignore' });
});

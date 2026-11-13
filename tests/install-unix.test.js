// node install.js --uninstall on macOS and Linux: the browsers' registrations and the helper's own data go,
// and nothing beside them. (A home folder of the test's own: the real one is never touched. Windows has
// setup.ps1 for this: tests/helper-windows.test.js.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INSTALL = fileURLToPath(new URL('../native-host/install.js', import.meta.url));
const skip = process.platform === 'win32' ? 'macOS and Linux only' : false;

test('install.js --uninstall removes the registrations and the helper\'s data, and nothing else', { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-unix-home-'));
  try {
    const nmh = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts') : path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts');
    fs.mkdirSync(nmh, { recursive: true });
    fs.writeFileSync(path.join(nmh, 'com.streamsnag.helper.json'), '{}');
    fs.writeFileSync(path.join(nmh, 'com.other.helper.json'), '{}');
    const data = path.join(home, 'data', 'StreamSnag');
    for (const f of ['stt/model-small/model.bin', 'covers/0a1b2c.jpg', 'sources.json']) {
      fs.mkdirSync(path.dirname(path.join(data, f)), { recursive: true });
      fs.writeFileSync(path.join(data, f), 'x');
    }
    fs.writeFileSync(path.join(home, 'data', 'not-the-helpers.txt'), 'x');
    // Run from a linked folder (as on macOS, where /var/… is /private/var/…): it still runs, and says so.
    const linked = path.join(home, 'linked-helper');
    fs.symlinkSync(path.dirname(INSTALL), linked);
    const r = spawnSync(process.execPath, [path.join(linked, 'install.js'), '--uninstall'], { encoding: 'utf8', env: { ...process.env, HOME: home, STREAMSNAG_TEST_DATA: data } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /unregistered/);
    assert.ok(!fs.existsSync(path.join(nmh, 'com.streamsnag.helper.json')), 'its registration is gone');
    assert.ok(fs.existsSync(path.join(nmh, 'com.other.helper.json')), 'another program\'s stays');
    assert.ok(!fs.existsSync(data), 'its data folder is gone');
    assert.ok(fs.existsSync(path.join(home, 'data', 'not-the-helpers.txt')), 'and nothing beside it');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

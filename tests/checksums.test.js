// SHA256SUMS.txt: what is written is what sha256sum would say, and a changed file no longer matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sumsText, readSums, checkAgainst, sha256Of } from '../scripts/checksums.mjs';

test('the list names each file once with its real SHA-256, in the format sha256sum -c reads, and catches a changed byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sums-'));
  try {
    const a = path.join(dir, 'streamsnag-helper.zip');
    const b = path.join(dir, 'streamsnag-helper-windows.zip');
    fs.writeFileSync(a, 'abc'); // SHA-256 of "abc" is a published test vector
    fs.writeFileSync(b, Buffer.alloc(1024, 7));
    const text = sumsText([b, a]);
    assert.ok(text.split('\n').includes('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  streamsnag-helper.zip'), text);
    assert.match(text, /^[0-9a-f]{64} {2}streamsnag-helper-windows\.zip$/m);
    assert.equal(text.trim().split('\n').length, 2);
    assert.equal(readSums(text).get('streamsnag-helper-windows.zip'), sha256Of(b));
    assert.equal(checkAgainst(text, a).ok, true);
    // One byte changed: it no longer matches, and the list says what it expected.
    fs.writeFileSync(a, 'abd');
    const after = checkAgainst(text, a);
    assert.equal(after.ok, false);
    assert.equal(after.want, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // A file the list does not name is not "fine".
    assert.equal(checkAgainst(text, a, 'other.zip').ok, false);
    // Two files of one name cannot both be listed; a line that is not a checksum is refused.
    fs.mkdirSync(path.join(dir, 'x'));
    fs.writeFileSync(path.join(dir, 'x', 'streamsnag-helper.zip'), 'z');
    assert.throws(() => sumsText([a, path.join(dir, 'x', 'streamsnag-helper.zip')]), /both named/);
    assert.throws(() => readSums('not a checksum line'), /Not a checksum line/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// SHA256SUMS.txt for a release: one line per file, "<sha256>  <name>", the format `sha256sum -c` and
// `shasum -a 256 -c` read. It goes up beside the files on each GitHub release (the helper's, the testers'
// preview), so anyone can check that what they downloaded is what was published; /helper/ says how.
//
//   node scripts/checksums.mjs <out SHA256SUMS.txt> <file> [<file> …]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** The SHA-256 of a file, as lowercase hex. */
export const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The text of SHA256SUMS.txt for these files, named by their base names, sorted. */
export function sumsText(files) {
  const names = files.map((f) => path.basename(f));
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`Two files are both named ${dup}: a checksum list names each file once.`);
  return files.map((f) => [path.basename(f), sha256Of(f)]).sort(([a], [b]) => a.localeCompare(b)).map(([n, h]) => `${h}  ${n}\n`).join('');
}

/** SHA256SUMS.txt read back: Map name → hash. Lines that are not "<64 hex>  <name>" are refused. */
export function readSums(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (!m) throw new Error(`Not a checksum line: ${line.slice(0, 80)}`);
    out.set(m[2], m[1]);
  }
  return out;
}

/** Does this file match its line in the list? { ok, want, got } (want '' when the list does not name it). */
export function checkAgainst(text, file, name = path.basename(file)) {
  const want = readSums(text).get(name) || '';
  const got = sha256Of(file);
  return { ok: !!want && want === got, want, got };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out, ...files] = process.argv.slice(2);
  if (!out || !files.length) {
    console.error('Usage: node scripts/checksums.mjs <out SHA256SUMS.txt> <file> [<file> …]');
    process.exit(2);
  }
  const text = sumsText(files);
  fs.writeFileSync(out, text);
  process.stdout.write(text);
}

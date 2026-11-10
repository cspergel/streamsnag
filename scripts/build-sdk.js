// Bundles the official Anthropic TypeScript SDK into a single ES module the extension can import
// (MV3 service workers cannot load npm packages directly).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: [path.join(root, 'scripts', 'sdk-entry.js')],
  outfile: path.join(root, 'extension', 'vendor', 'anthropic-sdk.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  minify: true,
  legalComments: 'eof',
  logLevel: 'info',
});

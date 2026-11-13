// The store edition's strip (scripts/edition-strip.mjs): marked blocks go, everything else stays exactly
// as it was, and a marker that is unbalanced, nested or misspelt stops the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripEdition, findBlocks, declaredIn, countBlocks, FORBIDDEN, NO_OTHER_EDITION } from '../scripts/edition-strip.mjs';

const O = '// @site-edition';
const A = '// @store-edition';
const C = '// @end-site-edition';

test('a block of whole lines goes with its markers, and leaves no blank line behind', () => {
  const src = `const a = 1;\n${O}\nconst b = 2;\nfunction f() { return b; }\n${C}\nconst c = 3;\n`;
  assert.equal(stripEdition(src), 'const a = 1;\nconst c = 3;\n');
  // Indented markers, inside a function.
  const inner = `function g(x) {\n  if (x) return 1;\n  ${O}\n  if (!x) return 2;\n  ${C}\n  return 3;\n}\n`;
  assert.equal(stripEdition(inner), 'function g(x) {\n  if (x) return 1;\n  return 3;\n}\n');
  // At the very end of a file without a final line break.
  assert.equal(stripEdition(`a();\n${O}\nb();\n${C}`), 'a();\n');
});

test('nothing outside a block changes, byte for byte (spacing, line breaks, other comments)', () => {
  const before = 'const x = "  two  spaces  ";\r\n\t// a comment about the site\n/* @not-a-marker */\n\n\n';
  const after = 'let y = `\n  kept\n`;   // trailing\n';
  const src = `${before}${O}\nremoved();\n${C}\n${after}`;
  assert.equal(stripEdition(src), before + after);
  // A file without markers comes back as it is.
  assert.equal(stripEdition(before + after), before + after);
  // And the strip is done once: the result has no markers, so stripping again changes nothing.
  assert.equal(stripEdition(stripEdition(src)), before + after);
});

test('several blocks in one file, each taken out, what is between them kept', () => {
  const src = `one\n${O}\nx\n${C}\ntwo\n${O}\ny\nz\n${C}\nthree\n`;
  assert.equal(stripEdition(src), 'one\ntwo\nthree\n');
  assert.equal(countBlocks(src), 2);
});

test('inside a line, /* */ markers take just the words between them (and one space, so none is doubled)', () => {
  assert.equal(stripEdition("const K = ['hls', 'dash', /* @site-edition */ 'extra', /* @end-site-edition */ 'doc'];\n"), "const K = ['hls', 'dash', 'doc'];\n");
  assert.equal(stripEdition('import { a, /* @site-edition */ b, c /* @end-site-edition */ } from "./x.js";'), 'import { a, } from "./x.js";');
  assert.equal(stripEdition('.one/* @site-edition */, .two/* @end-site-edition */ { color: red; }'), '.one { color: red; }');
  // HTML, inside a line and on lines of their own.
  assert.equal(stripEdition('<p>merged with ffmpeg<!-- @site-edition -->, and more<!-- @end-site-edition -->, then</p>'), '<p>merged with ffmpeg, then</p>');
  assert.equal(stripEdition('<div>\n  <!-- @site-edition -->\n  <button>x</button>\n  <!-- @end-site-edition -->\n</div>\n'), '<div>\n</div>\n');
  // CSS lines.
  assert.equal(stripEdition('a { }\n/* @site-edition */\n.b { }\n/* @end-site-edition */\nc { }\n'), 'a { }\nc { }\n');
});

test('@store-edition: what follows it is what the store edition has instead, uncommented', () => {
  const src = `  ${O}\n  offerIt();\n  ${A}\n  // // Said plainly.\n  // sayIt();\n\n  //   indented();\n  ${C}\nnext();\n`;
  assert.equal(stripEdition(src), '  // Said plainly.\n  sayIt();\n\n    indented();\nnext();\n');
  // An empty site part: the block only adds the store's lines.
  assert.equal(stripEdition(`a();\n${O}\n${A}\n// b();\n${C}\nc();\n`), 'a();\nb();\nc();\n');
  // HTML and CSS: each store line is a comment of its own, in the marker's style.
  const html = ['<div>', '  <!-- @site-edition -->', '  <p>A, B and C.</p>', '  <!-- @store-edition -->', '  <!-- <p>A and B.</p> -->', '  <!-- @end-site-edition -->', '</div>', ''].join('\n');
  assert.equal(stripEdition(html), '<div>\n  <p>A and B.</p>\n</div>\n');
  const css = ['/* @site-edition */', '.a { }', '/* @store-edition */', '/* .b { } */', '/* @end-site-edition */', ''].join('\n');
  assert.equal(stripEdition(css), '.b { }\n');
  const bad = ['<!-- @site-edition -->', '<p>a</p>', '<!-- @store-edition -->', '<p>b</p>', '<!-- @end-site-edition -->', ''].join('\n');
  assert.throws(() => stripEdition(bad, 'x.html'), /x\.html:4: a line after @store-edition must be a <!-- … --> comment/);
  // In the development source those lines are comments, so they never run there.
  assert.ok(/\/\/ sayIt\(\);/.test(src));
});

test('nesting, a marker without its partner and a misspelt marker are errors, with the file and line', () => {
  assert.throws(() => stripEdition(`${O}\na\n${O}\nb\n${C}\n${C}\n`, 'x.js'), /x\.js:3: @site-edition inside the block opened on line 1/);
  assert.throws(() => stripEdition(`${O}\na\n`, 'x.js'), /x\.js:1: @site-edition is never closed/);
  assert.throws(() => stripEdition(`a\n${C}\n`, 'x.js'), /x\.js:2: @end-site-edition without its @site-edition/);
  assert.throws(() => stripEdition(`${A}\n// a\n`, 'x.js'), /@store-edition outside a block/);
  assert.throws(() => stripEdition(`${O}\n${A}\n// a\n${A}\n// b\n${C}\n`, 'x.js'), /a second @store-edition/);
  assert.throws(() => stripEdition('// @site-editon\na\n// @end-site-edition\n', 'x.js'), /x\.js:1: unknown edition marker "@site-editon"/);
  assert.throws(() => stripEdition('/* @store-editions */', 'x.css'), /unknown edition marker/);
  // A // marker shares its line with nothing (it would hide code, or be hidden by it).
  assert.throws(() => stripEdition('foo(); // @site-edition\nbar();\n// @end-site-edition\n', 'x.js'), /alone on its line/);
  assert.throws(() => stripEdition(`${O}\nbar(); // @end-site-edition\n`, 'x.js'), /alone on its line/);
  // Store lines must be comments (or blank), and their block must be made of whole lines.
  assert.throws(() => stripEdition(`${O}\na();\n${A}\nb();\n${C}\n`, 'x.js'), /x\.js:4: a line after @store-edition must be a \/\/ comment/);
  assert.throws(() => stripEdition('x(/* @site-edition */ a /* @store-edition */ b /* @end-site-edition */);', 'x.js'), /every marker on a line of its own/);
  // Nesting across comment styles is nesting too.
  assert.throws(() => stripEdition('/* @site-edition */ a <!-- @site-edition --> b <!-- @end-site-edition --> /* @end-site-edition */'), /do not nest/);
});

test('what the blocks declare at the top of a file is known, so the build can catch a name still in use', () => {
  const src = `${O}\nexport function gone() {}\nexport const alsoGone = 1;\nasync function third() {}\n  const inner = 2;\n${A}\n// const kept = 3;\n${C}\n`;
  assert.deepEqual([...declaredIn(src)].sort(), ['alsoGone', 'gone', 'third']);
  assert.equal(findBlocks(src).length, 1);
});

test('the forbidden words and the other edition are spotted in any case', () => {
  for (const s of ['YouTube', 'youtu.be/x', 'YT-DLP', 'ytdlp', 'r1.googlevideo.com']) assert.ok(FORBIDDEN.test(s), s);
  for (const s of ['Vimeo', 'you tube', 'the reading edition', 'ffmpeg']) assert.ok(!FORBIDDEN.test(s), s);
  for (const s of ['the website edition', 'site-edition', 'Store edition', '@end-site']) assert.ok(NO_OTHER_EDITION.test(s), s);
  assert.ok(!NO_OTHER_EDITION.test('the reading edition is saved'));
});

// ---------------------------------------------------------------- the second kind: Pro's blocks (the public source)
test('Pro blocks: taken out with their markers (lines, inside a line, with what the free copy has instead); store markers are left alone', () => {
  const src = [
    'import { a } from \'./a.js\';',
    '// @pro',
    'import { packIt, PACK } from \'./pack.js\';',
    'function proOnly() { return packIt(PACK); }',
    '// @free',
    '// const proOnly = () => null;',
    '// @end-pro',
    'const list = [1, /* @pro */ 2, /* @end-pro */ 3];',
    '// @site-edition',
    'site();',
    '// @end-site-edition',
    '// @provider is just a word here',
    '',
  ].join('\n');
  assert.equal(stripEdition(src, 'x.js', 'pro'), [
    'import { a } from \'./a.js\';',
    'const proOnly = () => null;',
    'const list = [1, 3];',
    '// @site-edition',
    'site();',
    '// @end-site-edition',
    '// @provider is just a word here',
    '',
  ].join('\n'));
  assert.equal(countBlocks(src, 'x.js', 'pro'), 2);
  assert.equal(countBlocks(src, 'x.js', 'site'), 1, 'each kind counts only its own');
  // The store's strip does not touch Pro's blocks.
  assert.ok(stripEdition(src, 'x.js', 'site').includes('function proOnly()'));
  // What a removed block declared or imported is known, so the build can catch a use of it left behind.
  assert.deepEqual([...declaredIn(src, 'x.js', 'pro')].sort(), ['PACK', 'packIt', 'proOnly']);
  // (For the store's kind, imports inside a block are not counted: its blocks hold no import lines today.)
  assert.deepEqual([...declaredIn('// @site-edition\nimport { q } from \'./q.js\';\nconst z = 1;\n// @end-site-edition\n', 'y.js', 'site')], ['z']);
});

test('Pro blocks: a misspelt, unclosed or nested marker stops the export', () => {
  assert.throws(() => stripEdition('// @pro-only\n', 'a.js', 'pro'), /a\.js:1: unknown Pro marker "@pro-only"/);
  assert.throws(() => stripEdition('// @pro\nx();\n', 'b.js', 'pro'), /b\.js:1: @site-edition is never closed|b\.js:1: .*never closed/);
  assert.throws(() => stripEdition('// @pro\n// @pro\n// @end-pro\n', 'c.js', 'pro'), /c\.js:2: .*do not nest/);
  assert.throws(() => stripEdition('// @end-pro\n', 'd.js', 'pro'), /d\.js:1: .*without its/);
  assert.throws(() => stripEdition('x', 'e.js', 'other'), /unknown kind of marker "other"/);
  // HTML and CSS comments work too.
  assert.equal(stripEdition('<p>a</p>\n<!-- @pro -->\n<p>b</p>\n<!-- @end-pro -->\n', 'f.html', 'pro'), '<p>a</p>\n');
  assert.equal(stripEdition('a { }\n/* @pro */\nb { }\n/* @end-pro */\n', 'g.css', 'pro'), 'a { }\n');
});

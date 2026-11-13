import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCues, cleanLine, decodeEntities, cleanCues, toParagraphs, formatStamp, mdEscape, transcriptExt,
  renderTranscript, buildTranscript, PAUSE_MS, MAX_SENTENCES, MAX_PARAGRAPH_CHARS,
} from '../extension/lib/transcript.js';

const cue = (startMs, endMs, text, speaker = '') => ({ startMs, endMs, text, speaker });

test('parseCues reads times and text from WebVTT, skipping headers, notes and styles', () => {
  const vtt = [
    '﻿WEBVTT - made for a test', 'Kind: captions', '',
    'NOTE this is a comment', '',
    'STYLE', '::cue { color: red }', '',
    'intro', '00:00:01.000 --> 00:00:03.500 align:start position:10%', 'First <b>line</b>', 'second line', '',
    '01:05.250 --> 01:07.000', 'short form, no hours', '',
    '1:02:03.004 --> 1:02:05.000', 'past one hour',
  ].join('\r\n');
  assert.deepEqual(parseCues(vtt), [
    { startMs: 1000, endMs: 3500, text: 'First <b>line</b>\nsecond line' },
    { startMs: 65250, endMs: 67000, text: 'short form, no hours' },
    { startMs: 3723004, endMs: 3725000, text: 'past one hour' },
  ]);
});

test('parseCues reads SRT (numbered blocks, comma decimals)', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n';
  assert.deepEqual(parseCues(srt), [
    { startMs: 1000, endMs: 2500, text: 'Hello' },
    { startMs: 3000, endMs: 4000, text: 'World' },
  ]);
});

test('parseCues gives nothing for empty input and for things that are not captions', () => {
  for (const junk of ['', null, undefined, 'WEBVTT', 'WEBVTT\n\nNOTE nothing here\n', '<!doctype html><html><body>Sign in</body></html>',
    '{"error":"not found"}', 'a --> b\nnot a time', '#EXTM3U\n#EXTINF:4.0,\nseg0.ts', 42, {}]) {
    assert.deepEqual(parseCues(junk), [], String(junk));
  }
});

test('cleanLine strips tags, word timings and positioning, and decodes entities once', () => {
  assert.deepEqual(cleanLine('<c.yellow.bg_blue>Tom &amp; Jerry</c> <i>say</i> &lt;hi&gt; &#39;ok&#39;&nbsp;now<00:00:01.500><c> then</c>'),
    { speaker: '', text: "Tom & Jerry say <hi> 'ok' now then" });
  assert.equal(cleanLine('{\\an8}Up top <font color="#fff">white</font>').text, 'Up top white');
  assert.equal(cleanLine('caf&#233; &#x1F600; &quot;q&quot; &apos;a&apos; &lrm;x').text, 'café 😀 "q" \'a\' x');
  // Decoded once: what the author typed as "&lt;" comes out as that, not as "<".
  assert.equal(cleanLine('&amp;lt;b&amp;gt; and &bogus; and AT&T; stay').text, '&lt;b&gt; and &bogus; and AT&T; stay');
  // Plain comparisons are not tags.
  assert.equal(cleanLine('if 2 < 3 and 5 > 4 then <3').text, 'if 2 < 3 and 5 > 4 then <3');
  assert.equal(cleanLine('  spaced \t out&#10;text  ').text, 'spaced out text');
  assert.equal(decodeEntities('&#0;&#xD800;&#x110000;a'), ' a');
});

test('cleanLine keeps speaker labels: a voice tag names the speaker, written labels stay in the text', () => {
  assert.deepEqual(cleanLine('<v Dr. Ada Lovelace>Welcome &amp; hello</v>'), { speaker: 'Dr. Ada Lovelace', text: 'Welcome & hello' });
  assert.deepEqual(cleanLine('<v.loud Ben>Hi'), { speaker: 'Ben', text: 'Hi' });
  assert.deepEqual(cleanLine('<v Ann>Yes.</v> <v Ben>No.</v>'), { speaker: 'Ann', text: 'Yes. Ben: No.' });
  assert.deepEqual(cleanLine('PROFESSOR: Good morning'), { speaker: '', text: 'PROFESSOR: Good morning' });
  assert.deepEqual(cleanLine('&gt;&gt; JOHN: [Music] hello'), { speaker: '', text: '>> JOHN: [Music] hello' });
});

test('cleanCues drops the rolling duplicates of auto-generated captions', () => {
  // Each new line is shown under the previous one, with a blink of the old line alone in between.
  const SP = ' '; // the line holding a single space that these files really contain
  const at = 'align:start position:0%';
  const vtt = ['WEBVTT', 'Kind: captions', 'Language: en', '',
    `00:00:00.000 --> 00:00:02.000 ${at}`, SP, 'welcome<00:00:00.500><c> to</c><00:00:01.000><c> the</c><00:00:01.500><c> course</c>', '',
    `00:00:02.000 --> 00:00:02.010 ${at}`, 'welcome to the course', SP, '',
    `00:00:02.010 --> 00:00:04.000 ${at}`, 'welcome to the course', 'today<00:00:02.500><c> we</c><00:00:03.000><c> talk</c><00:00:03.500><c> about</c>', '',
    `00:00:04.000 --> 00:00:04.010 ${at}`, 'today we talk about', SP, '',
    `00:00:04.010 --> 00:00:06.000 ${at}`, 'today we talk about', 'cells<00:00:04.500><c> and</c><00:00:05.000><c> tissues</c>', '',
  ].join('\n');
  const cues = cleanCues(parseCues(vtt));
  assert.deepEqual(cues.map((c) => [c.startMs, c.text]), [
    [0, 'welcome to the course'],
    [2010, 'today we talk about'],
    [4010, 'cells and tissues'],
  ]);
  assert.equal(toParagraphs(cues).map((p) => p.text).join('|'), 'welcome to the course today we talk about cells and tissues');
});

test('cleanCues drops an exact repeat only while the earlier cue is still up', () => {
  const twice = (secondStart) => cleanCues([
    { startMs: 0, endMs: 2000, text: 'Thank you.' },
    { startMs: secondStart, endMs: secondStart + 1000, text: 'Thank you.' },
  ]).length;
  assert.equal(twice(0), 1); // the same cue from two overlapping stream segments
  assert.equal(twice(1500), 1); // overlapping
  assert.equal(twice(2000), 1); // back to back
  assert.equal(twice(2250), 1); // the slack ends here...
  assert.equal(twice(2251), 2); // ...so this is someone saying it again
  assert.equal(twice(9000), 2);
});

test('cleanCues keeps a three-line roll-up down to its new line, and cues with no words out', () => {
  const cues = cleanCues([
    { startMs: 0, endMs: 1000, text: 'one\ntwo' },
    { startMs: 1000, endMs: 2000, text: 'two\nthree' },
    { startMs: 2000, endMs: 2100, text: '<c> </c>\n&nbsp;' },
    { startMs: 2100, endMs: 3000, text: 'three\nfour' },
  ]);
  assert.deepEqual(cues.map((c) => c.text), ['one two', 'three', 'four']);
  // A different speaker saying the same words is not a repeat.
  const voices = cleanCues([
    { startMs: 0, endMs: 1000, text: '<v Ann>Yes.' },
    { startMs: 1000, endMs: 2000, text: '<v Ben>Yes.' },
  ]);
  assert.deepEqual(voices.map((c) => [c.speaker, c.text]), [['Ann', 'Yes.'], ['Ben', 'Yes.']]);
  assert.deepEqual(cleanCues([{ startMs: 0, endMs: 1000, text: '<v Ann>Hi\n<v Ben>Hello\nthere' }]),
    [{ startMs: 0, endMs: 1000, speaker: 'Ann', text: 'Hi Ben: Hello there' }]);
  assert.deepEqual(cleanCues(null), []);
});

test('a pause longer than two seconds starts a new paragraph; exactly two seconds does not', () => {
  assert.equal(PAUSE_MS, 2000);
  const split = (gap) => toParagraphs([cue(0, 3300, 'First part'), cue(3300 + gap, 9000, 'second part')]);
  assert.deepEqual(split(2000), [{ startMs: 0, speaker: '', text: 'First part second part' }]);
  assert.deepEqual(split(1999).length, 1);
  assert.deepEqual(split(2001), [{ startMs: 0, speaker: '', text: 'First part' }, { startMs: 5301, speaker: '', text: 'second part' }]);
  // The pause is measured from the end of the cue before, not from its start.
  assert.equal(toParagraphs([cue(0, 10000, 'a long cue'), cue(11000, 12000, 'right after')]).length, 1);
  // A custom threshold has the same exact edge.
  assert.equal(toParagraphs([cue(0, 1000, 'a'), cue(1500, 2000, 'b')], { gapMs: 500 }).length, 1);
  assert.equal(toParagraphs([cue(0, 1000, 'a'), cue(1501, 2000, 'b')], { gapMs: 500 }).length, 2);
});

test('times straight from a file keep the two-second edge exact (no rounding drift)', () => {
  const at = (start) => buildTranscript(`WEBVTT\n\n00:00:01.100 --> 00:00:03.300\nOne\n\n${start} --> 00:00:09.000\nTwo\n`, { format: 'md', title: 'T' }).paragraphs;
  assert.equal(at('00:00:05.300'), 1); // 5.3 - 3.3 is 2.0000000000000004 in floating point
  assert.equal(at('00:00:05.301'), 2);
});

test('a repeated cue that stays on screen is not mistaken for a pause', () => {
  const cues = cleanCues([
    { startMs: 0, endMs: 2000, text: 'Still here' },
    { startMs: 2000, endMs: 6000, text: 'Still here' },
    { startMs: 7000, endMs: 8000, text: 'next' },
  ]);
  assert.deepEqual(cues.map((c) => [c.startMs, c.endMs, c.text]), [[0, 6000, 'Still here'], [7000, 8000, 'next']]);
  assert.equal(toParagraphs(cues).length, 1);
});

test('a paragraph closes after five sentences, at the end of a sentence', () => {
  assert.equal(MAX_SENTENCES, 5);
  const said = ['One.', 'Two!', 'Three?', 'Four…', 'Five is 3.5 long', 'and ends here.', 'Six.', 'Seven.'];
  const cues = said.map((text, i) => cue(i * 1000, (i + 1) * 1000, text));
  assert.deepEqual(toParagraphs(cues).map((p) => [p.startMs, p.text]), [
    [0, 'One. Two! Three? Four… Five is 3.5 long and ends here.'],
    [6000, 'Six. Seven.'],
  ]);
  // Five full stops inside one cue that stops mid-sentence: the paragraph waits for the sentence to end.
  const mid = toParagraphs([cue(0, 1000, 'A. B. C. D. E. and then'), cue(1000, 2000, 'it ends.'), cue(2000, 3000, 'New one.')]);
  assert.deepEqual(mid.map((p) => p.text), ['A. B. C. D. E. and then it ends.', 'New one.']);
  assert.equal(toParagraphs(cues, { maxSentences: 2 }).length, 4);
});

test('captions without punctuation are still broken up, by length', () => {
  const words = 'the quick brown fox jumps over the lazy dog again'; // 49 characters
  const cues = Array.from({ length: 60 }, (_, i) => cue(i * 2000, (i + 1) * 2000, words));
  const paras = toParagraphs(cues);
  assert.equal(paras.length, 4);
  assert.ok(paras.every((p) => p.text.length <= MAX_PARAGRAPH_CHARS + words.length), paras.map((p) => p.text.length).join());
  assert.ok(paras.slice(0, -1).every((p) => p.text.length >= MAX_PARAGRAPH_CHARS));
  assert.equal(paras.map((p) => p.text).join(' '), cues.map((c) => c.text).join(' ')); // nothing lost
  assert.equal(paras[1].startMs, 19 * 2000); // each starts at the time of its first cue
});

test('a new named speaker starts a new paragraph and is labelled once', () => {
  const paras = toParagraphs([
    cue(0, 1000, 'Welcome.', 'Ada'), cue(1000, 2000, 'Sit down.', 'Ada'), cue(2000, 3000, 'thanks'),
    cue(3000, 4000, 'A question?', 'Ben'), cue(4000, 5000, 'Go on.', 'Ada'),
  ]);
  assert.deepEqual(paras, [
    { startMs: 0, speaker: 'Ada', text: 'Welcome. Sit down. thanks' },
    { startMs: 3000, speaker: 'Ben', text: 'A question?' },
    { startMs: 4000, speaker: 'Ada', text: 'Go on.' },
  ]);
  assert.deepEqual(toParagraphs([]), []);
  assert.deepEqual(toParagraphs(undefined), []);
});

test('formatStamp: mm:ss under an hour, h:mm:ss from one hour on', () => {
  assert.equal(formatStamp(0), '00:00');
  assert.equal(formatStamp(999), '00:00');
  assert.equal(formatStamp(65000), '01:05');
  assert.equal(formatStamp(3599999), '59:59');
  assert.equal(formatStamp(3600000), '1:00:00');
  assert.equal(formatStamp(3723004), '1:02:03');
  assert.equal(formatStamp(36000000 + 59000), '10:00:59');
  assert.equal(formatStamp(-5), '00:00');
  assert.equal(formatStamp(NaN), '00:00');
});

test('renderTranscript: Markdown has a heading and a time on every paragraph', () => {
  const paras = [
    { startMs: 1000, speaker: 'Dr. Ada', text: 'Cells *divide* in two_ways.' },
    { startMs: 3723004, speaker: '', text: '[Music] see <b>this</b> [link](http://x.test) `code`' },
  ];
  assert.equal(renderTranscript(paras, { title: ' Cell  division\n101 ', format: 'md', sourceUrl: 'https://a.test/watch?v=1' }),
    '# Cell division 101\n\n'
    + '[00:01] Dr. Ada: Cells \\*divide\\* in two\\_ways.\n\n'
    + '[1:02:03] [Music] see \\<b>this\\</b> [link]\\(http://x.test) \\`code\\`\n\n'
    + 'Source: https://a.test/watch?v=1\n');
  assert.equal(mdEscape('a\\b'), 'a\\\\b');
});

test('renderTranscript: plain text has the title and the paragraphs, nothing escaped', () => {
  const paras = [
    { startMs: 1000, speaker: 'Dr. Ada', text: 'Cells *divide* in two_ways.' },
    { startMs: 3723004, speaker: '', text: 'Then <they> rest.' },
  ];
  assert.equal(renderTranscript(paras, { title: 'Cell division', format: 'txt' }),
    'Cell division\n\nDr. Ada: Cells *divide* in two_ways.\n\nThen <they> rest.\n');
  // Times can be asked for in plain text too, and left out of Markdown.
  assert.equal(renderTranscript(paras, { title: 'T', format: 'txt', timestamps: true }),
    'T\n\n[00:01] Dr. Ada: Cells *divide* in two_ways.\n\n[1:02:03] Then <they> rest.\n');
  assert.equal(renderTranscript(paras.slice(1), { title: 'T', format: 'md', timestamps: false }), '# T\n\nThen \\<they> rest.\n');
  assert.equal(renderTranscript([], {}), '# Transcript\n');
});

test('the transcript file extension only ever comes from the fixed list', () => {
  assert.equal(transcriptExt('md'), 'md');
  assert.equal(transcriptExt('txt'), 'txt');
  for (const odd of ['exe', 'TXT', '', undefined, null, '../x', 'html']) assert.equal(transcriptExt(odd), 'md', String(odd));
  assert.equal(buildTranscript('WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n', { format: 'bat' }).ext, 'md');
});

test('buildTranscript: a whole file, with a pause and a time past one hour, in both formats', () => {
  const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000 line:0 position:20%
<v Dr. Ada>Cells divide in <i>two</i> ways.

2
00:00:03.000 --> 00:00:05.000
<v Dr. Ada>Mitosis &amp; meiosis.

3
00:00:05.000 --> 00:00:07.000
<v Dr. Ada>Mitosis &amp; meiosis.
<v Dr. Ada>Mitosis makes two identical cells.

4
00:00:09.000 --> 00:00:11.000
<c.yellow>It has four stages.</c>

5
00:00:13.001 --> 00:00:15.000
<v Student>Is that all?

6
01:01:05.000 --> 01:01:08.000
<v Dr. Ada>That is all for today.
`;
  const md = buildTranscript(vtt, { title: 'Cell Division Basics', format: 'md', sourceUrl: 'https://school.test/lesson/7' });
  assert.deepEqual([md.ext, md.paragraphs, md.cues], ['md', 3, 6]);
  assert.equal(md.text, '# Cell Division Basics\n\n'
    + '[00:01] Dr. Ada: Cells divide in two ways. Mitosis & meiosis. Mitosis makes two identical cells. It has four stages.\n\n'
    + '[00:13] Student: Is that all?\n\n'
    + '[1:01:05] Dr. Ada: That is all for today.\n\n'
    + 'Source: https://school.test/lesson/7\n');
  const txt = buildTranscript(vtt, { title: 'Cell Division Basics', format: 'txt' });
  assert.equal(txt.ext, 'txt');
  assert.equal(txt.text, 'Cell Division Basics\n\n'
    + 'Dr. Ada: Cells divide in two ways. Mitosis & meiosis. Mitosis makes two identical cells. It has four stages.\n\n'
    + 'Student: Is that all?\n\n'
    + 'Dr. Ada: That is all for today.\n');
});

test('buildTranscript: empty or garbage captions give no text at all', () => {
  for (const junk of ['', 'WEBVTT\n', '<html><body>Access denied</body></html>', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c> </c>\n', null]) {
    assert.deepEqual(buildTranscript(junk, { title: 'T' }), { text: '', ext: 'md', paragraphs: 0, cues: 0 }, String(junk));
  }
});

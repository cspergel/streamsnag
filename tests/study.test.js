import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companionFilename } from '../extension/lib/study.js';


test('companionFilename builds "<name>.<kind>.<ext>" from fixed lists only', () => {
  assert.equal(companionFilename('Lecture 3 - 720p', 'transcript', 'md'), 'Lecture 3 - 720p.transcript.md');
  assert.equal(companionFilename('Lecture 3', 'transcript', 'txt'), 'Lecture 3.transcript.txt');
  assert.equal(companionFilename('Lecture 3', 'notes', 'md'), 'Lecture 3.notes.md');
  assert.equal(companionFilename('Lecture 3', 'flashcards', 'txt'), 'Lecture 3.flashcards.txt');
  // The study pack's guide, as a page and as Markdown.
  assert.equal(companionFilename('Lecture 3 - 720p', 'guide', 'html'), 'Lecture 3 - 720p.guide.html');
  assert.equal(companionFilename('Lecture 3', 'guide', 'md'), 'Lecture 3.guide.md');
  // The name is cleaned again, whatever it holds.
  assert.equal(companionFilename('../../evil: "name"?', 'notes', 'md'), 'evil name.notes.md');
  assert.equal(companionFilename('', 'transcript', 'md'), 'video.transcript.md');
  assert.ok(companionFilename('x'.repeat(400), 'flashcards', 'txt').length <= 150 + '.flashcards.txt'.length);
  for (const [kind, ext] of [['transcript', 'exe'], ['transcript', 'html'], ['notes', 'txt'], ['flashcards', 'md'], ['notes', ''], ['video', 'md'],
    ['constructor', 'md'], ['__proto__', 'md'], ['', 'md'], ['transcript', 'MD'], ['transcript', undefined],
    ['guide', 'htm'], ['guide', 'js'], ['guide', 'pdf'], ['deck', 'json'], ['study', 'md']]) {
    assert.throws(() => companionFilename('name', kind, ext), /Not a file StreamSnag saves/, `${kind}.${ext}`);
  }
});


// Matching a course's lectures to a real-world folder: numbered, renamed, with long course/date suffixes.
// (A made-up course, shaped like real ones: numbers with and without separators, suffixes that vary.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInLibrary, sameItem, leadNumber, contentIds } from '../extension/lib/match.js';

const D = 'C:\\Users\\me\\Downloads\\StreamSnag';
const names = [
  '002 - Management of Acute Decompensated Heart Failure - Annual Cardiology Review 2026 - Day 1 - 720p.mp4',
  '005 - Valvular Disease and Common Mimics - Annual Cardiology Review 2026 Day 1 - 720p.mp4',
  '006 Difficult ECG Cases for the Cardiologist - Annual Cardiology Review 2026 Day 1 - 720p.mp4',
  '008 - Recent Advances in Lipid Management - Annual Cardiology Review 2026 Day 1 2026-03-02 - 720p.mp4',
  '010 Bedside Echo for the Cardiologist.mp4',
  '012 Pericardial and Myocardial Disease - Annual Cardiology Review 2026 Day 1 (2026-03-02) - 720p.mp4',
  '018 - Inpatient Management of Syncope - Annual Cardiology Review 2026 Day 1 - 720p.mp4',
  '023 Inpatient Management of Patients with Pulmonary Hypertension - Annual Cardiology Review 2026 - 720p.mp4',
  '029 - Do I Really Need a Stress Test - Common Cardiology Curbsides - Cardiology Review 2026 Day 1 2026-03-02 - 720p.mp4',
  '033 Management of Endocarditis - Annual Cardiology Review 2026 Day 1 (2026-03-02) - 720p.mp4',
  '043 Anticoagulation - Comprehensive Update and Pearls for the Cardiologist Part I - Cardiology Review 2026 - 720p.mp4',
  '044 Anticoagulation - Comprehensive Update and Pearls for the Cardiologist Part II - Cardiology Rev 2026 - 720p.mp4',
  'Day 1 - inpatient arrhythmia March 2, 2026 - Annual Cardiology Review 2026 Live (123-26) - 720p.mp4',
];
const files = names.map((name, i) => ({ path: `${D}\\${name}`, name, size: 200_000_000 + i }));
const lecture = (title) => ({ id: title, kind: 'hls', url: 'https://cdn.example/x/playlist.m3u8', title, nameSource: 'player', info: {} });
const found = (title) => findInLibrary(lecture(title), [], files, [], Infinity)?.path?.split('\\').pop() || null;

test('lecture titles as a course site shows them ("NNN: Title") find the renamed files', () => {
  assert.match(found('033: Management of Endocarditis'), /^033 /);
  assert.match(found('029: Do I Really Need a Stress Test? Common Cardiology Curbsides'), /^029 /);
  assert.match(found('008: Recent Advances in Lipid Management'), /^008 /);
  assert.match(found('002: Management of Acute Decompensated Heart Failure'), /^002 /);
  assert.match(found('010: Bedside Echo for the Cardiologist'), /^010 /);
  // Part I and Part II share almost every word: the number decides...
  assert.match(found('043: Anticoagulation: Comprehensive Update and Pearls for the Cardiologist, Part I'), /^043 /);
  assert.match(found('044: Anticoagulation: Comprehensive Update and Pearls for the Cardiologist, Part II'), /^044 /);
  // ...and without numbers, "Part II" is not "Part I".
  assert.match(found('Anticoagulation: Comprehensive Update and Pearls for the Cardiologist, Part II'), /^044 /);
  assert.match(found('Anticoagulation: Comprehensive Update and Pearls for the Cardiologist, Part I'), /^043 /);
});

test('lectures that were never saved stay "not downloaded", even when they share words with saved ones', () => {
  assert.equal(found('009: Updates in the Diagnosis and Management of Atrial Fibrillation'), null); // "management" is in many files
  assert.equal(found('003: Centering Equity in Cardiology'), null); // the course's own words
  assert.equal(found('004: Goals of Care Conversations'), null);
  assert.equal(found('034: Management of Endocarditis Part 2'), null); // a different lecture number
  assert.equal(found('Annual Cardiology Review 2026 Day 1'), null); // only the course name: says nothing
  assert.equal(found('Management for the Cardiologist'), null); // only words many files share
});

test('a lecture is not "downloaded" just because another lecture happens to have the same length', () => {
  // Two lectures 0.2 s apart: 009 (46:21.77) and the file of 012 (46:21.97).
  const withLengths = files.map((f) => (f.name.startsWith('012 ') ? { ...f, duration: 2781.97 } : f.name.startsWith('008 ') ? { ...f, duration: 3860.74 } : f));
  const stream = (title, duration) => ({ id: title, kind: 'hls', url: 'https://cdn.example/y.m3u8', title, nameSource: 'player', info: { duration } });
  assert.equal(findInLibrary(stream('009: Updates in the Diagnosis and Management of Atrial Fibrillation', 2781.77), [], withLengths, []), null);
  // Without a lecture number, a descriptive name about something else still rules the file out.
  assert.equal(findInLibrary(stream('Updates in the Diagnosis and Management of Atrial Fibrillation', 2781.77), [], withLengths, []), null);
  // The right lecture is still found by length (and a renamed file with a bare name is not ruled out).
  assert.match(findInLibrary(stream('012: Pericardial and Myocardial Disease', 2781.8), [], withLengths, []).path, /012 Pericardial/);
  assert.match(findInLibrary(stream('008: Recent Advances in Lipid Management', 3860.7), [], withLengths, []).path, /008 - Recent/);
  const bare = [{ path: `${D}\\video (3).mp4`, name: 'video (3).mp4', size: 5, duration: 2781.9 }];
  // (By its length alone, so only as "probably this one": it is not shown as downloaded. See tests/realsites.test.js, B9.)
  assert.deepEqual(findInLibrary(stream('009: Updates in the Diagnosis and Management of Atrial Fibrillation', 2781.77), [], bare, []), { path: bare[0].path, how: 'length', probable: true });
});

test('a lecture number is read from the start of a name, not from dates or times', () => {
  assert.equal(leadNumber('009: Updates in the Diagnosis'), 9);
  assert.equal(leadNumber('033 Management of Endocarditis.mp4'), 33);
  assert.equal(leadNumber('000 - Course Introduction'), 0);
  assert.equal(leadNumber('Lecture 12 - Sepsis'), 12);
  assert.equal(leadNumber('2026-11-02 Morning session'), null);
  assert.equal(leadNumber('10:30 Keynote'), null);
  assert.equal(leadNumber('Day 1 - intro'), null);
});

test("a revisit's freshly signed Vimeo link still matches the earlier download by the video's file id", () => {
  const uuid = 'c5c7e357-a526-496c-9f86-2e5d5664ed4e';
  const rec = {
    mediaUrl: `https://vod-adaptive-ak.vimeocdn.com/exp=1794271660~acl=%2F${uuid}%2Fpsid%3D3f3a~hmac=abc/${uuid}/v2/playlist/av/primary/playlist.m3u8?r=dXM`,
    outputs: [{ path: `${D}\\033 Management of Endocarditis.mp4`, size: 226531191 }],
  };
  const today = { id: 'n', kind: 'hls', key: `https://skyfire.vimeocdn.com/1800000000-0xdead/${uuid}/v2/playlist/av/primary/playlist.m3u8`, url: `https://skyfire.vimeocdn.com/1800000000-0xdead/${uuid}/v2/playlist/av/primary/playlist.m3u8?r=b3RoZXI`, info: {} };
  assert.equal(sameItem(today, rec), true);
  const renamed = [{ path: `${D}\\My notes - endocarditis.mp4`, size: 226531191 }];
  assert.deepEqual(findInLibrary(today, [rec], renamed, [D]), { path: renamed[0].path, how: 'renamed' });
  // Another lecture (another file id) is not that download; nor is a subtitle file of the same video.
  assert.equal(sameItem({ ...today, key: 'https://skyfire.vimeocdn.com/1/aaaaaaaa-1111-2222-3333-444444444444/v2/playlist.m3u8', url: 'u' }, rec), false);
  assert.deepEqual(contentIds([`https://captions.example/${uuid}/en.vtt`]), []);
});

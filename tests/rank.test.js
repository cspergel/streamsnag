import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankVideoOptions } from '../extension/lib/util.js';

const ids = (list) => rankVideoOptions(list).map((o) => o.id);

test('rankVideoOptions: tallest picture first, whatever order the stream lists them in', () => {
  assert.deepEqual(ids([
    { id: 'v0', label: '360p · 800 kbps', height: 360, bandwidth: 800e3 },
    { id: 'v1', label: '1080p · 5.0 Mbps', height: 1080, bandwidth: 5e6 },
    { id: 'v2', label: '720p · 2.0 Mbps', height: 720, bandwidth: 2e6 },
  ]), ['v1', 'v2', 'v0']);
});

test('rankVideoOptions: the same height is ordered by bitrate', () => {
  assert.deepEqual(ids([
    { id: 'low', label: '1080p · 3.0 Mbps', height: 1080, bandwidth: 3e6 },
    { id: 'high', label: '1080p · 8.0 Mbps', height: 1080, bandwidth: 8e6 },
    { id: 'small', label: '720p · 9.0 Mbps', height: 720, bandwidth: 9e6 },
  ]), ['high', 'low', 'small'], 'height wins over bitrate; bitrate only breaks a tie');
});

test('rankVideoOptions: streams that give no resolution are ordered by bitrate alone', () => {
  assert.deepEqual(ids([
    { id: 'a', label: '900 kbps', bandwidth: 900e3 },
    { id: 'b', label: '4.5 Mbps', bandwidth: 4.5e6 },
    { id: 'c', label: '2.0 Mbps', bandwidth: 2e6 },
  ]), ['b', 'c', 'a']);
});

test('rankVideoOptions: reads height and bitrate from the label when the numbers are missing', () => {
  assert.deepEqual(ids([
    { id: 'a', label: '480p · 1.2 Mbps' },
    { id: 'b', label: '720p · 900 kbps' },
    { id: 'c', label: '720p · 2.5 Mbps' },
  ]), ['c', 'b', 'a'], '900 kbps is less than 2.5 Mbps: the unit matters');
  // The numbers win over a label that disagrees.
  assert.deepEqual(ids([{ id: 'x', label: '1080p', height: 240 }, { id: 'y', label: '360p', height: 360 }]), ['y', 'x']);
});

test('rankVideoOptions: audio-only and subtitle options are left out', () => {
  assert.deepEqual(ids([
    { id: 'a0', label: 'Audio · English', audio: true, bandwidth: 9e9 },
    { id: 'v0', label: '720p', height: 720 },
    { id: 's0', label: 'Subtitles · English', subtitle: true },
  ]), ['v0']);
});

test('rankVideoOptions: keeps the given order when nothing tells the options apart, and never changes its input', () => {
  const input = [{ id: 'media', label: 'Download · 12:30' }, { id: 'other', label: 'Download' }, { id: 'third', label: 'Download' }];
  const before = JSON.stringify(input);
  assert.deepEqual(ids(input), ['media', 'other', 'third']);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(rankVideoOptions(undefined), []);
  assert.deepEqual(rankVideoOptions([]), []);
});

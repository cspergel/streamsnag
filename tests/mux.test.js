import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMuxArgs, lang3, findTool } from '../native-host/host.js';

test('lang3 maps 2-letter and region codes to ISO 639-2, unknown to und', () => {
  assert.equal(lang3('en'), 'eng');
  assert.equal(lang3('pt-BR'), 'por');
  assert.equal(lang3('deu'), 'deu');
  assert.equal(lang3('English'), 'und');
  assert.equal(lang3(''), 'und');
});

test('buildMuxArgs maps only A/V streams, embeds subs as mov_text in MP4 and SRT in MKV', () => {
  const a = buildMuxArgs({ inputs: ['/d/v.ts', '/d/a.ts'], subtitles: [{ path: '/d/s.vtt', lang: 'en' }], output: '/d/out.mp4' });
  const joined = a.join(' ');
  assert.match(joined, /-i \/d\/v\.ts -i \/d\/a\.ts -i \/d\/s\.vtt/);
  assert.match(joined, /-map 0:v\? -map 0:a\? -map 1:v\? -map 1:a\? -map 2:s\?/);
  assert.match(joined, /-c copy -c:s mov_text -metadata:s:s:0 language=eng/);
  assert.match(joined, /-bsf:a aac_adtstoasc/);
  assert.equal(a.at(-1), '/d/out.mp4');
  assert.ok(a.includes('+faststart'));

  const m = buildMuxArgs({ inputs: ['/d/v.webm'], subtitles: [{ path: '/d/s.vtt' }], output: '/d/out.mkv' }).join(' ');
  assert.match(m, /-c:s srt/);
  assert.doesNotMatch(m, /faststart|aac_adtstoasc/);

  const n = buildMuxArgs({ inputs: ['/d/v.mp4'], output: '/d/o.mp4' }).join(' ');
  assert.doesNotMatch(n, /-c:s|:s\?/);
});

const ffmpeg = findTool('ffmpeg');
test('real ffmpeg: .ts video + .ts audio + .vtt become one MP4 with 3 streams', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-mux-'));
  const p = (n) => path.join(dir, n);
  const q = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=2',
    '-c:v', 'libx264', '-f', 'mpegts', p('v.ts')], q);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', 'aac', '-f', 'mpegts', p('a.ts')], q);
  fs.writeFileSync(p('s.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n');
  execFileSync(ffmpeg, buildMuxArgs({ inputs: [p('v.ts'), p('a.ts')], subtitles: [{ path: p('s.vtt'), lang: 'en' }], output: p('out.mp4') }), q);
  const ffprobe = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
  const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', p('out.mp4')], { ...q, encoding: 'utf8' }));
  const types = info.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort();
  assert.deepEqual(types, ['audio:aac', 'subtitle:mov_text', 'video:h264']);
  assert.equal(info.streams.find((s) => s.codec_type === 'subtitle').tags.language, 'eng');
  fs.rmSync(dir, { recursive: true, force: true });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMuxArgs, lang3, findTool, buildConvertArgs, convertOutputName, parseFfmpegProgress } from '../native-host/host.js';

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

test('converted copies are named after the original and only two kinds exist', () => {
  assert.equal(convertOutputName(path.join('d', 'Lecture 9.mp4'), 'audio'), path.join('d', 'Lecture 9.mp3'));
  assert.equal(convertOutputName(path.join('d', 'Lecture 9.final.mkv'), 'small'), path.join('d', 'Lecture 9.final (720p).mp4'));
  for (const bad of ['gif', '', undefined, 'constructor', '__proto__', 'toString']) {
    assert.throws(() => convertOutputName(path.join('d', 'a.mp4'), bad), /Unknown conversion/, String(bad));
    assert.throws(() => buildConvertArgs({ input: 'a.mp4', output: 'b.mp4', mode: bad }), /Unknown conversion/, String(bad));
  }
});

test('buildConvertArgs: MP3 drops the picture; the small copy caps the height at 720 without upscaling', () => {
  const a = buildConvertArgs({ input: '/d/in.mp4', output: '/d/in.mp3', mode: 'audio' });
  assert.deepEqual(a.slice(a.indexOf('-i'), a.indexOf('-i') + 2), ['-i', '/d/in.mp4']);
  assert.ok(a.includes('-vn') && a.includes('libmp3lame'));
  assert.equal(a.at(-1), '/d/in.mp3');
  const s = buildConvertArgs({ input: '/d/in.mkv', output: '/d/in (720p).mp4', mode: 'small' });
  assert.ok(s.includes("scale=-2:'min(720,ih)'"));
  assert.ok(s.includes('libx264') && s.includes('+faststart') && s.includes('mov_text'));
  assert.equal(buildConvertArgs({ input: 'a', output: 'b', mode: 'small', subtitles: false }).includes('mov_text'), false);
  // The input is always passed as the value of -i, so a name starting with "-" cannot become an option.
  const odd = buildConvertArgs({ input: '-y.mp4', output: 'o.mp3', mode: 'audio' });
  assert.equal(odd[odd.indexOf('-y.mp4') - 1], '-i');
});

test('parseFfmpegProgress reads seconds from -progress lines and ignores the rest', () => {
  assert.equal(parseFfmpegProgress('out_time_us=1500000'), 1.5);
  assert.equal(parseFfmpegProgress('out_time_ms=90000000\r'), 90);
  assert.equal(parseFfmpegProgress('out_time_us=0'), 0);
  for (const l of ['out_time_us=N/A', 'out_time=00:00:01.500000', 'frame=30', 'progress=end', '', null, 'xout_time_us=5']) assert.equal(parseFfmpegProgress(l), null, String(l));
});

test('real ffmpeg: a tall video becomes an MP3 and a 720p MP4', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-conv-'));
  const q = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
  const src = path.join(dir, 'Lecture 9.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1282x962:rate=5:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-vf', 'scale=1280:960', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', src], q);
  const ffprobe = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
  const streams = (f) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', f], { ...q, encoding: 'utf8' })).streams;

  const mp3 = convertOutputName(src, 'audio');
  const out = execFileSync(ffmpeg, buildConvertArgs({ input: src, output: mp3, mode: 'audio' }), { ...q, encoding: 'utf8' });
  assert.deepEqual(streams(mp3).map((s) => `${s.codec_type}:${s.codec_name}`), ['audio:mp3']);
  // The progress lines our parser depends on are really there, and end near the clip's length.
  const times = out.split(/\r?\n/).map(parseFfmpegProgress).filter((t) => t != null);
  assert.ok(times.length > 0 && Math.abs(times.at(-1) - 2) < 0.5, `progress times ${times.slice(-3)}`);

  const small = convertOutputName(src, 'small');
  execFileSync(ffmpeg, buildConvertArgs({ input: src, output: small, mode: 'small' }), q);
  const v = streams(small).find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.height, 720);
  assert.equal(v.width, 960);
  assert.ok(streams(small).some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'));

  // A video that is already small is not blown up.
  const tiny = path.join(dir, 'tiny.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', tiny], q);
  const tinyOut = convertOutputName(tiny, 'small');
  execFileSync(ffmpeg, buildConvertArgs({ input: tiny, output: tinyOut, mode: 'small' }), q);
  assert.equal(streams(tinyOut).find((s) => s.codec_type === 'video').height, 90);
  fs.rmSync(dir, { recursive: true, force: true });
});


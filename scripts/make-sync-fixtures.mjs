#!/usr/bin/env node
// Writes the frame-sync fixtures to example/fixtures and checks every frame
// with ffmpeg. Frame n carries n as a 12-bit code on a 12×9 grid: row band
// 0–1 holds bit i in column i (white = 1), band 2–3 holds its complement, so
// a blended or torn frame reads as unreadable rather than as another index.
// A white cell in row 6 steps one column per frame, for the eye.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENDER_GRID, RENDER_TIMES } from '../benchmark/frame-sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'example/fixtures');

export const SYNC_FIXTURES = [
  { id: 'sync-h264-640x360-30', width: 640, height: 360, fps: 30, seconds: 8, codec: 'h264' },
  { id: 'sync-h264-640x360-24', width: 640, height: 360, fps: 24, seconds: 6, codec: 'h264' },
  { id: 'sync-h264-1280x720-60', width: 1280, height: 720, fps: 60, seconds: 6, codec: 'h264' },
  { id: 'sync-hevc-1920x1080-60', width: 1920, height: 1080, fps: 60, seconds: 6, codec: 'hevc' },
  { id: 'sync-h264-3840x2160-30', width: 3840, height: 2160, fps: 30, seconds: 6, codec: 'h264' },
  { id: 'sync-hevc-3840x2160-30', width: 3840, height: 2160, fps: 30, seconds: 6, codec: 'hevc' },
  { id: 'sync-hevc-3840x2160-60', width: 3840, height: 2160, fps: 60, seconds: 6, codec: 'hevc' },
];

// SMPTE HD color bars: each frame mode (YUV, RGBA) is compared with the colors
// ffmpeg decodes the file to, at the center of these bars.
export const COLOR_FIXTURES = [
  { id: 'color-bars-h264-1920x1080-30', width: 1920, height: 1080, fps: 30, seconds: 1, codec: 'h264' },
  { id: 'color-bars-hevc-1920x1080-30', width: 1920, height: 1080, fps: 30, seconds: 1, codec: 'hevc' },
];
const COLOR_PATCHES = [
  ['gray-40', 0.0625, 0.3], ['white-75', 0.178, 0.3], ['yellow-75', 0.286, 0.3], ['cyan-75', 0.393, 0.3],
  ['green-75', 0.5, 0.3], ['magenta-75', 0.607, 0.3], ['red-75', 0.714, 0.3], ['blue-75', 0.821, 0.3],
  ['cyan-100', 0.0625, 0.625], ['navy', 0.178, 0.625], ['blue-100', 0.9375, 0.625],
  ['yellow-100', 0.0625, 0.708], ['purple', 0.178, 0.708], ['ramp-25', 0.4, 0.708], ['ramp-50', 0.6, 0.708],
  ['ramp-75', 0.8, 0.708], ['red-100', 0.9375, 0.708],
  ['gray-15', 0.0625, 0.875], ['black', 0.2, 0.875], ['white-100', 0.4, 0.875],
];

// Photographic content: slow pans across real camera photos (Apple's sample
// photos from the iOS Simulator runtime, macOS's aerial wallpaper) with a
// light temporal grain, for texture, saturated chroma, sky gradients and a
// camera-like bitrate. Tagged BT.709. Generated locally when the photos exist,
// never committed or downloaded.
function findPhoto(name) {
  if (name.startsWith('/')) return existsSync(name) ? name : null;
  const found = spawnSync('find', ['/Library/Developer/CoreSimulator/Volumes', '-path',
    `*SampleContent/Media/DCIM/100APPLE/${name}`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  return found[0] ?? null;
}
export const REAL_FIXTURES = [
  { id: 'real-flowers-hevc-3840x2160-60', photo: 'IMG_0006.HEIC', width: 3840, height: 2160, fps: 60, seconds: 6,
    codec: 'hevc', sourceWidth: 4032, sourceHeight: 3024 },
  { id: 'real-bridge-h264-3840x2160-30', photo: '/System/Library/Wallpapers/.default/DefaultAerial.jpg', width: 3840,
    height: 2160, fps: 30, seconds: 6, codec: 'h264', sourceWidth: 4096, sourceHeight: 2160, maxrate: '50M' },
  { id: 'real-dunes-h264-1920x1080-30', photo: 'IMG_0001.JPG', width: 1920, height: 1080, fps: 30, seconds: 6,
    codec: 'h264', sourceWidth: 2560, sourceHeight: 1700 },
  // The flowers again, tagged Display P3 with the sRGB transfer function, as a
  // screen recording can be: decoders that honor the tags (VideoToolbox's
  // BGRA) convert it to Rec.709, the GPU's YUV conversion applies only its
  // matrix and range. Documents that difference; not camera footage.
  { id: 'tagged-p3-flowers-h264-1920x1080-30', photo: 'IMG_0006.HEIC', width: 1920, height: 1080, fps: 30,
    seconds: 6, codec: 'h264', sourceWidth: 2016, sourceHeight: 1512,
    tags: { primaries: 'smpte432', transfer: 'iec61966-2-1' } },
];

const bit = 'bitand(N,pow(2,X))';
const luma = `if(lt(Y,2),if(${bit},235,16),if(lt(Y,4),if(${bit},16,235),if(eq(Y,6)*eq(X,mod(N,12)),235,128)))`;

function run(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args],
    { maxBuffer: 1 << 30, timeout: 600000 });
  if (result.status !== 0) throw new Error(String(result.stderr) || `ffmpeg exited ${result.status}`);
  return result.stdout;
}

/** Decodes every frame and returns the index each one reads as (-1: unreadable). */
function readIndices(file) {
  const raw = run(['-i', file, '-vf', 'scale=12:9:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const indices = [];
  for (let offset = 0; offset + 108 <= raw.length; offset += 108) {
    let index = 0;
    for (let x = 0; x < 12; x++) {
      const value = raw[offset + 12 + x];
      const complement = raw[offset + 36 + x];
      if ((value > 128) === (complement > 128)) { index = -1; break; }
      if (value > 128) index |= 1 << x;
    }
    indices.push(index);
  }
  return indices;
}

/** The 8×8 patch averages of frame `index`, as ffmpeg decodes the file (BT.709, limited range). */
function referencePatches(file, width, height, points = COLOR_PATCHES, index = 0) {
  const raw = run(['-i', file, '-vf',
    `select=eq(n\\,${index}),scale=in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=full:flags=accurate_rnd+full_chroma_int,format=rgb24`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return points.map(([name, u, v]) => {
    const x0 = Math.round(u * width) - 4;
    const y0 = Math.round(v * height) - 4;
    const rgb = [0, 0, 0];
    for (let y = y0; y < y0 + 8; y++)
      for (let x = x0; x < x0 + 8; x++)
        for (let c = 0; c < 3; c++) rgb[c] += raw[(y * width + x) * 3 + c] / 64;
    return { name, u, v, rgb: rgb.map(Math.round) };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = { schema: 1, files: [] };
  const scratch = mkdtempSync(path.join(tmpdir(), 'rnskv-photo-'));
  try {
    for (const fixture of REAL_FIXTURES) {
      const photo = findPhoto(fixture.photo);
      if (!photo) {
        console.log(`${fixture.photo} not found: no ${fixture.id}`);
        continue;
      }
      const png = path.join(scratch, `${fixture.id}.png`);
      const converted = spawnSync('sips', ['-s', 'format', 'png', photo, '--out', png], { encoding: 'utf8' });
      if (converted.status !== 0) throw new Error(converted.stderr || `sips could not convert ${photo}`);
      const file = `${fixture.id}.mp4`;
      const output = path.join(directory, file);
      const codec = fixture.codec === 'hevc'
        ? ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-crf', '18', '-preset', 'fast']
        : ['-c:v', 'libx264', '-crf', '17', '-preset', 'medium'];
      const { width, height, seconds, sourceWidth, sourceHeight } = fixture;
      run(['-y', '-loop', '1', '-framerate', String(fixture.fps), '-i', png, '-t', String(seconds), '-vf',
        `scale=${sourceWidth}:${sourceHeight},crop=${width}:${height}:x='(in_w-${width})*t/${seconds}':y='(in_h-${height})*t/${seconds}',` +
        'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,noise=alls=4:allf=t,' +
        // Camera footage is tagged BT.709: the photos' own color tags and ICC
        // profile (Display P3, Adobe RGB) must not reach the file.
        `sidedata=mode=delete:type=ICC_PROFILE,setparams=range=tv:colorspace=bt709:` +
        `color_primaries=${fixture.tags?.primaries ?? 'bt709'}:color_trc=${fixture.tags?.transfer ?? 'bt709'}`,
        // A phone's bitrate: the grain alone would take 4K H.264 past 120 Mbit/s.
        ...codec, ...(fixture.maxrate ? ['-maxrate', fixture.maxrate, '-bufsize', fixture.maxrate] : []),
        '-g', String(fixture.fps),
        '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', fixture.tags?.primaries ?? 'bt709',
        '-color_trc', fixture.tags?.transfer ?? 'bt709', '-movflags', '+faststart', output]);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'stream=color_primaries,color_transfer,color_space:stream_side_data=side_data_type', '-of', 'csv=p=0', output],
        { encoding: 'utf8' }).stdout.trim();
      const wanted = `bt709,${fixture.tags?.transfer ?? 'bt709'},${fixture.tags?.primaries ?? 'bt709'}`;
      if (probe !== wanted) throw new Error(`${file}: tagged ${probe}, expected ${wanted}`);
      const bytes = readFileSync(output);
      const references = Object.fromEntries(RENDER_TIMES.map((time) =>
        [time, referencePatches(output, width, height, RENDER_GRID, Math.round(time * fixture.fps))]));
      manifest.files.push({ ...fixture, photo: path.basename(photo), file, frames: fixture.fps * seconds,
        bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), references });
      console.log(`${file}: ${(bytes.length / 1e6).toFixed(1)} MB (${(bytes.length * 8 / seconds / 1e6).toFixed(0)} Mbit/s)`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const fixture of COLOR_FIXTURES) {
    const file = `${fixture.id}.mp4`;
    const output = path.join(directory, file);
    const codec = fixture.codec === 'hevc'
      ? ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-crf', '12']
      : ['-c:v', 'libx264', '-crf', '12'];
    run(['-y', '-f', 'lavfi', '-i', `smptehdbars=s=${fixture.width}x${fixture.height}:r=${fixture.fps}:d=${fixture.seconds}`,
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', ...codec, '-g', String(fixture.fps),
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-movflags', '+faststart', output]);
    const bytes = readFileSync(output);
    manifest.files.push({ ...fixture, file, frames: fixture.fps * fixture.seconds, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), patches: referencePatches(output, fixture.width, fixture.height) });
    console.log(`${file}: ${bytes.length} bytes, ${COLOR_PATCHES.length} reference patches`);
  }
  for (const fixture of SYNC_FIXTURES) {
    const file = `${fixture.id}.mp4`;
    const output = path.join(directory, file);
    const codec = fixture.codec === 'hevc'
      ? ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-crf', '18']
      : ['-c:v', 'libx264', '-crf', '16'];
    run(['-y', '-f', 'lavfi', '-i', `color=c=black:s=12x9:r=${fixture.fps}:d=${fixture.seconds}`,
      '-vf', `format=yuv444p,geq=lum='${luma}':cb=128:cr=128,scale=${fixture.width}:${fixture.height}:flags=neighbor,format=yuv420p`,
      // A key frame every second, B-frames on: decode order differs from display order.
      ...codec, '-g', String(fixture.fps), '-preset', 'slow',
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-movflags', '+faststart', output]);
    const indices = readIndices(output);
    const frames = fixture.fps * fixture.seconds;
    const wrong = indices.findIndex((index, n) => index !== n);
    if (indices.length !== frames || wrong >= 0)
      throw new Error(`${file}: ${indices.length}/${frames} frames, frame ${wrong} reads ${indices[wrong]}`);
    const bytes = readFileSync(output);
    manifest.files.push({ ...fixture, file, frames, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    console.log(`${file}: ${frames} frames read back, ${bytes.length} bytes`);
  }
  writeFileSync(path.join(directory, 'sync-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

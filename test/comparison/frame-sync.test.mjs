import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { analyzeExport, analyzePreview, expectedIndex, formatFrameSyncReport, irregularPercent, previewPassed, readCode } from '../../benchmark/frame-sync.mjs';

// Generated locally by scripts/make-sync-fixtures.mjs, like the other fixtures.
const manifestUrl = new URL('../../example/fixtures/sync-manifest.json', import.meta.url);

/** A 12×9 RGBA grid with `source` in rows 0–3 and `stamp` in rows 4–7. */
function grid(source, stamp) {
  const pixels = new Uint8Array(12 * 9 * 4).fill(128);
  const put = (row, x, on) => pixels.fill(on ? 255 : 0, (row * 12 + x) * 4, (row * 12 + x) * 4 + 4);
  for (let x = 0; x < 12; x++) {
    for (const [value, top] of [[source, 0], [stamp, 4]]) {
      const bit = ((value >> x) & 1) === 1;
      put(top, x, bit); put(top + 1, x, bit); put(top + 2, x, !bit); put(top + 3, x, !bit);
    }
  }
  return pixels;
}

/** Draws at every vsync of a display, showing what `shown(time)` returns. */
function play({ fps, refreshHz, seconds, items, shown }) {
  const draws = [];
  const vsyncs = [];
  const period = 1000 / refreshHz;
  for (let k = 0; k * period < seconds * 1000; k++) {
    const time = k * period / 1000;
    draws.push({ at: k * period, time, item: 0, index: shown(time) });
    if (k) vsyncs.push(period);
  }
  return analyzePreview({ items, fps, draws, vsyncs });
}

const item = { compositionStartTime: 0, startTime: 0.5, duration: 6 };

test('reads both codes and rejects a blended frame', () => {
  const pixels = grid(1234, 77);
  assert.equal(readCode(pixels, 1, 3), 1234);
  assert.equal(readCode(pixels, 5, 7), 77);
  pixels.fill(128, 0, 12 * 4 * 4);
  assert.equal(readCode(pixels, 1, 3), -1);
});

test('the due frame is the last one at or before the clock', () => {
  assert.equal(expectedIndex(item, 0, 30), 15);
  assert.equal(expectedIndex(item, 1 / 30 - 0.002, 30), 15);
  assert.equal(expectedIndex(item, 1 / 30, 30), 16);
  assert.equal(expectedIndex({ compositionStartTime: 3, startTime: 4, duration: 3 }, 3.5, 30), 135);
});

test('a preview on time passes, 30 fps on 60 and 120 Hz', () => {
  for (const refreshHz of [60, 120]) {
    const result = play({ fps: 30, refreshHz, seconds: 6, items: [item], shown: (time) => expectedIndex(item, time, 30) });
    assert.equal(result.exactPercent, 100);
    assert.equal(result.skippedFrames, 0);
    assert.equal(result.irregularPercent, 0);
    assert.ok(previewPassed(result), JSON.stringify(result));
  }
});

test('24 fps on 60 Hz alternates 2 and 3 vsyncs and is not irregular', () => {
  const result = play({ fps: 24, refreshHz: 60, seconds: 6, items: [{ compositionStartTime: 0, startTime: 0, duration: 6 }],
    shown: (time) => Math.floor(time * 24 + 1e-3) });
  assert.equal(result.irregularPercent, 0);
  assert.ok(previewPassed(result), JSON.stringify(result));
});

test('a picture a frame late, a skipped frame and a stall are reported', () => {
  const late = play({ fps: 30, refreshHz: 60, seconds: 6, items: [item], shown: (time) => expectedIndex(item, time, 30) - 1 });
  assert.equal(late.exactPercent, 0);
  assert.deepEqual(Object.keys(late.offsets), ['-1']);
  assert.ok(!previewPassed(late));

  const skipped = play({ fps: 30, refreshHz: 60, seconds: 6, items: [item],
    shown: (time) => { const index = expectedIndex(item, time, 30); return index === 80 ? 81 : index; } });
  assert.equal(skipped.skippedFrames, 1);
  assert.ok(!previewPassed(skipped));

  const stalled = play({ fps: 30, refreshHz: 60, seconds: 6, items: [item],
    shown: (time) => Math.min(expectedIndex(item, time, 30), time > 2 && time < 2.2 ? 75 : Infinity) });
  assert.equal(stalled.heldFrames, 1);
  assert.ok(stalled.irregularPercent > 0);
  assert.ok(!previewPassed(stalled));
});

test('reading one frame in four still finds a skipped frame', () => {
  // 30 fps at 60 Hz, every fourth distinct frame read; `skip` is never drawn.
  const sampled = (skip) => {
    const draws = [];
    let seq = 0;
    let last = -1;
    for (let k = 0; k < 360; k++) {
      const time = k / 60;
      let index = expectedIndex(item, time, 30);
      if (index === skip) index++;
      if (index !== last) { seq++; last = index; }
      draws.push({ at: k * 1000 / 60, time, item: 0, seq, index: seq % 4 === 0 ? index : -2 });
    }
    return analyzePreview({ items: [item], fps: 30, draws, vsyncs: Array.from({ length: 359 }, () => 1000 / 60) });
  };
  const clean = sampled(-1);
  assert.equal(clean.skippedFrames, 0);
  assert.equal(clean.unreadable, 0);
  assert.equal(clean.irregularPercent, 0);
  const skipped = sampled(80);
  assert.equal(skipped.skippedFrames, 1);
  assert.ok(skipped.irregularPercent > 0);
});

test('irregular intervals: off by more than 3/4 of a refresh', () => {
  assert.equal(irregularPercent([33.3, 33.3, 50, 16.7], 33.3, 16.7), 50);
  assert.equal(irregularPercent([], 33.3, 16.7), null);
});

test('an export maps every output frame to its source frame', () => {
  const items = [{ compositionStartTime: 0, startTime: 0, duration: 4 }];
  const perfect = Array.from({ length: 240 }, (_, k) => ({ stamp: k, source: Math.floor(k / 2) }));
  assert.ok(analyzeExport({ items, sourceFps: 30, outputFps: 60, frames: perfect, expectedFrames: 240 }).passed);

  const dropped = perfect.filter((_, k) => k !== 100);
  const result = analyzeExport({ items, sourceFps: 30, outputFps: 60, frames: dropped, expectedFrames: 240 });
  assert.equal(result.passed, false);
  assert.equal(result.stampErrors, 139);
  assert.deepEqual(result.offsets, { 0: 239 });

  const early = perfect.map((frame) => ({ ...frame, source: frame.source + 1 }));
  assert.deepEqual(analyzeExport({ items, sourceFps: 30, outputFps: 60, frames: early, expectedFrames: 240 }).offsets, { 1: 240 });
});

test('the report formats every case', () => {
  const lines = formatFrameSyncReport({ status: 'failed', deviceModel: 'x', displayRefreshRate: 60, skiaVersion: '3.7.1', buildMode: 'release',
    previews: [{ id: 'p', status: 'failed', failure: 'boom' }], exports: [{ id: 'e', status: 'failed', failure: 'bad' }] });
  assert.equal(lines.length, 3);
});

const skipFixtures = !existsSync(manifestUrl) ? 'sync fixtures not generated' :
  spawnSync('ffmpeg', ['-version']).status !== 0 ? 'ffmpeg not installed' : false;

test('every sync fixture reads back its own frame index', { skip: skipFixtures }, () => {
  for (const fixture of JSON.parse(readFileSync(manifestUrl)).files.filter((file) => file.id.startsWith('sync-'))) {
    const file = new URL(`../../example/fixtures/${fixture.file}`, import.meta.url).pathname;
    const raw = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=12:9:flags=area',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 }).stdout;
    const frames = raw.length / (12 * 9 * 4);
    assert.equal(frames, fixture.frames, fixture.file);
    for (let n = 0; n < frames; n++)
      assert.equal(readCode(raw.subarray(n * 432, (n + 1) * 432), 1, 3), n, `${fixture.file} frame ${n}`);
  }
});

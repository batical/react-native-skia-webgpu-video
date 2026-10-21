import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import * as native from 'react-native';
import { AlphaType, Canvas, ColorType, Image, Skia } from 'react-native-skia';
import type { SkCanvas, SkPaint, SkSurface } from 'react-native-skia';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';
import {
  __RNSkiaVideoPrivateAPI as nativeVideo,
  clearVideoFrameImages,
  drawVideoFrame,
  getVideoResourceStats,
  exportVideoComposition,
  makeVideoFrameImage,
  releaseVideoFrameImage,
  useVideoComposition,
} from '../src';
import type { FrameDrawer, VideoComposition, VideoFrame, VideoFramePixelFormat } from '../src';
import {
  analyzeExport,
  analyzePreview,
  expectedIndex,
  itemAt,
  patchDifference,
  previewPassed,
  readCode,
  RENDER_GRID,
  RENDER_TIMES,
} from '../benchmark/frame-sync.mjs';
import syncManifest from './fixtures/sync-manifest.json';
import benchmarkManifest from './fixtures/manifest.json';

// Which source frame the preview draws at each vsync, against the player's
// clock, and which source frame each exported frame holds. The fixtures carry
// their frame index (scripts/make-sync-fixtures.mjs); the export stamps its
// output index under it. Test-only: nothing here changes the library.

type Patch = { name: string; u: number; v: number; rgb: number[] };
type Fixture = { id: string; file: string; fps: number; seconds: number; width?: number; height?: number;
  // Color bars: ffmpeg's colors at the bars; photographic clips: at RENDER_GRID, per time.
  patches?: Patch[]; references?: Record<string, Patch[]> };
type Item = { id: string; fixture: string; compositionStartTime: number; startTime: number; duration: number;
  maxLongSide?: number };
type PreviewCase = { id: string; items: Item[]; duration: number; splitImportAndDraw?: boolean;
  framePixelFormat?: VideoFramePixelFormat;
  seeks?: number[];
  // Off: no readback of the frame index, only the distinct frames drawn (the readback's cost apart).
  readback?: boolean;
  // Read one distinct frame in N: the readback's GPU round trip (~3.5 ms) on every frame of a 4K
  // 60 fps clip overruns a 120 Hz vsync on its own. Skipped frames still show between frames read.
  readEvery?: number };
type ExportCase = { id: string; items: Item[]; duration: number; outputFps: number;
  framePixelFormat?: VideoFramePixelFormat;
  width?: number; height?: number };
type Draw = { at: number; time: number; item: number; index: number; seq: number };
type Samples = { draws: Draw[]; vsyncs: number[]; readMs: number[]; lastFrame: number; lastItem: number; lastIndex: number;
  // Per draw: how long drawFrame took (ms), and the distinct frames it drew.
  drawMs: number[]; distinctFrames: number };
// index -2: a frame not read (readEvery).
type Probe = { surface: SkSurface; canvas: SkCanvas; paint: SkPaint };

// The frame-sync fixtures, then the benchmark's (real media: rotations, HDR, slow motion).
const fixtures = [...syncManifest.files, ...benchmarkManifest.files] as unknown as Fixture[];
const hasFixture = (id: string) => fixtures.some((file) => file.id === id);
const fixture = (id: string): Fixture => {
  const entry = fixtures.find((file) => file.id === id);
  if (!entry) throw new Error(`Unknown fixture ${id}`);
  return entry;
};
const single = (id: string, startTime: number, duration: number): Item[] =>
  [{ id: 'a', fixture: id, compositionStartTime: 0, startTime, duration }];
// A cut at 3 s to a later part of the same file: the index jumps by 90.
const cut: Item[] = [
  { id: 'a', fixture: 'sync-h264-640x360-30', compositionStartTime: 0, startTime: 0, duration: 3 },
  { id: 'b', fixture: 'sync-h264-640x360-30', compositionStartTime: 3, startTime: 4, duration: 3 },
];
// Seeks on, just before and just after frame boundaries: an off-by-one shows there.
const boundarySeeks = (fps: number) => [0, 1, 1 - 0.0005, 1 + 0.0005, 100 / fps, 2.5, 37 / fps,
  37 / fps - 0.001, 4.75, 0.5, 3 + 1 / (2 * fps)];

export const PREVIEW_CASES: PreviewCase[] = [
  { id: 'preview-30', items: single('sync-h264-640x360-30', 0.5, 6), duration: 6, seeks: boundarySeeks(30) },
  { id: 'preview-30-split', items: single('sync-h264-640x360-30', 0.5, 6), duration: 6, splitImportAndDraw: true },
  { id: 'preview-24', items: single('sync-h264-640x360-24', 0, 6), duration: 6 },
  { id: 'preview-60', items: single('sync-h264-1280x720-60', 0, 6), duration: 6, seeks: boundarySeeks(60) },
  { id: 'preview-hevc-60', items: single('sync-hevc-1920x1080-60', 0, 6), duration: 6 },
  { id: 'preview-cut', items: cut, duration: 6 },
  { id: 'preview-4k-h264-30', items: single('sync-h264-3840x2160-30', 0, 6), duration: 6 },
  { id: 'preview-4k-hevc-30', items: single('sync-hevc-3840x2160-30', 0, 6), duration: 6, seeks: boundarySeeks(30) },
  { id: 'preview-4k-hevc-60', items: single('sync-hevc-3840x2160-60', 0, 6), duration: 6 },
  { id: 'preview-4k-hevc-60-noread', items: single('sync-hevc-3840x2160-60', 0, 6), duration: 6, readback: false },
  { id: 'preview-4k-hevc-60-sampled', items: single('sync-hevc-3840x2160-60', 0, 6), duration: 6, readEvery: 4 },
  // The same decode, smaller decoded frames: what an app should ask for a 4K clip in a small preview.
  { id: 'preview-4k-hevc-60-1920-noread', items: [{ ...single('sync-hevc-3840x2160-60', 0, 6)[0]!, maxLongSide: 1920 }],
    duration: 6, readback: false },
  { id: 'preview-4k-hevc-60-1280-noread', items: [{ ...single('sync-hevc-3840x2160-60', 0, 6)[0]!, maxLongSide: 1280 }],
    duration: 6, readback: false },
  // Each frame pixel format, explicitly (see VideoFramePixelFormat).
  { id: 'preview-30-yuv', items: single('sync-h264-640x360-30', 0.5, 6), duration: 6, framePixelFormat: 'yuv',
    seeks: boundarySeeks(30) },
  { id: 'preview-30-rgba', items: single('sync-h264-640x360-30', 0.5, 6), duration: 6, framePixelFormat: 'rgba' },
  { id: 'preview-hevc-60-yuv', items: single('sync-hevc-1920x1080-60', 0, 6), duration: 6, framePixelFormat: 'yuv' },
  { id: 'preview-hevc-60-rgba', items: single('sync-hevc-1920x1080-60', 0, 6), duration: 6, framePixelFormat: 'rgba' },
  { id: 'preview-4k-hevc-60-yuv-noread', items: single('sync-hevc-3840x2160-60', 0, 6), duration: 6,
    framePixelFormat: 'yuv', readback: false },
  { id: 'preview-4k-hevc-60-rgba-noread', items: single('sync-hevc-3840x2160-60', 0, 6), duration: 6,
    framePixelFormat: 'rgba', readback: false },
  { id: 'preview-4k-hevc-60-yuv-sampled', items: single('sync-hevc-3840x2160-60', 0, 6), duration: 6,
    framePixelFormat: 'yuv', readEvery: 4 },
  { id: 'preview-4k-hevc-60-rgba-sampled', items: single('sync-hevc-3840x2160-60', 0, 6), duration: 6,
    framePixelFormat: 'rgba', readEvery: 4 },
  // Real media, in the run's frame pixel format: cadence only, no frame index to read. The
  // photographic clips are generated locally (scripts/make-sync-fixtures.mjs); missing ones skip.
  { id: 'preview-real-flowers-4k60', items: single('real-flowers-hevc-3840x2160-60', 0, 6), duration: 6,
    readback: false },
  { id: 'preview-real-bridge-4k30', items: single('real-bridge-h264-3840x2160-30', 0, 6), duration: 6,
    readback: false },
  { id: 'preview-real-dunes-1080p30', items: single('real-dunes-h264-1920x1080-30', 0, 6), duration: 6,
    readback: false },
  { id: 'preview-real-hlg-1080p30', items: single('hevc-1080p-hlg10', 0, 6), duration: 6, readback: false },
  { id: 'preview-real-hevc-4k30', items: single('hevc-4k30', 0, 8), duration: 8, readback: false },
];

export const EXPORT_CASES: ExportCase[] = [
  { id: 'export-30-to-30', items: single('sync-h264-640x360-30', 0.5, 4), duration: 4, outputFps: 30 },
  { id: 'export-60-to-30', items: single('sync-h264-1280x720-60', 0.25, 4), duration: 4, outputFps: 30 },
  { id: 'export-30-to-60', items: single('sync-h264-640x360-30', 0, 4), duration: 4, outputFps: 60 },
  { id: 'export-24-to-30', items: single('sync-h264-640x360-24', 0, 4), duration: 4, outputFps: 30 },
  { id: 'export-hevc-60-to-60', items: single('sync-hevc-1920x1080-60', 0, 4), duration: 4, outputFps: 60 },
  { id: 'export-cut', items: cut, duration: 6, outputFps: 30 },
  { id: 'export-4k-hevc-30-to-4k-30', items: single('sync-hevc-3840x2160-30', 0.5, 3), duration: 3, outputFps: 30,
    width: 3840, height: 2160 },
  { id: 'export-4k-hevc-60-to-4k-60', items: single('sync-hevc-3840x2160-60', 0, 3), duration: 3, outputFps: 60,
    width: 3840, height: 2160 },
  { id: 'export-4k-h264-30-to-1080-30', items: single('sync-h264-3840x2160-30', 0, 3), duration: 3, outputFps: 30,
    width: 1920, height: 1080 },
  { id: 'export-4k-hevc-60-to-1080-30', items: single('sync-hevc-3840x2160-60', 0.25, 3), duration: 3, outputFps: 30,
    width: 1920, height: 1080 },
  { id: 'export-30-to-30-yuv', items: single('sync-h264-640x360-30', 0.5, 4), duration: 4, outputFps: 30,
    framePixelFormat: 'yuv' },
  { id: 'export-cut-yuv', items: cut, duration: 6, outputFps: 30, framePixelFormat: 'yuv' },
  { id: 'export-4k-hevc-60-to-4k-60-yuv', items: single('sync-hevc-3840x2160-60', 0, 3), duration: 3, outputFps: 60,
    width: 3840, height: 2160, framePixelFormat: 'yuv' },
  { id: 'export-4k-hevc-60-to-4k-60-rgba', items: single('sync-hevc-3840x2160-60', 0, 3), duration: 3, outputFps: 60,
    width: 3840, height: 2160, framePixelFormat: 'rgba' },
  { id: 'export-4k-hevc-60-to-1080-30-yuv', items: single('sync-hevc-3840x2160-60', 0.25, 3), duration: 3, outputFps: 30,
    width: 1920, height: 1080, framePixelFormat: 'yuv' },
  { id: 'export-4k-hevc-60-to-1080-30-rgba', items: single('sync-hevc-3840x2160-60', 0.25, 3), duration: 3, outputFps: 30,
    width: 1920, height: 1080, framePixelFormat: 'rgba' },
];

const sourceFps = (items: Item[]) => fixture(items[0]!.fixture).fps;

const toComposition = (items: Item[], duration: number, directory: string,
  framePixelFormat?: VideoFramePixelFormat): VideoComposition => ({
  duration,
  framePixelFormat,
  items: items.map(({ fixture: id, ...item }) => ({ ...item, path: `${directory.replace(/\/$/, '')}/${fixture(id).file}` })),
});

/** The source code and the export stamp of a frame, read from a 12×9 downscale: one pixel per cell. */
export const readFrameCodes = (frame: VideoFrame) => {
  'worklet';
  const picture = makeVideoFrameImage(frame);
  if (!picture) return null;
  const global = globalThis as unknown as { __frameSyncProbe?: Probe };
  let probe = global.__frameSyncProbe;
  if (!probe) {
    const surface = Skia.Surface.MakeOffscreen(12, 9);
    if (!surface) throw new Error('Cannot allocate the frame-sync probe');
    probe = { surface, canvas: surface.getCanvas(), paint: Skia.Paint() };
    global.__frameSyncProbe = probe;
  }
  probe.canvas.drawImageRect(picture.image, picture.rect, Skia.XYWHRect(0, 0, 12, 9), probe.paint);
  const pixels = probe.canvas.readPixels(0, 0,
    { width: 12, height: 9, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque });
  if (!(pixels instanceof Uint8Array)) throw new Error('Frame-sync readback failed');
  return { source: readCode(pixels, 1, 3), stamp: readCode(pixels, 5, 7) };
};

/** Draws `index` in rows 4–7 of the grid, as the fixtures carry theirs in rows 0–3. */
const stampIndex = (canvas: SkCanvas, index: number, width: number, height: number) => {
  'worklet';
  const paint = Skia.Paint();
  const cellWidth = width / 12;
  const cellHeight = height / 9;
  for (let x = 0; x < 12; x++) {
    const bit = (index >> x) & 1;
    paint.setColor(Skia.Color(bit ? '#ffffff' : '#000000'));
    canvas.drawRect(Skia.XYWHRect(x * cellWidth, 4 * cellHeight, cellWidth, 2 * cellHeight), paint);
    paint.setColor(Skia.Color(bit ? '#000000' : '#ffffff'));
    canvas.drawRect(Skia.XYWHRect(x * cellWidth, 6 * cellHeight, cellWidth, 2 * cellHeight), paint);
  }
};

const emptySamples = (): Samples =>
  ({ draws: [], vsyncs: [], readMs: [], lastFrame: -2, lastItem: -1, lastIndex: -1, drawMs: [], distinctFrames: 0 });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type PreviewResult = Record<string, unknown> & { status: string };

/** Plays one case through useVideoComposition, then seeks it, and reports. */
// The native preview counters (iOS) a run adds: ring refusals, empty decode queues, decode ticks.
const previewCounters = () => {
  const native = (getVideoResourceStats().native ?? {}) as Record<string, number>;
  return Object.fromEntries(Object.entries(native).filter(([key]) => key.startsWith('preview')));
};

function PreviewProbe({ run, directory, defaultFormat, frameRateVote, sampleConditions, onDone }:
  { run: PreviewCase; directory: string; defaultFormat?: VideoFramePixelFormat;
    frameRateVote?: Helpers['frameRateVote'];
    sampleConditions?: Helpers['sampleConditions']; onDone: (result: PreviewResult) => void }) {
  const framePixelFormat = run.framePixelFormat ?? defaultFormat;
  const samples = useSharedValue<Samples>(emptySamples());
  const fps = sourceFps(run.items);
  const composition = useMemo(() => toComposition(run.items, run.duration, directory, framePixelFormat),
    [run, directory, framePixelFormat]);
  const ready = useRef(false);
  const complete = useRef(false);
  const failure = useRef<unknown>(null);
  const readback = run.readback ?? true;
  const readEvery = run.readEvery ?? 1;

  const drawFrame = useCallback<FrameDrawer>(({ canvas, currentTime, frames, width, height, videoComposition }) => {
    'worklet';
    const at = performance.now();
    const item = itemAt(videoComposition.items, currentTime);
    const itemIndex = item ? videoComposition.items.indexOf(item) : -1;
    const frame = item ? frames[item.id] : undefined;
    if (frame) drawVideoFrame(canvas, frame, { x: 0, y: 0, width, height });
    const last = samples.value;
    let index = frame ? last.lastIndex : -1;
    let readMs = -1;
    const fresh = !!frame && (frame.id === undefined || frame.id !== last.lastFrame || itemIndex !== last.lastItem);
    // Read only a new frame: the readback costs a GPU round trip.
    const seq = last.distinctFrames + (fresh ? 1 : 0);
    if (frame && fresh) {
      if (readback && seq % readEvery === 0) {
        const start = performance.now();
        index = readFrameCodes(frame)?.source ?? -1;
        readMs = performance.now() - start;
      } else {
        index = -2;
      }
    }
    const drawMs = performance.now() - at;
    samples.modify((value) => {
      'worklet';
      value.drawMs.push(drawMs);
      if (fresh) value.distinctFrames++;
      if (frame) {
        value.lastFrame = frame.id ?? -1;
        value.lastItem = itemIndex;
        value.lastIndex = index;
      }
      if (readMs >= 0) value.readMs.push(readMs);
      value.draws.push({ at, time: currentTime, item: frame ? itemIndex : -1, index, seq });
      return value;
    });
  }, [samples, readback, readEvery]);

  useFrameCallback((info) => {
    'worklet';
    const interval = info.timeSincePreviousFrame;
    if (interval != null) samples.modify((value) => {
      'worklet';
      value.vsyncs.push(interval);
      return value;
    });
  });

  const { currentFrame, player } = useVideoComposition({
    composition, drawFrame, width: 320, height: 180, autoPlay: true,
    splitImportAndDraw: run.splitImportAndDraw ?? false,
    onReadyToPlay: () => { ready.current = true; },
    onComplete: () => { complete.current = true; },
    onError: (error) => { failure.current ??= error; },
  });

  useEffect(() => {
    if (!frameRateVote || frameRateVote.mode === 'none') return;
    frameRateVote.vote(frameRateVote.mode, fps).catch(() => undefined);
    return () => { frameRateVote.vote(frameRateVote.mode, 0).catch(() => undefined); };
  }, [frameRateVote, fps]);

  useEffect(() => {
    if (!player) return;
    let cancelled = false;
    const finish = (result: Record<string, unknown>) => { if (!cancelled) onDone(result as PreviewResult); };
    (async () => {
      const conditions = await sampleConditions?.().catch(() => null);
      const countersBefore = previewCounters();
      const deadline = Date.now() + (run.duration + 15) * 1000;
      while (!complete.current) {
        if (failure.current) throw failure.current;
        if (Date.now() > deadline) throw new Error(`No completion after ${run.duration + 15} s (ready ${ready.current})`);
        await sleep(100);
      }
      const countersAfter = previewCounters();
      const counters = Object.fromEntries(Object.entries(countersAfter)
        .map(([key, value]) => [key, value - (countersBefore[key] ?? 0)]));
      const played = samples.value;
      const playback = analyzePreview({ items: run.items, fps, draws: played.draws, vsyncs: played.vsyncs });
      const drawMs = [...played.drawMs].sort((a, b) => a - b);
      const measured = played.draws.filter((draw) => draw.time >= 0.5);
      const span = measured.length > 1 ? measured.at(-1)!.time - measured[0]!.time : 0;
      const cadence = {
        draws: played.draws.length,
        distinctFrames: played.distinctFrames,
        // The frames due over the run, against which distinctFrames counts the frames never drawn.
        dueFrames: Math.round(run.duration * fps),
        drawMs: { p50: drawMs[Math.floor(drawMs.length / 2)] ?? null, p95: drawMs[Math.floor(drawMs.length * 0.95)] ?? null,
          max: drawMs.at(-1) ?? null },
        drawsPerSecond: span > 0 ? Math.round(measured.length / span * 10) / 10 : null,
      };
      // Raw samples, compact: [ms since the first draw, composition time, index], and the vsync intervals.
      const t0 = played.draws[0]?.at ?? 0;
      const raw = { draws: played.draws.map((draw) => [Math.round((draw.at - t0) * 100) / 100,
        Math.round(draw.time * 10000) / 10000, draw.index, draw.seq]), vsyncs: played.vsyncs.map((v) => Math.round(v * 100) / 100) };
      const readMs = [...played.readMs].sort((a, b) => a - b);
      const seeks = [];
      for (const time of run.seeks ?? []) {
        player.pause();
        samples.value = emptySamples();
        const item = itemAt(run.items, time)!;
        const expected = expectedIndex(item, time, fps);
        const started = Date.now();
        player.seekTo(time);
        let draws: Draw[] = [];
        while (Date.now() - started < 2000) {
          await sleep(16);
          draws = samples.value.draws.filter((draw) => Math.abs(draw.time - time) < 2e-6);
          if (draws.at(-1)?.index === expected) break;
        }
        const shown = draws.at(-1);
        seeks.push({ time, expected, shown: shown?.index ?? null, latencyMs: Date.now() - started,
          // Frames drawn at the new time before the right one: a flash of a wrong frame.
          drawnBefore: draws.map((draw) => draw.index).filter((index, i, all) => index !== expected && all.indexOf(index) === i) });
      }
      const seeksPassed = seeks.every((seek) => seek.shown === seek.expected);
      finish({
        id: run.id, fps, splitImportAndDraw: run.splitImportAndDraw ?? false,
        framePixelFormat: framePixelFormat ?? 'auto',
        status: (readback ? previewPassed(playback) : cadence.distinctFrames >= cadence.dueFrames - 2) && seeksPassed
          ? 'passed' : 'failed',
        conditions, counters,
        playback: readback ? playback : null, playbackPassed: readback ? previewPassed(playback) : null, cadence, raw,
        readbackMs: { p50: readMs[Math.floor(readMs.length / 2)] ?? null, max: readMs.at(-1) ?? null },
        seeks, seeksPassed,
      });
    })().catch((error: unknown) => finish({ id: run.id, status: 'failed',
      failure: error instanceof Error ? error.message : String(error) }));
    return () => { cancelled = true; };
    // One run per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  return <Canvas style={{ width: 320, height: 180 }}>
    <Image image={currentFrame} x={0} y={0} width={320} height={180} />
  </Canvas>;
}

/** Exports one case with the output index stamped, decodes every frame back, and reports. */
async function runExport(run: ExportCase, directory: string, outputDirectory: string,
  probe: (path: string) => Promise<unknown>, remove: (path: string) => Promise<unknown>,
  defaultFormat?: VideoFramePixelFormat) {
  const framePixelFormat = run.framePixelFormat ?? defaultFormat;
  const outPath = `${outputDirectory}/frame-sync-${run.id}.mp4`;
  const outputFps = run.outputFps;
  const expectedFrames = Math.round(run.duration * outputFps);
  try {
    const exportStart = performance.now();
    await exportVideoComposition({
      videoComposition: toComposition(run.items, run.duration, directory, framePixelFormat),
      outPath, width: run.width ?? 640, height: run.height ?? 360, frameRate: outputFps,
      bitRate: (run.width ?? 640) >= 3840 ? 40_000_000 : 4_000_000, codec: 'h264',
      drawFrame: ({ canvas, currentTime, frames, width, height, videoComposition }) => {
        'worklet';
        const item = itemAt(videoComposition.items, currentTime);
        const frame = item ? frames[item.id] : undefined;
        if (frame) drawVideoFrame(canvas, frame, { x: 0, y: 0, width, height });
        stampIndex(canvas, Math.round(currentTime * outputFps), width, height);
      },
    });
    const exportMs = Math.round(performance.now() - exportStart);
    // The platform decoder's view of the file: frame count and timestamps.
    const file = await probe(outPath);
    const extractor = nativeVideo.createVideoCompositionFramesExtractorSync({
      duration: run.duration, lazyDecoders: true,
      items: [{ id: 'output', path: outPath, compositionStartTime: 0, startTime: 0,
        duration: run.duration, textureMode: 'copy' }],
    });
    const frames: { stamp: number; source: number }[] = [];
    try {
      extractor.start();
      for (let k = 0; k < expectedFrames; k++) {
        const decoded = extractor.decodeCompositionFrames((k + 0.5) / outputFps);
        const frame = decoded.output;
        try {
          const codes = frame ? readFrameCodes(frame) : null;
          frames.push(codes ?? { stamp: -1, source: -1 });
        } finally {
          for (const each of Object.values(decoded)) {
            releaseVideoFrameImage(each);
            each.dispose?.();
          }
        }
      }
    } finally {
      extractor.dispose();
      clearVideoFrameImages(true);
    }
    const result = analyzeExport({ items: run.items, sourceFps: sourceFps(run.items), outputFps, frames, expectedFrames });
    const fileFrames = (file as { frameCount?: number } | null)?.frameCount;
    return { id: run.id, sourceFps: sourceFps(run.items), outputFps, size: `${run.width ?? 640}x${run.height ?? 360}`,
      framePixelFormat: framePixelFormat ?? 'auto', exportMs,
      status: result.passed && fileFrames === expectedFrames ? 'passed' : 'failed', ...result, file };
  } catch (error) {
    return { id: run.id, status: 'failed', failure: error instanceof Error ? error.message : String(error) };
  } finally {
    await remove(outPath).catch(() => undefined);
  }
}

/** Where an upright picture point lands in the frame's texture. */
const texturePoint = (picture: NonNullable<ReturnType<typeof makeVideoFrameImage>>, u: number, v: number) => {
  const ux = u * picture.width;
  const uy = v * picture.height;
  const { x, y, width, height } = picture.rect;
  switch (picture.rotation) {
    case 90: return [x + uy, y + height - ux];
    case 180: return [x + width - ux, y + height - uy];
    case 270: return [x + width - uy, y + ux];
    default: return [x + ux, y + uy];
  }
};

/** The 8×8 patch averages of one decoded frame around points of its upright picture. */
function readUprightPatches(frame: VideoFrame, points: readonly { u: number; v: number }[]) {
  const picture = makeVideoFrameImage(frame);
  if (!picture) throw new Error('The frame did not decode to an image');
  const imageWidth = picture.image.width();
  const imageHeight = picture.image.height();
  return points.map(({ u, v }) => {
    const [px, py] = texturePoint(picture, u, v);
    const x = Math.min(Math.max(Math.round(px!) - 4, 0), imageWidth - 8);
    const y = Math.min(Math.max(Math.round(py!) - 4, 0), imageHeight - 8);
    const data = picture.image.readPixels(x, y,
      { width: 8, height: 8, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque });
    if (!(data instanceof Uint8Array)) throw new Error('Color readback failed');
    const rgb = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) rgb[c]! += data[i + c]! / 64;
    return rgb.map(Math.round);
  });
}

/** Decodes a clip in one frame pixel format and reads the points at each time. */
function decodePatches(directory: string, clip: Fixture, format: 'yuv' | 'rgba', times: number[],
  points: readonly { u: number; v: number }[]) {
  const extractor = nativeVideo.createVideoCompositionFramesExtractorSync({
    duration: clip.seconds, framePixelFormat: format,
    items: [{ id: 'clip', path: `${directory.replace(/\/$/, '')}/${clip.file}`, compositionStartTime: 0,
      startTime: 0, duration: clip.seconds, textureMode: 'copy' }],
  } as VideoComposition);
  const patches: number[][][] = [];
  try {
    extractor.start();
    for (const time of times) {
      const frames = extractor.decodeCompositionFrames(time);
      try {
        if (!frames.clip) throw new Error(`${format}: no frame at ${time} s`);
        patches.push(readUprightPatches(frames.clip, points));
      } finally {
        for (const frame of Object.values(frames)) { releaseVideoFrameImage(frame); frame.dispose?.(); }
      }
    }
  } finally {
    extractor.dispose();
    clearVideoFrameImages(true);
  }
  return patches;
}

/**
 * Decodes the first frame of each color bars fixture in each frame pixel
 * format and compares its colors with ffmpeg's (scripts/make-sync-fixtures.mjs)
 * and with each other's: the YUV and RGBA paths must agree.
 */
async function runColorCheck(directory: string) {
  const results = [];
  for (const bars of fixtures) {
    if (!bars.patches) continue;
    const entry: Record<string, unknown> = { id: `colors-${bars.id}` };
    try {
      const time = [0.5 / bars.fps];
      const yuv = decodePatches(directory, bars, 'yuv', time, bars.patches)[0]!;
      const rgba = decodePatches(directory, bars, 'rgba', time, bars.patches)[0]!;
      const reference = bars.patches.map((patch) => patch.rgb);
      const maxDifference = { yuv: patchDifference(yuv, reference).max, rgba: patchDifference(rgba, reference).max,
        yuvVsRgba: patchDifference(yuv, rgba).max };
      Object.assign(entry, { maxDifference, status: maxDifference.yuvVsRgba <= 3 && maxDifference.yuv <= 6 &&
        maxDifference.rgba <= 6 ? 'passed' : 'failed',
        patches: bars.patches.map((patch, i) => ({ name: patch.name, reference: patch.rgb, yuv: yuv[i], rgba: rgba[i] })) });
    } catch (error) {
      Object.assign(entry, { status: 'failed', failure: error instanceof Error ? error.message : String(error) });
    }
    results.push(entry);
  }
  return results;
}

// Real media whose YUV and RGBA renderings are compared: the photographic
// clips (also against ffmpeg), and the benchmark's rotations, HDR, sizes and
// slow motion (both formats only: their files carry no color tags).
const RENDER_FIXTURES = ['real-flowers-hevc-3840x2160-60', 'real-bridge-h264-3840x2160-30',
  'real-dunes-h264-1920x1080-30', 'tagged-p3-flowers-h264-1920x1080-30', 'h264-1080p30-audio', 'hevc-4k30', 'hevc-1080p-hlg10', 'h264-720p60',
  'h264-1080p-rot90', 'hevc-1080p-rot270', 'h264-720p-rot180', 'h264-1080x1920', 'h264-638x358', 'h264-slow-motion'];

/** The same frames rendered in each frame pixel format, on a 6×4 grid of the upright picture. */
async function runRenderCheck(directory: string) {
  const points = RENDER_GRID.map(([, u, v]) => ({ u: u as number, v: v as number }));
  const results = [];
  for (const id of RENDER_FIXTURES) {
    if (!hasFixture(id)) {
      results.push({ id: `render-${id}`, status: 'skipped', reason: 'fixture not generated' });
      continue;
    }
    const clip = fixture(id);
    const entry: Record<string, unknown> = { id: `render-${id}` };
    try {
      const times = clip.references ? RENDER_TIMES : [0.5, clip.seconds / 2, clip.seconds - 0.5];
      const yuv = decodePatches(directory, clip, 'yuv', times, points).flat();
      const rgba = decodePatches(directory, clip, 'rgba', times, points).flat();
      const reference = clip.references
        ? times.flatMap((time) => clip.references![String(time)]!.map((patch) => patch.rgb)) : null;
      const difference = { yuvVsRgba: patchDifference(yuv, rgba),
        ...(reference ? { yuv: patchDifference(yuv, reference), rgba: patchDifference(rgba, reference) } : {}) };
      const worst = yuv.map((rgb, i) => ({ i, d: Math.max(...rgb.map((value, c) => Math.abs(value - rgba[i]![c]!))) }))
        .sort((a, b) => b.d - a.d).slice(0, 3)
        .map(({ i }) => ({ time: times[Math.floor(i / points.length)], point: RENDER_GRID[i % points.length]![0],
          yuv: yuv[i], rgba: rgba[i], reference: reference?.[i] ?? null }));
      Object.assign(entry, { times, difference, worst, patches: { yuv, rgba, reference },
        status: difference.yuvVsRgba.max <= 4 && (!reference || (difference.yuv!.max <= 8 && difference.rgba!.max <= 8))
          ? 'passed' : 'failed' });
    } catch (error) {
      Object.assign(entry, { status: 'failed', failure: error instanceof Error ? error.message : String(error) });
    }
    results.push(entry);
  }
  return results;
}

type Helpers = {
  fixtureDirectory: string;
  outputDirectory: () => Promise<string>;
  probe: (path: string) => Promise<unknown>;
  remove: (path: string) => Promise<unknown>;
  writeResult: (result: object) => Promise<void>;
  environment: Record<string, unknown>;
  /** Thermal state and power mode, recorded with each case. */
  sampleConditions?: () => Promise<unknown>;
  /** The frame pixel format of the cases that set none (the launchers' --frame-pixel-format). */
  framePixelFormat?: VideoFramePixelFormat;
  /** Only these cases, when given. */
  caseIds?: string[];
  /** Experiment, Android: a refresh rate vote cast while each preview plays (fps 0 takes it back). */
  frameRateVote?: { mode: string; vote: (mode: string, fps: number) => Promise<unknown> };
};

/** Runs every preview case, one mounted at a time, then every export, and writes one report. */
export function FrameSyncScreen({ helpers }: { helpers: Helpers }) {
  const selected = (id: string) => !helpers.caseIds?.length || helpers.caseIds.includes(id);
  const previewCases = useMemo(() => PREVIEW_CASES.filter((run) => selected(run.id) &&
    run.items.every((item) => hasFixture(item.fixture))),
    // Fixed for the run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);
  const [current, setCurrent] = React.useState(0);
  const [status, setStatus] = React.useState('Synchronisation des frames : lecture…');
  const previews = useRef<PreviewResult[]>([]);

  // A locked phone stops the vsyncs: report it at once rather than wait out the deadlines.
  useEffect(() => {
    let reported = false;
    const subscription = native.AppState.addEventListener('change', (state) => {
      if (state === 'active' || reported) return;
      reported = true;
      const failure = 'Interrupted: the app left the foreground (screen locked?)';
      setStatus(failure);
      helpers.writeResult({ schema: 1, kind: 'frame-sync-check', ...helpers.environment,
        status: 'failed', failure, previews: previews.current, exports: [] }).catch(() => undefined);
    });
    return () => subscription.remove();
  }, [helpers]);

  const onPreview = useCallback((result: PreviewResult) => {
    previews.current.push(result);
    setStatus(`${result.id} ${result.status}`);
    setCurrent((index) => index + 1);
  }, []);

  useEffect(() => {
    if (current < previewCases.length) return;
    (async () => {
      const outputDirectory = await helpers.outputDirectory();
      const exports = [];
      for (const run of EXPORT_CASES.filter((entry) => selected(entry.id))) {
        setStatus(`Synchronisation des frames : ${run.id}…`);
        exports.push(await runExport(run, helpers.fixtureDirectory, outputDirectory, helpers.probe, helpers.remove,
          helpers.framePixelFormat));
      }
      setStatus('Synchronisation des frames : couleurs YUV / RGBA…');
      const colors = selected('colors') ? await runColorCheck(helpers.fixtureDirectory) : [];
      setStatus('Synchronisation des frames : rendu des vrais médias…');
      const renders = selected('render') ? await runRenderCheck(helpers.fixtureDirectory) : [];
      const all = [...previews.current, ...exports, ...colors, ...renders.filter((entry) => entry.status !== 'skipped')];
      const passed = all.filter((entry) => entry.status === 'passed').length;
      await helpers.writeResult({ schema: 1, kind: 'frame-sync-check', ...helpers.environment,
        frameRateVote: helpers.frameRateVote?.mode ?? 'none',
        framePixelFormat: helpers.framePixelFormat ?? 'auto',
        status: passed === all.length ? 'passed' : 'failed', previews: previews.current, exports, colors, renders });
      setStatus(`Synchronisation des frames : ${passed}/${all.length} réussis — JSON sauvegardé.`);
    })().catch(async (error: unknown) => {
      const failure = error instanceof Error ? error.message : String(error);
      setStatus(failure);
      await helpers.writeResult({ schema: 1, kind: 'frame-sync-check', ...helpers.environment,
        status: 'failed', failure, previews: previews.current, exports: [] }).catch(() => undefined);
    });
  }, [current, helpers]);

  const run = previewCases[current];
  return <native.SafeAreaView style={{ padding: 20, gap: 12 }}>
    <native.Text>{status}</native.Text>
    {run && <PreviewProbe key={run.id} run={run} directory={helpers.fixtureDirectory}
      defaultFormat={helpers.framePixelFormat} frameRateVote={helpers.frameRateVote}
      sampleConditions={helpers.sampleConditions} onDone={onPreview} />}
  </native.SafeAreaView>;
}

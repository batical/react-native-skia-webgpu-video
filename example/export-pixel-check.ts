import { AlphaType, ColorType, Skia } from "react-native-skia";
import {
  __RNSkiaVideoPrivateAPI as nativeVideo,
  clearVideoFrameImages,
  drawVideoFrame,
  exportVideoComposition,
  getVideoResourceStats,
  makeVideoFrameImage,
} from "../src";
import type { VideoFrame } from "../src";

// Four asymmetric quadrants: a flipped or mirrored export lands each color in
// another corner, and a channel swap (RGBA/BGRA) turns red into blue.
const width = 640;
const height = 360;
const frameRate = 30;
const duration = 6 / frameRate;
const quadrants = [
  { name: "top-left", x: 0, y: 0, color: "#ff0000", rgb: [255, 0, 0] },
  { name: "top-right", x: 1, y: 0, color: "#00ff00", rgb: [0, 255, 0] },
  { name: "bottom-left", x: 0, y: 1, color: "#0000ff", rgb: [0, 0, 255] },
  { name: "bottom-right", x: 1, y: 1, color: "#ffffff", rgb: [255, 255, 255] },
] as const;
// Codec chroma subsampling and YUV range conversions move flat colors a bit;
// a misplaced quadrant is off by ~255 on at least one channel.
const colorTolerance = 48;
const pathTolerance = 6;

type Sample = { name: string; rgb: number[] };

// A decoded clip drawn full frame: the GPU export samples the decoder's YUV
// buffers in place, the readback export copies CPU-decoded frames. A rotated
// clip whose codec buffer is padded checks the crop and the turn as well.
const video = { file: "h264-1080p-rot90.mp4", width: 1080, height: 1920 };
const videoPatches = [[0.04, 0.04], [0.5, 0.04], [0.96, 0.04],
  [0.04, 0.5], [0.5, 0.5], [0.96, 0.5],
  [0.04, 0.96], [0.5, 0.96], [0.96, 0.96],
  [0.21, 0.5], [0.61, 0.5], [0.5, 0.21], [0.5, 0.61]] as const;
// Both files go through the same encoder and decoder: what is left is the
// input path, which a color conversion or a misplaced crop moves by far more.
const videoTolerance = 8;

async function exportPattern(outPath: string, fixtureDirectory: string, hardware: boolean) {
  // Interop off selects the CPU readback export: the reference transport.
  nativeVideo.configureNativeBufferInterop!(hardware);
  const backend = getVideoResourceStats().backend as Record<string, unknown> | null;
  await exportVideoComposition({
    videoComposition: {
      duration,
      lazyDecoders: true,
      // Decoded but not drawn: exercises the same input path as an app.
      items: [{
        id: "source",
        path: `${fixtureDirectory.replace(/\/$/, "")}/h264-638x358.mp4`,
        compositionStartTime: 0,
        startTime: 0,
        duration,
      }],
    },
    outPath,
    width,
    height,
    frameRate,
    bitRate: 4_000_000,
    codec: "h264",
    drawFrame: ({ canvas, width: targetWidth, height: targetHeight }) => {
      "worklet";
      const paint = Skia.Paint();
      for (const quadrant of quadrants) {
        paint.setColor(Skia.Color(quadrant.color));
        canvas.drawRect(Skia.XYWHRect(quadrant.x * targetWidth / 2,
          quadrant.y * targetHeight / 2, targetWidth / 2, targetHeight / 2), paint);
      }
    },
  });
  return { encodeTransport: backend?.encodeTransport ?? null, gpuDirectExport: backend?.gpuDirectExport ?? null };
}

async function exportVideo(outPath: string, fixtureDirectory: string, hardware: boolean) {
  nativeVideo.configureNativeBufferInterop!(hardware);
  const backend = getVideoResourceStats().backend as Record<string, unknown> | null;
  await exportVideoComposition({
    videoComposition: {
      duration,
      lazyDecoders: true,
      items: [{
        id: "source",
        path: `${fixtureDirectory.replace(/\/$/, "")}/${video.file}`,
        compositionStartTime: 0,
        startTime: 0.5,
        duration,
      }],
    },
    outPath,
    width: video.width,
    height: video.height,
    frameRate,
    bitRate: 16_000_000,
    codec: "h264",
    drawFrame: ({ canvas, frames, width: targetWidth, height: targetHeight }) => {
      "worklet";
      const frame = frames.source;
      if (frame)
        drawVideoFrame(canvas, frame, { x: 0, y: 0, width: targetWidth, height: targetHeight });
    },
  });
  return { encodeTransport: backend?.encodeTransport ?? null, gpuDirectExport: backend?.gpuDirectExport ?? null };
}

function sampleOutput(outPath: string, size = { width, height },
  points: readonly (readonly [number, number])[] = quadrants.map((quadrant) =>
    [(quadrant.x + 0.5) / 2, (quadrant.y + 0.5) / 2] as const)): Sample[] {
  nativeVideo.configureNativeBufferInterop!(true);
  const extractor = nativeVideo.createVideoCompositionFramesExtractorSync({
    duration, lazyDecoders: true,
    items: [{ id: "output", path: outPath, compositionStartTime: 0, startTime: 0,
      duration, textureMode: "copy" }],
  });
  const pending = new Set<VideoFrame>();
  try {
    extractor.start();
    const frames = extractor.decodeCompositionFrames(3 / frameRate);
    for (const frame of Object.values(frames)) pending.add(frame);
    const frame = frames.output;
    if (!frame) throw new Error("The exported file did not decode");
    if (frame.width !== size.width || frame.height !== size.height)
      throw new Error(`Exported ${frame.width}x${frame.height}, expected ${size.width}x${size.height}`);
    pending.delete(frame);
    const result = makeVideoFrameImage(frame);
    if (!result) throw new Error("Decoded export did not produce a Skia image");
    return points.map(([u, v]) => {
      const data = result.image.readPixels(
        Math.min(Math.max(Math.round(u * size.width) - 4, 0), size.width - 8),
        Math.min(Math.max(Math.round(v * size.height) - 4, 0), size.height - 8),
        { width: 8, height: 8, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
      );
      if (!(data instanceof Uint8Array) || data.length !== 8 * 8 * 4)
        throw new Error("Skia pixel readback failed");
      const rgb = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4)
        for (let c = 0; c < 3; c++) rgb[c]! += data[i + c]! / 64;
      return { name: `${u},${v}`, rgb: rgb.map(Math.round) };
    });
  } finally {
    extractor.dispose();
    for (const frame of pending) frame.dispose?.();
    clearVideoFrameImages(true);
  }
}

/** Exports one pattern through the GPU path and one through CPU readback,
 * decodes both, and checks quadrant colors and agreement. Diagnostic only. */
export async function runExportPixelCheck(fixtureDirectory: string, outputDirectory: string,
  remove: (path: string) => Promise<unknown>) {
  const gpuPath = `${outputDirectory}/export-pixels-gpu.mp4`;
  const cpuPath = `${outputDirectory}/export-pixels-readback.mp4`;
  const gpuVideoPath = `${outputDirectory}/export-video-gpu.mp4`;
  const cpuVideoPath = `${outputDirectory}/export-video-readback.mp4`;
  let failure: string | null = null;
  let gpu: { transport: unknown; samples: Sample[] } | null = null;
  let cpu: { transport: unknown; samples: Sample[] } | null = null;
  let gpuVideo: { transport: unknown; samples: Sample[] } | null = null;
  let cpuVideo: { transport: unknown; samples: Sample[] } | null = null;
  try {
    const gpuTransport = await exportPattern(gpuPath, fixtureDirectory, true);
    gpu = { transport: gpuTransport, samples: sampleOutput(gpuPath) };
    const cpuTransport = await exportPattern(cpuPath, fixtureDirectory, false);
    cpu = { transport: cpuTransport, samples: sampleOutput(cpuPath) };
    const gpuVideoTransport = await exportVideo(gpuVideoPath, fixtureDirectory, true);
    gpuVideo = { transport: gpuVideoTransport, samples: sampleOutput(gpuVideoPath, video, videoPatches) };
    const cpuVideoTransport = await exportVideo(cpuVideoPath, fixtureDirectory, false);
    cpuVideo = { transport: cpuVideoTransport, samples: sampleOutput(cpuVideoPath, video, videoPatches) };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    nativeVideo.configureNativeBufferInterop!(true);
    for (const path of [gpuPath, cpuPath, gpuVideoPath, cpuVideoPath])
      await remove(path).catch(() => undefined);
  }
  const expected = (samples: Sample[]) => samples.every((sample, index) =>
    sample.rgb.every((value, channel) =>
      Math.abs(value - quadrants[index]!.rgb[channel]!) <= colorTolerance));
  const difference = (a: { samples: Sample[] } | null, b: { samples: Sample[] } | null) =>
    a && b ? Math.max(...a.samples.flatMap((sample, index) =>
      sample.rgb.map((value, channel) => Math.abs(value - b.samples[index]!.rgb[channel]!)))) : null;
  const maxPathDifference = difference(gpu, cpu);
  const maxVideoPathDifference = difference(gpuVideo, cpuVideo);
  const usedGpu = (run: { transport: unknown } | null, expected: boolean) =>
    (run?.transport as { gpuDirectExport?: unknown } | undefined)?.gpuDirectExport === expected;
  const checks = {
    gpuTransportUsed: usedGpu(gpu, true),
    readbackTransportUsed: usedGpu(cpu, false),
    gpuColorsInPlace: gpu ? expected(gpu.samples) : false,
    readbackColorsInPlace: cpu ? expected(cpu.samples) : false,
    pathsAgree: maxPathDifference != null && maxPathDifference <= pathTolerance,
    videoTransportsUsed: usedGpu(gpuVideo, true) && usedGpu(cpuVideo, false),
    videoPathsAgree: maxVideoPathDifference != null && maxVideoPathDifference <= videoTolerance,
  };
  return { schema: 1, kind: "android-export-pixel-check",
    status: failure == null && Object.values(checks).every(Boolean) ? "passed" : "failed",
    failure, checks, maxPathDifference, maxVideoPathDifference, gpu, cpu, gpuVideo, cpuVideo,
    expected: quadrants.map(({ name, rgb }) => ({ name, rgb })),
    limits: ["Samples 8×8 patches of one decoded frame; not whole-image fidelity.",
      "Readback validation; not a performance measurement."] };
}

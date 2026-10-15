import { AlphaType, ColorType, Skia } from "react-native-skia";
import {
  __RNSkiaVideoPrivateAPI as nativeVideo,
  clearVideoFrameImages,
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

function sampleOutput(outPath: string): Sample[] {
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
    if (frame.width !== width || frame.height !== height)
      throw new Error(`Exported ${frame.width}x${frame.height}, expected ${width}x${height}`);
    pending.delete(frame);
    const result = makeVideoFrameImage(frame);
    if (!result) throw new Error("Decoded export did not produce a Skia image");
    return quadrants.map((quadrant) => {
      const data = result.image.readPixels(
        Math.round((quadrant.x + 0.5) * width / 2) - 4,
        Math.round((quadrant.y + 0.5) * height / 2) - 4,
        { width: 8, height: 8, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
      );
      if (!(data instanceof Uint8Array) || data.length !== 8 * 8 * 4)
        throw new Error("Skia pixel readback failed");
      const rgb = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4)
        for (let c = 0; c < 3; c++) rgb[c]! += data[i + c]! / 64;
      return { name: quadrant.name, rgb: rgb.map(Math.round) };
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
  let failure: string | null = null;
  let gpu: { transport: unknown; samples: Sample[] } | null = null;
  let cpu: { transport: unknown; samples: Sample[] } | null = null;
  try {
    const gpuTransport = await exportPattern(gpuPath, fixtureDirectory, true);
    gpu = { transport: gpuTransport, samples: sampleOutput(gpuPath) };
    const cpuTransport = await exportPattern(cpuPath, fixtureDirectory, false);
    cpu = { transport: cpuTransport, samples: sampleOutput(cpuPath) };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    nativeVideo.configureNativeBufferInterop!(true);
    for (const path of [gpuPath, cpuPath]) await remove(path).catch(() => undefined);
  }
  const expected = (samples: Sample[]) => samples.every((sample, index) =>
    sample.rgb.every((value, channel) =>
      Math.abs(value - quadrants[index]!.rgb[channel]!) <= colorTolerance));
  const maxPathDifference = gpu && cpu ? Math.max(...gpu.samples.flatMap((sample, index) =>
    sample.rgb.map((value, channel) => Math.abs(value - cpu!.samples[index]!.rgb[channel]!)))) : null;
  const checks = {
    gpuTransportUsed: gpu?.transport && (gpu.transport as { gpuDirectExport?: unknown }).gpuDirectExport === true,
    readbackTransportUsed: cpu?.transport && (cpu.transport as { gpuDirectExport?: unknown }).gpuDirectExport === false,
    gpuColorsInPlace: gpu ? expected(gpu.samples) : false,
    readbackColorsInPlace: cpu ? expected(cpu.samples) : false,
    pathsAgree: maxPathDifference != null && maxPathDifference <= pathTolerance,
  };
  return { schema: 1, kind: "android-export-pixel-check",
    status: failure == null && Object.values(checks).every(Boolean) ? "passed" : "failed",
    failure, checks, maxPathDifference, gpu, cpu,
    expected: quadrants.map(({ name, rgb }) => ({ name, rgb })),
    limits: ["Samples four 8×8 patches of one decoded frame; not whole-image fidelity.",
      "Readback validation; not a performance measurement."] };
}

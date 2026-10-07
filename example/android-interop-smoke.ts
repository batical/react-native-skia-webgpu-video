import { Platform } from "react-native";
import { AlphaType, ColorType } from "react-native-skia";
import {
  __RNSkiaVideoPrivateAPI as nativeVideo,
  clearVideoFrameImages,
  configureVideoMemory,
  getVideoResourceStats,
  makeVideoFrameImage,
} from "../src";
import type { VideoFrame, VideoTextureMode } from "../src";
import { getVideoGpuDevice } from "../src/gpuDevice";

type Fixture = { id: string; file: string; sha256: string };
type Picture = {
  width: number;
  height: number;
  rotation: number;
  timestamp: number;
  transport: string;
  pixels: number[];
};

// These tiny patches cover asymmetric positions across the entire decoded
// picture without allocating another full-resolution CPU image for validation.
const patches = [[0.04, 0.04], [0.5, 0.04], [0.96, 0.04],
  [0.04, 0.5], [0.5, 0.5], [0.96, 0.5],
  [0.04, 0.96], [0.5, 0.96], [0.96, 0.96],
  [0.21, 0.5], [0.61, 0.5], [0.5, 0.21], [0.5, 0.61]] as const;

function capture(frame: VideoFrame, expectedTransport: string, beginImport: () => void): Picture {
  const transport = (frame.texture as { kind?: string } | null)?.kind;
  if (transport !== expectedTransport)
    throw new Error(`Expected ${expectedTransport}, received ${transport}`);
  const timestamp = (frame as VideoFrame & { timestamp?: number }).timestamp;
  if (timestamp == null || !Number.isFinite(timestamp))
    throw new Error("Decoded timestamp is unavailable");
  beginImport();
  const result = makeVideoFrameImage(frame);
  if (!result) throw new Error("Decoded frame did not produce a Skia image");
  const pixels: number[] = [];
  for (const [u, v] of patches) {
    const data = result.image.readPixels(
      Math.floor((frame.width - 8) * u), Math.floor((frame.height - 8) * v),
      { width: 8, height: 8, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
    );
    if (!(data instanceof Uint8Array) || data.length !== 8 * 8 * 4)
      throw new Error("Skia pixel readback failed");
    for (const value of data) pixels.push(value);
  }
  return { width: result.width, height: result.height, rotation: result.rotation,
    timestamp, transport, pixels };
}

function decode(fixture: Fixture, directory: string, hardware: boolean, mode: VideoTextureMode) {
  nativeVideo.configureNativeBufferInterop!(hardware);
  const extractor = nativeVideo.createVideoCompositionFramesExtractorSync({
    duration: 2, lazyDecoders: true,
    items: [{ id: "source", path: `${directory.replace(/\/$/, "")}/${fixture.file}`,
      compositionStartTime: 0, startTime: 0, duration: 2, textureMode: mode }],
  });
  const pending = new Set<VideoFrame>();
  const next = (time: number) => {
    const frames = extractor.decodeCompositionFrames(time);
    for (const frame of Object.values(frames)) pending.add(frame);
    if (!frames.source) throw new Error(`Missing source at ${time}`);
    return frames.source;
  };
  const consume = (frame: VideoFrame) => {
    // Import owns cleanup even if its checked fence fails. Do not revoke its
    // quarantined source from this test's outer cleanup handler.
    return capture(frame, hardware ? "native-buffer" : "rgba", () => { pending.delete(frame); });
  };
  let operationError: unknown;
  try {
    extractor.start();
    const first = next(0.2);
    const later = consume(next(1.6));
    // A retained native frame must survive both a later decode and producer
    // teardown, before its first import into Skia.
    extractor.dispose();
    const retained = consume(first);
    return { retained, later, stats: getVideoResourceStats() };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    const cleanup = (action: () => void) => {
      try { action(); } catch (error) { cleanupError ??= error; }
    };
    cleanup(() => extractor.dispose());
    for (const frame of pending) cleanup(() => frame.dispose?.());
    cleanup(() => clearVideoFrameImages(true));
    if (cleanupError != null) {
      if (operationError == null) throw cleanupError;
      if (operationError instanceof Error)
        operationError.message += `; cleanup also failed: ${String(cleanupError)}`;
    }
  }
}

function compare(expected: Picture, actual: Picture) {
  const dimensions = expected.width === actual.width && expected.height === actual.height &&
    expected.rotation === actual.rotation;
  const timestamp = Math.abs(expected.timestamp - actual.timestamp) < 0.000001;
  let maxChannelError = 0;
  let errorsOverTolerance = 0;
  const colors = new Set<string>();
  for (let i = 0; i < expected.pixels.length; i++) {
    const delta = Math.abs(expected.pixels[i]! - (actual.pixels[i] ?? -1000));
    maxChannelError = Math.max(maxChannelError, delta);
    if (delta > 3) errorsOverTolerance++;
    if (i % 4 === 0) colors.add(expected.pixels.slice(i, i + 3)
      .map((channel) => Math.floor(channel / 32)).join(","));
  }
  const referenceHasColorDetail = colors.size >= 2;
  return { passed: dimensions && timestamp && referenceHasColorDetail &&
      expected.pixels.length === actual.pixels.length && errorsOverTolerance === 0,
    dimensions, timestamp, referenceHasColorDetail, maxChannelError, errorsOverTolerance,
    comparedChannels: expected.pixels.length };
}

/** Functional diagnostic only. Readback and forced transport selection are
 * deliberately outside every timed playback/export measurement. */
export async function runAndroidInteropSmoke(directory: string, fixtures: Fixture[],
  beforeCase: () => Promise<void>) {
  if (Platform.OS !== "android" || !nativeVideo.configureNativeBufferInterop)
    throw new Error("Android native-buffer diagnostic bindings are unavailable");
  const features = getVideoGpuDevice().features;
  const supported = features.has("shared-texture-memory-ahardware-buffer" as GPUFeatureName) &&
    features.has("shared-fence-sync-fd" as GPUFeatureName);
  if (!supported) throw new Error("The shared Skia device does not expose Android native-buffer import");
  configureVideoMemory({ maxBytes: 512 * 1024 * 1024 });
  const before = getVideoResourceStats();
  const results = [];
  let failure: string | null = null;
  let activeCase: string | null = null;
  try {
    for (const id of ["h264-638x358", "h264-1080p-rot90", "h264-1080x1920", "h264-4k30", "hevc-4k30"]) {
      const fixture = fixtures.find((entry) => entry.id === id);
      if (!fixture) throw new Error(`Missing fixture ${id}`);
      for (const mode of ["copy", "direct"] as const) {
        activeCase = `${id}/${mode}`;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await beforeCase();
        const cpu = decode(fixture, directory, false, mode);
        await beforeCase();
        const gpu = decode(fixture, directory, true, mode);
        await beforeCase();
        const retained = compare(cpu.retained, gpu.retained);
        const later = compare(cpu.later, gpu.later);
        const referenceChanges = cpu.retained.pixels.some((value, index) =>
          Math.abs(value - cpu.later.pixels[index]!) > 20);
        results.push({ fixture: id, sha256: fixture.sha256, mode,
          status: retained.passed && later.passed && referenceChanges ? "passed" : "failed",
          retained, later, referenceChanges,
          observedTransports: [cpu.retained.transport, gpu.retained.transport],
          dimensions: { width: gpu.retained.width, height: gpu.retained.height, rotation: gpu.retained.rotation } });
      }
    }
  } catch (error) {
    failure = `${activeCase ?? "setup"}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    nativeVideo.configureNativeBufferInterop(true);
  }
  return { schema: 1, kind: "android-ahardwarebuffer-pixel-comparison",
    status: failure == null && results.length === 10 && results.every((result) => result.status === "passed")
      ? "passed" : "failed",
    failure, plannedCases: 10, completedCases: results.length, results, before, after: getVideoResourceStats(),
    limits: ["Compares sampled decoded SDR pixels, not full-image fidelity or HDR.",
      "This validation reads GPU pixels; its runtime and memory are not performance measurements.",
      "Device memory and post-GC cleanup are qualified by the separate benchmark campaign."] };
}

import {
  drawVideoFrame,
  exportVideoComposition,
  getVideoResourceStats,
} from "../src";
import { createCubeOverlay } from "../examples/webgpu-overlay";

export type GpuSmokeProbe = {
  codec: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  frameCount: number;
  timestampsMonotonic: boolean;
  presentationTimesExact: boolean;
  firstPresentationTime: number;
  lastPresentationTime: number;
};

/** Call on RN after the preview has closed. Preserve the output for inspection.
 * This checks real 3D submission/export and tracked ownership; metadata alone
 * does not establish that the decoded pixels contain the expected cube. */
export async function runGpuSmoke({
  fixtureDirectory,
  outPath,
  probe,
  abortSignal,
}: {
  fixtureDirectory: string;
  outPath: string;
  probe: (path: string) => Promise<GpuSmokeProbe>;
  abortSignal?: AbortSignal;
}) {
  const width = 512;
  const height = 512;
  const frameRate = 30;
  const expectedFrames = 12;
  const duration = expectedFrames / frameRate;
  const before = getVideoResourceStats();
  const started = performance.now();
  const progress = { framesCompleted: 0, events: 0, valid: true };
  let actualOutput: GpuSmokeProbe | null = null;
  let encodeMs: number | null = null;
  let probeMs: number | null = null;
  let failure: string | null = null;
  try {
    if (!fixtureDirectory || !outPath) throw new Error("GPU smoke requires local input and output paths");
    const encodeStarted = performance.now();
    await exportVideoComposition({
      videoComposition: {
        duration,
        lazyDecoders: true,
        items: [{
          id: "gpu-smoke-source",
          path: `${fixtureDirectory.replace(/\/$/, "")}/h264-638x358.mp4`,
          compositionStartTime: 0,
          startTime: 0,
          duration,
          textureMode: "copy",
        }],
      },
      outPath,
      width,
      height,
      frameRate,
      bitRate: 2_000_000,
      codec: "h264",
      abortSignal,
      createFrameProcessor: ({ width: targetWidth, height: targetHeight }) => {
        "worklet";
        return createCubeOverlay({ width: targetWidth, height: targetHeight });
      },
      drawFrame: ({ canvas, frames, width: targetWidth, height: targetHeight }) => {
        "worklet";
        const overlay = frames["gpu-overlay"];
        if (!overlay) throw new Error("3D processor did not publish its GPU overlay");
        drawVideoFrame(canvas, overlay,
          { x: 0, y: 0, width: targetWidth, height: targetHeight });
      },
      onProgress: ({ framesCompleted, nbFrames }) => {
        progress.valid &&= Number.isInteger(framesCompleted) &&
          framesCompleted >= progress.framesCompleted && framesCompleted <= expectedFrames &&
          nbFrames === expectedFrames;
        progress.framesCompleted = framesCompleted;
        progress.events++;
      },
    });
    // The export resolves only after processor.dispose and the shared GPU fence.
    encodeMs = performance.now() - encodeStarted;
    const probeStarted = performance.now();
    actualOutput = await probe(outPath);
    probeMs = performance.now() - probeStarted;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const after = getVideoResourceStats();
  const checks = {
    progress: progress.valid && progress.framesCompleted === expectedFrames,
    outputDimensions: actualOutput?.width === width && actualOutput.height === height,
    outputCodec: actualOutput?.codec === "h264",
    outputFrames: actualOutput?.frameCount === expectedFrames,
    outputFrameRate: actualOutput != null && Math.abs(actualOutput.fps - frameRate) <= 0.01,
    outputDuration: actualOutput != null && Math.abs(actualOutput.duration - duration) <= 1 / frameRate + 0.001,
    outputTimestamps: actualOutput?.timestampsMonotonic === true &&
      actualOutput.presentationTimesExact === true &&
      Math.abs(actualOutput.firstPresentationTime) <= 0.001 &&
      Math.abs(actualOutput.lastPresentationTime - (expectedFrames - 1) / frameRate) <= 0.001,
    ownedReservations: before.budget != null && after.budget != null &&
      after.budget.currentBytes === before.budget.currentBytes &&
      after.budget.allocations === before.budget.allocations,
  };
  return {
    schema: 1,
    kind: "shared-device-webgpu-cube-export",
    status: failure == null && Object.values(checks).every(Boolean) ? "passed" : "failed",
    failure,
    outPath,
    requested: { width, height, frameRate, expectedFrames, duration, codec: "h264" },
    actualOutput,
    progress,
    checks,
    stats: { before, after },
    timing: { encodeMs, probeMs, elapsedMs: performance.now() - started },
    limits: [
      "Decoded cube pixels still require a pixel/color validator or visual inspection.",
      "Tracked reservations are allocation estimates, not physical GPU or process memory.",
      "This exercises 3D rendering; no Core ML inference is performed.",
    ],
  };
}

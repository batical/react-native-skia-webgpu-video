import {
  assertExportRecorderCacheSupport,
  trimExportRecorderCache,
} from "./exportCache";
import { getVideoCanvas } from "./canvas";
import {
  createWorkletRuntime,
  createSynchronizable,
  runOnRuntime,
  scheduleOnRN,
  type WorkletRuntime,
} from "react-native-worklets";
import { AlphaType, BlendMode, ColorType, Skia } from "react-native-skia";
import type { ImageInfo, SkCanvas, SkSurface } from "react-native-skia";
import { Platform } from "react-native";
import type {
  ExportOptions,
  FrameDrawer,
  VideoComposition,
  VideoEncoder,
  VideoCompositionFramesExtractorSync,
  VideoFrame,
} from "./types";
import RNSkiaVideoModule from "./RNSkiaVideoModule";
import {
  clearVideoFrameImages,
  ownVideoFrames,
  releaseVideoFrameImage,
} from "./frameInterop";
import {
  frameByteSize,
  releaseVideoMemory,
  reserveVideoMemory,
} from "./memory";
import { enqueueExport, exportAbortError } from "./exportQueue";
import {
  acquireEncoderTarget,
  closeEncoderTarget,
  probeEncoderTarget,
  supportsEncoderTargets,
  type EncoderTarget,
} from "./exportTarget";
import { yieldToRuntime } from "./runtimeYield";

export type VideoFrameProcessingContext = {
  frames: Record<string, VideoFrame>;
  currentTime: number;
  width: number;
  height: number;
  videoComposition: VideoComposition;
  isCancelled: () => boolean;
};

/** Optional per-export GPU, 3D or ML adapter. Construct resources on the
 * export runtime; the legacy draw callback stays synchronous. */
export type VideoFrameProcessor = {
  prepareFrame: (context: VideoFrameProcessingContext) => void | Promise<void>;
  /** Must finish every GPU/ML read before settling. A rejected cleanup is
   * conservatively retained and prevents another export on that runtime. */
  dispose: () => void | Promise<void>;
};

export type VideoExportArguments<T = undefined> = ExportOptions & {
  videoComposition: VideoComposition;
  drawFrame: FrameDrawer<T>;
  beforeDrawFrame?: () => T;
  afterDrawFrame?: (context: T) => void;
  onProgress?: (progress: {
    framesCompleted: number;
    nbFrames: number;
  }) => void;
  abortSignal?: AbortSignal;
  /** A worklet factory, initialized once. prepareFrame completes before
   * drawing; dispose completes before export resolves or rejects. */
  createFrameProcessor?: (context: {
    width: number;
    height: number;
    videoComposition: VideoComposition;
    isCancelled: () => boolean;
  }) => VideoFrameProcessor | Promise<VideoFrameProcessor>;
};

// Native Skia 3.0.6 accepts destination/stride in readPixels; its
// published Canvas type currently omits these arguments. Use only a private,
// full-length, zero-offset Uint8Array (the native implementation ignores offsets).
type ReadbackCanvas = {
  readPixels: (
    x: number,
    y: number,
    info: ImageInfo,
    destination: Uint8Array,
    bytesPerRow: number,
  ) => Uint8Array | Float32Array | null;
};

type ExportState = {
  encoder: VideoEncoder | null;
  extractor: VideoCompositionFramesExtractorSync | null;
  surface: SkSurface | null;
  canvas: SkCanvas | null;
  readback: Uint8Array | null;
  /** iOS: draw into a lent encoder buffer instead of reading pixels back. */
  gpu: boolean;
  target: EncoderTarget | null;
  frames: Record<string, VideoFrame>;
  processor: VideoFrameProcessor | null;
  pendingAfterDraw: (() => void) | null;
  reservations: number[];
  index: number;
  setupError?: unknown;
  poisoned?: boolean;
  hasRecorder?: boolean;
};

let exportRuntime: WorkletRuntime | null = null;
const getExportRuntime = () => {
  if (!exportRuntime)
    exportRuntime = createWorkletRuntime({ name: "RNSkiaWebGPUVideoExport" });
  return exportRuntime;
};

// The persistent worklet thread does not drain Apple autoreleased objects.
// Scope synchronous native/Skia work only: an async callback would return its
// Promise before that work finishes, so its later continuation needs its own
// synchronous scope.
const runWithVideoAutoreleasePool = <T>(fn: () => T): T => {
  "worklet";
  return (
    RNSkiaVideoModule.runWithAutoreleasePool ?? ((body: () => T) => body())
  )(fn);
};

/** Public drawing/timing contract preserved; one step is submitted at a time.
 * Native input and output queues, the shared budget and serialized exports
 * prevent slow GPU/codec/ML consumers from growing an unbounded frame backlog. */
export const exportVideoComposition = <T = undefined>(
  args: VideoExportArguments<T>,
): Promise<void> => enqueueExport(() => executeExport(args), args.abortSignal);

const executeExport = <T>(args: VideoExportArguments<T>): Promise<void> =>
  new Promise((resolve, reject) => {
    const {
      videoComposition,
      drawFrame,
      beforeDrawFrame,
      afterDrawFrame,
      onProgress,
      abortSignal,
      createFrameProcessor,
      ...options
    } = args;
    if (abortSignal?.aborted) {
      reject(exportAbortError(abortSignal));
      return;
    }
    let bytes: number;
    let nbFrames: number;
    try {
      bytes = frameByteSize(options.width, options.height);
      if (
        !Number.isFinite(options.frameRate) ||
        options.frameRate <= 0 ||
        !Number.isFinite(videoComposition.duration) ||
        videoComposition.duration <= 0 ||
        !Number.isFinite(options.bitRate) ||
        options.bitRate <= 0 ||
        !options.outPath
      ) {
        throw new Error("Invalid video export options");
      }
      nbFrames = Math.ceil(
        videoComposition.duration * options.frameRate - 1e-6,
      );
      if (!Number.isSafeInteger(nbFrames) || nbFrames <= 0)
        throw new Error("Invalid export frame count");
    } catch (error) {
      reject(error);
      return;
    }
    const cancelled = createSynchronizable(false);
    const onAbort = () => cancelled.setBlocking(true);
    abortSignal?.addEventListener("abort", onAbort);
    // Cancellation is observed in the worklet. Rejection happens after draining
    // and cleanup, so the caller may immediately retry/reuse its output path.
    const settle = (
      error: unknown,
      aborted: boolean,
      failed = error !== null,
    ) => {
      abortSignal?.removeEventListener("abort", onAbort);
      if (aborted) reject(exportAbortError(abortSignal));
      else if (failed) reject(error);
      else resolve();
    };
    let runtime: WorkletRuntime;
    try {
      runtime = getExportRuntime();
    } catch (error) {
      settle(error, cancelled.getBlocking(), true);
      return;
    }
    const bgra = Platform.OS === "ios";
    const gpuExport =
      bgra && RNSkiaVideoModule.getBackendInfo?.()?.gpuDirectExport === true;
    // Keep the export closure identity stable across frames. Recreating this
    // worklet per image makes Worklets reconstruct its entire captured graph
    // on the persistent runtime, including nested drawing/native functions.
    const step = () => {
      try {
        runOnRuntime(runtime, frameWorklet)();
      } catch (error) {
        settle(error, cancelled.getBlocking(), true);
      }
    };
    const frameWorklet = () => {
      "worklet";
      const storage = globalThis as typeof globalThis & {
        __rnskwgpuExport?: ExportState;
      };
      const state = storage.__rnskwgpuExport;
      if (!state) {
        scheduleOnRN(settle, new Error("Export state unavailable"), false);
        return;
      }
      const isCancelled = () => {
        "worklet";
        return cancelled.getBlocking();
      };
      const finish = async (
        error: unknown,
        aborted = false,
        failed = false,
      ) => {
        "worklet";
        const cleanup = { failure: error, failed, safeToRelease: true };
        // A rejected adapter drain cannot prove that it stopped reading
        // our pixels. Retain/account that session instead of recycling them.
        const clean = (fn: () => void) => {
          "worklet";
          try {
            runWithVideoAutoreleasePool(fn);
            return true;
          } catch (e) {
            if (!cleanup.failed) cleanup.failure = e;
            cleanup.failed = true;
            cleanup.safeToRelease = false;
            return false;
          }
        };
        // Submit any recording left by a drawing exception before an
        // adapter is allowed to destroy textures referenced by that canvas.
        clean(() => state.surface?.flush(true));
        clean(() => state.target?.surface?.flush(true));
        if (cleanup.safeToRelease && state.pendingAfterDraw) {
          if (clean(state.pendingAfterDraw)) state.pendingAfterDraw = null;
        }
        if (cleanup.safeToRelease) {
          try {
            await state.processor?.dispose();
            state.processor = null;
          } catch (e) {
            if (!cleanup.failed) cleanup.failure = e;
            cleanup.failed = true;
            cleanup.safeToRelease = false;
          }
        }
        if (clean(() => state.extractor?.dispose())) state.extractor = null;
        if (clean(() => state.encoder?.dispose())) state.encoder = null;
        if (cleanup.safeToRelease) {
          clean(() => state.surface?.flush(true));
          clean(() => state.target?.surface?.flush(true));
          if (cleanup.safeToRelease) {
            for (const frame of Object.values(state.frames))
              clean(() => frame.dispose?.());
            clean(() => clearVideoFrameImages(true));
          }
          if (cleanup.safeToRelease && clean(() => state.canvas?.dispose()))
            state.canvas = null;
          if (cleanup.safeToRelease && clean(() => state.surface?.dispose()))
            state.surface = null;
          const target = state.target;
          if (cleanup.safeToRelease && target) {
            if (clean(() => closeEncoderTarget(target))) state.target = null;
          }
        }
        // The export runtime is private and serialized. Its unused cache
        // need not survive a completed session; leave the shared Context
        // and the UI/runtime caches alone. A failed drain stays quarantined.
        if (cleanup.safeToRelease && state.hasRecorder) {
          if (clean(trimExportRecorderCache)) state.hasRecorder = false;
        }
        if (cleanup.safeToRelease) {
          for (let i = state.reservations.length - 1; i >= 0; i--) {
            if (clean(() => releaseVideoMemory(state.reservations[i]!)))
              state.reservations.splice(i, 1);
          }
        }
        if (cleanup.safeToRelease) {
          state.frames = {};
          state.readback = null;
          delete storage.__rnskwgpuExport;
        } else {
          // One retained session at most; subsequent exports fail before
          // allocating anything. Runtime teardown is the recovery boundary.
          state.poisoned = true;
          state.setupError = cleanup.failure;
        }
        scheduleOnRN(
          settle,
          cleanup.failure,
          aborted || isCancelled(),
          cleanup.failed,
        );
      };
      // One frame per call; true when another frame follows.
      const work = async (): Promise<boolean> => {
        "worklet";
        try {
          if ("setupError" in state) throw state.setupError;
          if (isCancelled()) {
            await finish(null, true);
            return false;
          }
          const time = state.index / options.frameRate;
          // Purge ended/closed producer images, including lazily opened clips.
          const owned = runWithVideoAutoreleasePool(() => {
            const decoded = state.extractor!.decodeCompositionFrames(time);
            const imported = ownVideoFrames(decoded);
            for (const [key, previous] of Object.entries(state.frames)) {
              if (
                !imported[key] ||
                imported[key]!.producerId !== previous.producerId
              )
                releaseVideoFrameImage(previous);
            }
            return imported;
          });
          state.frames = owned;
          await state.processor?.prepareFrame({
            frames: owned,
            currentTime: time,
            videoComposition,
            width: options.width,
            height: options.height,
            isCancelled,
          });
          if (isCancelled()) {
            await finish(null, true);
            return false;
          }
          const draw = () => {
            "worklet";
            if (state.gpu)
              state.target = acquireEncoderTarget(
                state.encoder!,
                options.width,
                options.height,
              );
            const target = state.target;
            const surface = target ? target.surface! : state.surface!;
            const canvas = target ? target.canvas! : state.canvas!;
            canvas.drawColor(Skia.Color("#00000000"), BlendMode.Clear);
            const context = beforeDrawFrame?.() as T;
            const drawn = {
              failed: false,
              failure: undefined as unknown,
              drained: false,
            };
            try {
              drawFrame({
                canvas,
                context,
                videoComposition,
                currentTime: time,
                frames: owned,
                width: options.width,
                height: options.height,
              });
              surface.flush(true);
              drawn.drained = true;
              if (target) {
                closeEncoderTarget(target);
                state.target = null;
                state.encoder!.encodeFrame(
                  { kind: "native-buffer", nativeBuffer: target.pointer },
                  time,
                );
              } else {
                const readbackCanvas = canvas as unknown as ReadbackCanvas;
                const pixels = readbackCanvas.readPixels(
                  0,
                  0,
                  {
                    width: options.width,
                    height: options.height,
                    colorType: bgra ? ColorType.BGRA_8888 : ColorType.RGBA_8888,
                    alphaType: AlphaType.Premul,
                  },
                  state.readback!,
                  options.width * 4,
                );
                if (
                  !(pixels instanceof Uint8Array) ||
                  pixels.byteLength !== bytes ||
                  pixels.byteOffset !== 0 ||
                  pixels.buffer !== state.readback!.buffer
                ) {
                  throw new Error("Video export pixel readback failed");
                }
                // Fallback: consumed synchronously by the bounded native pool.
                const storage =
                  pixels.byteOffset === 0 &&
                  pixels.buffer.byteLength === pixels.byteLength
                    ? pixels.buffer
                    : pixels.buffer.slice(
                        pixels.byteOffset,
                        pixels.byteOffset + pixels.byteLength,
                      );
                state.encoder!.encodeFrame(
                  {
                    kind: bgra ? "bgra" : "rgba",
                    data: storage,
                    width: options.width,
                    height: options.height,
                    bytesPerRow: options.width * 4,
                  },
                  time,
                );
              }
            } catch (error) {
              drawn.failed = true;
              drawn.failure = error;
            } finally {
              if (afterDrawFrame) {
                // The context may own a texture referenced by a recording
                // left behind by a thrown draw. Submit it before its owner
                // can destroy it; keep the callback/context if draining fails.
                if (!drawn.drained) {
                  try {
                    surface.flush(true);
                    drawn.drained = true;
                  } catch (error) {
                    if (!drawn.failed) drawn.failure = error;
                    drawn.failed = true;
                  }
                }
                const releaseContext = () => {
                  "worklet";
                  afterDrawFrame(context);
                };
                if (drawn.drained) {
                  try {
                    releaseContext();
                  } catch (error) {
                    if (!drawn.failed) drawn.failure = error;
                    drawn.failed = true;
                  }
                } else state.pendingAfterDraw = releaseContext;
              }
            }
            if (drawn.failed) throw drawn.failure;
          };
          runWithVideoAutoreleasePool(draw);
          state.index++;
          if (onProgress)
            scheduleOnRN(onProgress, {
              framesCompleted: state.index,
              nbFrames,
            });
          if (isCancelled()) {
            await finish(null, true);
            return false;
          }
          if (state.index === nbFrames) {
            runWithVideoAutoreleasePool(() => state.encoder!.finishWriting());
            await finish(null);
            return false;
          }
          return true;
        } catch (error) {
          await finish(error, false, true);
          return false;
        }
      };
      const run = async () => {
        "worklet";
        // Yield on this runtime between frames: GPU/ML promises still settle,
        // and a busy RN thread no longer paces the export.
        while (await work())
          await new Promise<void>((resolve) => yieldToRuntime(resolve));
      };
      void run();
    };
    try {
      runOnRuntime(runtime, () => {
        "worklet";
        const storage = globalThis as typeof globalThis & {
          __rnskwgpuExport?: ExportState;
        };
        if (storage.__rnskwgpuExport) {
          scheduleOnRN(
            settle,
            new Error(
              "Previous export cleanup failed; resources remain accounted. Restart the native runtime before exporting again.",
            ),
            false,
          );
          return;
        }
        const state: ExportState = {
          encoder: null,
          extractor: null,
          surface: null,
          canvas: null,
          readback: null,
          gpu: false,
          target: null,
          frames: {},
          processor: null,
          pendingAfterDraw: null,
          reservations: [],
          index: 0,
        };
        storage.__rnskwgpuExport = state;
        const setup = async () => {
          "worklet";
          try {
            if (cancelled.getBlocking()) {
              scheduleOnRN(step);
              return;
            }
            runWithVideoAutoreleasePool(() => {
              assertExportRecorderCacheSupport();
              const allocateReadback = () => {
                // Render target + transient full-frame CPU readback. Native decoder
                // and encoder reservations are additional entries in the same budget.
                state.reservations.push(
                  reserveVideoMemory(bytes, "export render target"),
                );
                state.reservations.push(
                  reserveVideoMemory(
                    bytes * 2,
                    "export reusable readback and transient raster",
                  ),
                );
                state.readback = new Uint8Array(bytes);
                state.hasRecorder = true;
                state.surface = Skia.Surface.MakeOffscreen(
                  options.width,
                  options.height,
                );
                if (!state.surface)
                  throw new Error("Cannot allocate export surface");
                state.canvas = getVideoCanvas(state.surface);
              };
              if (!gpuExport) allocateReadback();
              state.encoder = RNSkiaVideoModule.createVideoEncoder(
                {
                  ...options,
                  audioBitRate: options.audioBitRate ?? 128000,
                  audioSampleRate: options.audioSampleRate ?? 44100,
                  audioChannelCount: options.audioChannelCount ?? 2,
                },
                videoComposition,
              );
              state.encoder.prepare();
              if (gpuExport) {
                // Skia draws straight into the encoder's buffers; the probe
                // keeps devices without IOSurface interop on the readback path.
                state.hasRecorder = true;
                const failure = supportsEncoderTargets(state.encoder)
                  ? probeEncoderTarget(
                      state.encoder,
                      options.width,
                      options.height,
                    )
                  : new Error("Encoder cannot lend frame buffers");
                state.gpu = failure === null;
                if (!state.gpu) {
                  console.warn(
                    "[react-native-skia-webgpu-video] GPU export unavailable, using CPU readback:",
                    String(failure),
                  );
                  allocateReadback();
                }
              }
              state.extractor =
                RNSkiaVideoModule.createVideoCompositionFramesExtractorSync(
                  videoComposition,
                );
              state.extractor.start();
            });
            state.processor =
              (await createFrameProcessor?.({
                width: options.width,
                height: options.height,
                videoComposition,
                isCancelled: () => {
                  "worklet";
                  return cancelled.getBlocking();
                },
              })) ?? null;
          } catch (error) {
            // Reuse the ordinary cleanup step, retaining the original error.
            state.setupError = error;
          }
          scheduleOnRN(step);
        };
        void setup();
      })();
    } catch (error) {
      settle(error, cancelled.getBlocking(), true);
    }
  });

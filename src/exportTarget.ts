/// <reference types="@webgpu/types" />
import { Platform } from "react-native";
import { BlendMode, Skia } from "react-native-skia";
import type { SkCanvas, SkSurface } from "react-native-skia";
import type {
  GPUSharedTextureMemory,
  GPUSharedTextureMemoryDescriptor,
  NativeVideoFrame,
} from "react-native-webgpu";
import { getVideoCanvas } from "./canvas";
import { createNativeVideoGpuFrame, getVideoGpuDevice } from "./gpuDevice";
import type { VideoEncoder } from "./types";

/** An encoder pool buffer that Skia draws into through WebGPU. */
export type EncoderTarget = {
  pointer: bigint;
  /** Android: sync-fds ending the GPU access, handed over to the encoder. */
  fences: bigint[];
  frame: NativeVideoFrame | null;
  memory: GPUSharedTextureMemory | null;
  texture: GPUTexture | null;
  accessing: boolean;
  surface: SkSurface | null;
  canvas: SkCanvas | null;
};

// Captured on the RN runtime. iOS lends CVPixelBuffers, imported through
// their IOSurface; Android lends the AHardwareBuffer itself.
const lendsPixelBuffers = Platform.OS === "ios";

type SharedMemoryDevice = GPUDevice & {
  importSharedTextureMemory?: (
    descriptor: GPUSharedTextureMemoryDescriptor,
  ) => GPUSharedTextureMemory;
};

export const supportsEncoderTargets = (encoder: VideoEncoder): boolean => {
  "worklet";
  return (
    typeof encoder.acquireFrameBuffer === "function" &&
    typeof encoder.releaseFrameBuffer === "function"
  );
};

// Declared before its callers: worklets capture their closure on creation.
/** Ends GPU access; the lent buffer stays with the caller, to encode or
 * release. Call only after a checked flush(true) of its surface. With
 * `encoding`, Android keeps the access's sync-fds in `target.fences` for the
 * encoder, which owns and closes them: ending an AHB access submits a
 * release that flush(true) has not waited for. */
export const closeEncoderTarget = (
  target: EncoderTarget,
  encoding = false,
): void => {
  "worklet";
  target.canvas?.dispose();
  target.canvas = null;
  target.surface?.dispose();
  target.surface = null;
  if (target.accessing && target.memory && target.texture) {
    const ended = target.memory.endAccess(target.texture);
    target.accessing = false;
    for (const state of ended?.fences ?? []) {
      try {
        if (encoding && !lendsPixelBuffers) {
          const exported = state.fence.export();
          // Unreachable when negotiated: AHB interop requires the device's
          // only shared-fence feature to be sync-fd (see gpuDevice.ts).
          if (exported.type !== "sync-fd")
            throw new Error("GPU export needs sync-fd fences");
          target.fences.push(exported.handle);
        }
      } finally {
        // iOS: already waited for. The wrapper is released either way.
        state.fence.destroy();
      }
    }
  }
  target.accessing = false;
  target.texture?.destroy();
  target.texture = null;
  // Close the IOSurface import now rather than at the export runtime's next
  // GC, so the encoder's bounded pool gets the buffer back promptly.
  target.memory?.destroy();
  target.memory = null;
  // Drop the IOSurface promptly so the pool can recycle it.
  target.frame?.release();
  target.frame = null;
};

/** Lends the next pool buffer and wraps it as a Skia surface. */
export const acquireEncoderTarget = (
  encoder: VideoEncoder,
  width: number,
  height: number,
): EncoderTarget => {
  "worklet";
  const target: EncoderTarget = {
    pointer: encoder.acquireFrameBuffer!(),
    fences: [],
    frame: null,
    memory: null,
    texture: null,
    accessing: false,
    surface: null,
    canvas: null,
  };
  try {
    if (lendsPixelBuffers) {
      target.frame = createNativeVideoGpuFrame(target.pointer);
      if (
        target.frame.width !== width ||
        target.frame.height !== height ||
        target.frame.pixelFormat !== "bgra8"
      ) {
        throw new Error("Encoder buffer dimensions or BGRA layout mismatch");
      }
    }
    const device = getVideoGpuDevice() as SharedMemoryDevice;
    if (typeof device.importSharedTextureMemory !== "function") {
      throw new Error("WebGPU shared texture memory is unavailable");
    }
    target.memory = device.importSharedTextureMemory({
      handle: target.frame ? target.frame.handle : target.pointer,
      label: "video export frame",
    });
    target.texture = target.memory.createTexture();
    if (
      !lendsPixelBuffers &&
      (target.texture.width !== width ||
        target.texture.height !== height ||
        target.texture.format !== "rgba8unorm")
    ) {
      throw new Error("Encoder buffer dimensions or RGBA layout mismatch");
    }
    // Uninitialized: every frame starts with a full clear.
    target.memory.beginAccess(target.texture, false);
    target.accessing = true;
    target.surface = Skia.Surface.MakeFromGPUTexture(target.texture);
    if (!target.surface) throw new Error("Cannot wrap the encoder buffer");
    target.canvas = getVideoCanvas(target.surface);
    return target;
  } catch (error) {
    try {
      closeEncoderTarget(target);
      encoder.releaseFrameBuffer!();
    } catch {
      /* the encoder releases its lent buffer on dispose */
    }
    throw error;
  }
};

/** Clears one lent buffer on the GPU, then returns it unencoded. Returns the
 * failure, or null when this device can export through encoder targets. */
export const probeEncoderTarget = (
  encoder: VideoEncoder,
  width: number,
  height: number,
): unknown => {
  "worklet";
  let target: EncoderTarget;
  try {
    target = acquireEncoderTarget(encoder, width, height);
  } catch (error) {
    return error ?? new Error("GPU export target unavailable");
  }
  let failure: unknown = null;
  try {
    target.canvas!.drawColor(Skia.Color("#00000000"), BlendMode.Clear);
    target.surface!.flush(true);
  } catch (error) {
    failure = error ?? new Error("GPU export probe failed");
  }
  // Not caught: an access that cannot end must fail the export, not fall back.
  closeEncoderTarget(target);
  encoder.releaseFrameBuffer!();
  return failure;
};

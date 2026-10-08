/// <reference types="@webgpu/types" />
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

/** An encoder pool buffer that Skia draws into through WebGPU (iOS). */
export type EncoderTarget = {
  pointer: bigint;
  frame: NativeVideoFrame | null;
  memory: GPUSharedTextureMemory | null;
  texture: GPUTexture | null;
  accessing: boolean;
  surface: SkSurface | null;
  canvas: SkCanvas | null;
};

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
 * release. Call only after a checked flush(true) of its surface. */
export const closeEncoderTarget = (target: EncoderTarget): void => {
  "worklet";
  target.canvas?.dispose();
  target.canvas = null;
  target.surface?.dispose();
  target.surface = null;
  if (target.accessing && target.memory && target.texture) {
    target.memory.endAccess(target.texture);
  }
  target.accessing = false;
  target.texture?.destroy();
  target.texture = null;
  target.memory = null;
  // Drop the IOSurface promptly so the pool can recycle it.
  target.frame?.release();
  target.frame = null;
};

/** Lends the next pool buffer and wraps its IOSurface as a Skia surface. */
export const acquireEncoderTarget = (
  encoder: VideoEncoder,
  width: number,
  height: number,
): EncoderTarget => {
  "worklet";
  const target: EncoderTarget = {
    pointer: encoder.acquireFrameBuffer!(),
    frame: null,
    memory: null,
    texture: null,
    accessing: false,
    surface: null,
    canvas: null,
  };
  try {
    target.frame = createNativeVideoGpuFrame(target.pointer);
    if (
      target.frame.width !== width ||
      target.frame.height !== height ||
      target.frame.pixelFormat !== "bgra8"
    ) {
      throw new Error("Encoder buffer dimensions or BGRA layout mismatch");
    }
    const device = getVideoGpuDevice() as SharedMemoryDevice;
    if (typeof device.importSharedTextureMemory !== "function") {
      throw new Error("WebGPU shared texture memory is unavailable");
    }
    target.memory = device.importSharedTextureMemory({
      handle: target.frame.handle,
      label: "video export frame",
    });
    target.texture = target.memory.createTexture();
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

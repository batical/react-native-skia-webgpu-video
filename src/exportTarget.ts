/// <reference types="@webgpu/types" />
import { BlendMode, Skia } from "react-native-skia";
import type { SkCanvas, SkSurface } from "react-native-skia";
import type {
  GPUSharedTextureMemory,
  GPUSharedTextureMemoryDescriptor,
  NativeVideoFrame,
  RNCanvasContext,
} from "react-native-webgpu";
import { getVideoCanvas } from "./canvas";
import {
  createNativeVideoGpuFrame,
  createNativeWindowGpuContext,
  encoderWindowTextureUsage,
  getVideoGpuDevice,
  nativeVideoTextureUsage,
} from "./gpuDevice";
import {
  frameByteSize,
  releaseVideoMemory,
  reserveVideoMemory,
} from "./memory";
import type { VideoEncoder } from "./types";

/** A texture Skia draws an exported frame into through WebGPU: a lent
 * encoder pool buffer on iOS, one of the encoder window's own textures on
 * Android. */
export type EncoderTarget = {
  /** iOS: the lent CVPixelBuffer. */
  pointer: bigint | null;
  frame: NativeVideoFrame | null;
  memory: GPUSharedTextureMemory | null;
  texture: GPUTexture | null;
  accessing: boolean;
  surface: SkSurface | null;
  canvas: SkCanvas | null;
};

/** Android: a canvas context presenting to the codec's input Surface. Skia
 * draws each frame into one of two textures of our own, which a GPU copy then
 * puts into the window's texture. The window's textures are the codec's
 * input buffers: the copy waits on the GPU for the codec to hand one back,
 * while the export goes on with the next frame, rather than the frame's
 * checked wait. */
export type EncoderWindow = {
  context: RNCanvasContext;
  device: GPUDevice;
  configured: boolean;
  /** Drawn into in turn, each copied into the window after its frame. */
  slots: EncoderTarget[];
  next: number;
  reservations: number[];
  /** The window texture the probe acquired, the first frame's copy target. */
  pending: GPUTexture | null;
};

const windowSlots = 2;

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
/** iOS: ends GPU access; the lent buffer stays with the caller, to encode or
 * release. Call only after a checked flush(true) of its surface. */
export const closeEncoderTarget = (target: EncoderTarget): void => {
  "worklet";
  // Disposing the surface detaches its canvas.
  target.canvas = null;
  target.surface?.dispose();
  target.surface = null;
  if (target.accessing && target.memory && target.texture) {
    const ended = target.memory.endAccess(target.texture);
    target.accessing = false;
    // Already waited for. The wrappers are released either way.
    for (const state of ended?.fences ?? []) state.fence.destroy();
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

/** iOS: lends the next pool buffer and wraps it as a Skia surface. */
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
    target.frame = createNativeVideoGpuFrame(target.pointer!);
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

/** iOS: clears one lent buffer on the GPU, then returns it unencoded.
 * Returns the failure, or null when this device can export through encoder
 * targets. */
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

/** Android: the window's next texture, checked against the export size. */
const windowTexture = (
  window: EncoderWindow,
  width: number,
  height: number,
): GPUTexture => {
  "worklet";
  const texture = window.pending ?? window.context.getCurrentTexture();
  window.pending = null;
  if (
    texture.width !== width ||
    texture.height !== height ||
    texture.format !== "rgba8unorm"
  ) {
    throw new Error("Encoder window dimensions or RGBA layout mismatch");
  }
  return texture;
};

/** Android: the slot the next frame draws into. Its previous copy completed:
 * the checked wait the export makes before each frame's import covers the
 * queue before it. */
export const acquireWindowTarget = (window: EncoderWindow): EncoderTarget => {
  "worklet";
  return window.slots[window.next]!;
};

/** Android: copies the slot Skia drew into to the window's next texture and
 * hands it to the encoder, with its time. Call once the slot's surface was
 * flushed: the copy follows the drawing on the same queue. */
export const presentWindowTarget = (
  encoder: VideoEncoder,
  window: EncoderWindow,
  target: EncoderTarget,
  time: number,
): void => {
  "worklet";
  const source = target.texture!;
  const destination = windowTexture(window, source.width, source.height);
  const commands = window.device.createCommandEncoder({
    label: "video export window copy",
  });
  commands.copyTextureToTexture(
    { texture: source },
    { texture: destination },
    { width: source.width, height: source.height },
  );
  window.device.queue.submit([commands.finish()]);
  window.next = (window.next + 1) % window.slots.length;
  // The encoder sets the frame's time on the window, then presents.
  encoder.encodeFrame(
    { kind: "window", present: () => window.context.present() },
    time,
  );
};

/** Android: the swapchain gives the codec its buffers back at once, rather
 * than once the context is collected. Call before disposing the encoder. */
export const closeEncoderWindow = (window: EncoderWindow): void => {
  "worklet";
  window.pending = null;
  if (!window.configured) return;
  window.context.unconfigure();
  window.configured = false;
};

/** Android: frees the window's own textures. Call once their last recording
 * was submitted: a copy still in flight keeps its source alive. */
export const releaseEncoderWindow = (window: EncoderWindow): void => {
  "worklet";
  while (window.slots.length) {
    const slot = window.slots[window.slots.length - 1]!;
    // Disposing the surface detaches its canvas.
    slot.canvas = null;
    slot.surface?.dispose();
    slot.surface = null;
    slot.texture?.destroy();
    slot.texture = null;
    window.slots.pop();
  }
  while (window.reservations.length) {
    releaseVideoMemory(window.reservations[window.reservations.length - 1]!);
    window.reservations.pop();
  }
};

/** Android: opens a canvas context on the encoder's input window with its
 * slots, acquires the window's first texture and draws a clear into the
 * first slot: nothing reaches the encoder. Returns the window, or the
 * failure, after which the window is closed and the export can fall back to
 * readback. */
export const probeEncoderWindow = (
  encoder: VideoEncoder,
  width: number,
  height: number,
): { window: EncoderWindow | null; failure: unknown } => {
  "worklet";
  let window: EncoderWindow | null = null;
  let failure: unknown = null;
  try {
    if (typeof encoder.acquireInputWindow !== "function")
      throw new Error("Encoder cannot present through its input window");
    const device = getVideoGpuDevice();
    window = {
      context: createNativeWindowGpuContext(
        encoder.acquireInputWindow(),
        width,
        height,
      ),
      device,
      configured: false,
      slots: [],
      next: 0,
      reservations: [],
      pending: null,
    };
    // Presented in FIFO order, opaque: every frame reaches the codec.
    window.context.configure({
      device,
      format: "rgba8unorm",
      usage: encoderWindowTextureUsage,
    });
    window.configured = true;
    for (let i = 0; i < windowSlots; i++) {
      window.reservations.push(
        reserveVideoMemory(frameByteSize(width, height), "export window slot"),
      );
      const slot: EncoderTarget = {
        pointer: null,
        frame: null,
        memory: null,
        texture: device.createTexture({
          label: "video export window slot",
          size: { width, height },
          format: "rgba8unorm",
          usage: nativeVideoTextureUsage,
        }),
        accessing: false,
        surface: null,
        canvas: null,
      };
      window.slots.push(slot);
      slot.surface = Skia.Surface.MakeFromGPUTexture(slot.texture!);
      if (!slot.surface) throw new Error("Cannot wrap the export frame");
      slot.canvas = getVideoCanvas(slot.surface);
    }
    window.pending = windowTexture(window, width, height);
    const target = acquireWindowTarget(window);
    target.canvas!.drawColor(Skia.Color("#00000000"), BlendMode.Clear);
    target.surface!.flush(true);
  } catch (error) {
    failure = error ?? new Error("GPU export probe failed");
  }
  if (failure === null) return { window, failure };
  if (window) {
    // Not caught: a window still drawn by WebGPU cannot fall back to EGL.
    closeEncoderWindow(window);
    releaseEncoderWindow(window);
  }
  return { window: null, failure };
};

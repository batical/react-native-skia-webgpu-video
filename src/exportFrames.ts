/// <reference types="@webgpu/types" />
import { Skia } from "react-native-skia";
import type { SkImage } from "react-native-skia";
import type {
  GPUSharedTextureMemory,
  GPUSharedTextureMemoryDescriptor,
  NativeVideoFrame,
} from "react-native-webgpu";
import { createNativeVideoGpuFrame, getVideoGpuDevice } from "./gpuDevice";
import type { VideoFrame } from "./types";

/** A decoded iOS frame sampled in place through its IOSurface: no blit, no
 * owned snapshot. The decoder lease stays open while the image is in use. */
export type ExportFrameImport = {
  id: number;
  frame: VideoFrame;
  nativeFrame: NativeVideoFrame | null;
  memory: GPUSharedTextureMemory | null;
  texture: GPUTexture | null;
  accessing: boolean;
  image: SkImage | null;
};

/** Per export session, keyed by producer. `enabled` turns off after a first
 * failed import, before any frame was sampled in place. */
export type ExportFrameImports = {
  entries: Map<number, ExportFrameImport>;
  /** Producers sampled in place; frameInterop never caches their frames. */
  producers: Set<number>;
  enabled: boolean;
  imported: boolean;
};

type SharedMemoryDevice = GPUDevice & {
  importSharedTextureMemory?: (
    descriptor: GPUSharedTextureMemoryDescriptor,
  ) => GPUSharedTextureMemory;
};

type NativeBufferTexture = { kind: "native-buffer"; nativeBuffer: bigint };

export const createExportFrameImports = (): ExportFrameImports => {
  "worklet";
  return {
    entries: new Map(),
    producers: new Set(),
    enabled: true,
    imported: false,
  };
};

/** Decoder frames this path can sample in place; others use frameInterop. */
export const canImportInPlace = (frame: VideoFrame): boolean => {
  "worklet";
  const texture = frame.texture as { kind?: string } | null | undefined;
  return texture?.kind === "native-buffer" && frame.id !== undefined;
};

// Declared before its callers: worklets capture their closure on creation.
/** Call only once every recording sampling the image has completed (a
 * checked flush(true)). An access that cannot end throws: the export must
 * then keep the lease and fail rather than recycle a buffer still in use. */
export const releaseExportFrame = (entry: ExportFrameImport): void => {
  "worklet";
  entry.image?.dispose();
  entry.image = null;
  if (entry.accessing && entry.memory && entry.texture) {
    const ended = entry.memory.endAccess(entry.texture);
    entry.accessing = false;
    for (const state of ended?.fences ?? []) state.fence.destroy();
  }
  entry.accessing = false;
  entry.texture?.destroy();
  entry.texture = null;
  entry.memory?.destroy();
  entry.memory = null;
  entry.nativeFrame?.release();
  entry.nativeFrame = null;
  entry.frame.dispose?.();
};

/** Wraps a decoded BGRA CVPixelBuffer's IOSurface as a Skia image, read-only.
 * The decoder already finished writing it; no producer fence is needed. */
export const importExportFrame = (frame: VideoFrame): ExportFrameImport => {
  "worklet";
  const entry: ExportFrameImport = {
    id: frame.id!,
    frame,
    nativeFrame: null,
    memory: null,
    texture: null,
    accessing: false,
    image: null,
  };
  try {
    const texture = frame.texture as NativeBufferTexture;
    entry.nativeFrame = createNativeVideoGpuFrame(texture.nativeBuffer);
    if (
      entry.nativeFrame.width !== frame.width ||
      entry.nativeFrame.height !== frame.height ||
      entry.nativeFrame.pixelFormat !== "bgra8"
    ) {
      throw new Error("Native video buffer dimensions or BGRA layout mismatch");
    }
    const device = getVideoGpuDevice() as SharedMemoryDevice;
    if (typeof device.importSharedTextureMemory !== "function") {
      throw new Error("WebGPU shared texture memory is unavailable");
    }
    entry.memory = device.importSharedTextureMemory({
      handle: entry.nativeFrame.handle,
      label: "video export source frame",
    });
    entry.texture = entry.memory.createTexture();
    entry.memory.beginAccess(entry.texture, true);
    entry.accessing = true;
    entry.image = Skia.Image.MakeImageFromGPUTexture(entry.texture);
    if (!entry.image) throw new Error("Cannot wrap the decoded frame");
    return entry;
  } catch (error) {
    // Nothing was submitted: closing this access cannot race the GPU. The
    // lease stays with the caller, which still owns the decoded frame.
    try {
      entry.image?.dispose();
      entry.image = null;
      if (entry.accessing && entry.memory && entry.texture) {
        const ended = entry.memory.endAccess(entry.texture);
        for (const state of ended?.fences ?? []) state.fence.destroy();
      }
      entry.accessing = false;
      entry.texture?.destroy();
      entry.memory?.destroy();
      entry.nativeFrame?.release();
    } catch {
      /* the native wrappers close with their JS objects */
    }
    throw error;
  }
};

/** Releases every in-place frame; the last GPU recording must have completed. */
export const releaseExportFrames = (imports: ExportFrameImports): void => {
  "worklet";
  for (const [producer, entry] of imports.entries) {
    releaseExportFrame(entry);
    imports.entries.delete(producer);
  }
};

/** The export counterpart of ownVideoFrames on iOS: decoded frames are drawn
 * in place, and a producer's previous frame is released once its next one is
 * imported, since every exported frame ends with a checked GPU wait. Other
 * frames, or every frame after a first failed import, use `fallback`. */
export const ownExportFrames = (
  imports: ExportFrameImports,
  decoded: Record<string, VideoFrame>,
  fallback: (frames: Record<string, VideoFrame>) => Record<string, VideoFrame>,
): Record<string, VideoFrame> => {
  "worklet";
  const owned: Record<string, VideoFrame> = {};
  const held = new Set<VideoFrame>();
  const current = new Map<number, number>();
  try {
    for (const [key, frame] of Object.entries(decoded)) {
      if (!imports.enabled || !canImportInPlace(frame)) continue;
      const producer = frame.producerId ?? frame.id!;
      const seen = current.get(producer);
      if (seen !== undefined && seen !== frame.id) {
        throw new Error(
          "Composition yielded different frames for one producer; stable native frame identities are required",
        );
      }
      let entry = imports.entries.get(producer);
      // The extractor hands back the same native frame while a clip holds
      // its picture: that lease is still ours, keep sampling it.
      if (entry?.id !== frame.id) {
        let next: ExportFrameImport;
        try {
          next = importExportFrame(frame);
        } catch (error) {
          if (imports.imported) throw error;
          imports.enabled = false;
          console.warn(
            "[react-native-skia-webgpu-video] In-place frame import unavailable, copying decoded frames:",
            String(error),
          );
          continue;
        }
        imports.imported = true;
        if (entry) {
          try {
            releaseExportFrame(entry);
          } catch (error) {
            // Keep the unreleased entry tracked; the new one was never used.
            try {
              releaseExportFrame(next);
            } catch {
              /* nothing was submitted with it */
            }
            throw error;
          }
        }
        imports.entries.set(producer, next);
        imports.producers.add(producer);
        entry = next;
      }
      held.add(frame);
      current.set(producer, frame.id!);
      owned[key] = {
        width: frame.width,
        height: frame.height,
        rotation: frame.rotation,
        crop: frame.crop,
        id: frame.id,
        producerId: producer,
        texture: { kind: "skia-image", image: entry!.image! },
      };
    }
    // Clips that left the composition. A failed release stays tracked.
    for (const [producer, entry] of imports.entries) {
      if (current.has(producer)) continue;
      releaseExportFrame(entry);
      imports.entries.delete(producer);
    }
  } catch (error) {
    // Close the leases this call does not hold; none reached the fallback.
    for (const frame of Object.values(decoded)) {
      if (held.has(frame)) continue;
      const producer = frame.producerId ?? frame.id;
      const entry =
        producer === undefined ? undefined : imports.entries.get(producer);
      if (entry && entry.id === frame.id) continue;
      try {
        frame.dispose?.();
      } catch {
        /* the native frame closes with its JS object */
      }
    }
    throw error;
  }
  // The fallback owns, closes or retains every frame it is handed.
  const rest: Record<string, VideoFrame> = {};
  let copying = false;
  for (const [key, frame] of Object.entries(decoded)) {
    if (held.has(frame)) continue;
    rest[key] = frame;
    copying = true;
  }
  return copying ? { ...owned, ...fallback(rest) } : owned;
};

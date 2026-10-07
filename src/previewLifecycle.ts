import type { SkCanvas, SkImage, SkSurface } from "react-native-skia";
import { releaseVideoFrameImage } from "./frameInterop";
import { releaseVideoMemory } from "./memory";
import type { VideoFrame } from "./types";

type PreviewResources = {
  surface?: SkSurface | null;
  canvas?: SkCanvas | null;
  images?: Array<SkImage | null>;
  frames?: VideoFrame[];
  reservation?: number;
  afterDraw?: (() => void) | null;
  native?: { dispose: () => void } | null;
};

/** Private UI-runtime quarantine. Detach consumers before calling this helper.
 * A failed drain keeps every potentially referenced resource and its accounting
 * alive until runtime teardown; native codecs can still close independently. */
export const disposePreviewResources = (resources: PreviewResources) => {
  "worklet";
  const failure = { failed: false, error: undefined as unknown };
  try {
    resources.surface?.flush(true);
    resources.afterDraw?.();
    resources.afterDraw = null;
    while (resources.images?.length) {
      resources.images[0]?.dispose();
      resources.images.shift();
    }
    while (resources.frames?.length) {
      const frame = resources.frames[0]!;
      releaseVideoFrameImage(frame);
      frame.dispose?.();
      resources.frames.shift();
    }
    resources.canvas?.dispose();
    resources.canvas = null;
    resources.surface?.dispose();
    resources.surface = null;
    releaseVideoMemory(resources.reservation ?? 0);
    resources.reservation = 0;
  } catch (error) {
    failure.failed = true;
    failure.error = error;
  }
  try {
    resources.native?.dispose();
    resources.native = null;
  } catch (error) {
    if (!failure.failed) failure.error = error;
    failure.failed = true;
  }
  if (failure.failed) {
    const runtime = globalThis as typeof globalThis & {
      __rnskwgpuPreviewQuarantine?: PreviewResources[];
    };
    (runtime.__rnskwgpuPreviewQuarantine ??= []).push(resources);
  }
  return failure;
};

import RNSkiaVideoModule from "./RNSkiaVideoModule";

export type VideoMemoryStats = {
  currentBytes: number;
  peakBytes: number;
  allocations: number;
  maxBytes: number;
};

/** Limits library-owned reservations across preview and export runtimes.
 * Driver/codec caches must additionally be measured on the device. */
export const configureVideoMemory = ({ maxBytes }: { maxBytes: number }) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  RNSkiaVideoModule.configureMemoryBudget!(maxBytes);
};

export const getVideoResourceStats = () => ({
  budget: RNSkiaVideoModule.getMemoryBudgetStats?.() ?? null,
  native: RNSkiaVideoModule.getResourceStats?.() ?? null,
  backend: RNSkiaVideoModule.getBackendInfo?.() ?? null,
});

export const frameByteSize = (width: number, height: number): number => {
  "worklet";
  const bytes = width * height * 4;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(bytes)
  ) {
    throw new Error("Invalid video frame dimensions");
  }
  return bytes;
};

export const reserveVideoMemory = (bytes: number, label: string): number => {
  "worklet";
  return RNSkiaVideoModule.reserveMemory?.(bytes, label) ?? 0;
};

export const releaseVideoMemory = (reservation: number): void => {
  "worklet";
  if (reservation) RNSkiaVideoModule.releaseMemory?.(reservation);
};

/** One API surface for each separately installed backend. No native texture introspection. */
export function createPublicApiAdapter({ video, preview, drawFrame, files, memory, validate, clock, paths, extensions = [], isResourceExhaustion }) {
  if (!video?.exportVideoComposition || !preview || !files || !clock) throw new Error('video, preview, files and clock are required');
  return {
    now: clock.now,
    sleep: clock.sleep,
    mount: preview.mount,
    unmount: preview.unmount,
    play: preview.play,
    pause: preview.pause,
    observe: preview.observe,
    seek: preview.seek,
    playToEnd: preview.playToEnd,
    measurePlayback: preview.measurePlayback,
    loop: preview.loop,
    drain: preview.drain,
    outputPath: files.outputPath,
    removeOutput: files.remove,
    paths,
    extensions,
    validate,
    verifyOwnedCleanup: typeof video.getVideoResourceStats === 'function',
    isExpectedMissingAudioError: (error) => /^No audio track\b/.test(String(error?.message ?? error)),
    isExpectedMissingMediaError: (error) => /No video track|No such file|ENOENT|FileNotFound|missing file/i.test(String(error?.message ?? error)),
    previewMetadata: { resolutionUnit: 'physical-pixels', pixelRatio: preview.pixelRatio ?? null,
      cleanup: preview.cleanupSemantics ?? 'adapter-defined; lifetime isolation not verified' },
    isResourceExhaustion: isResourceExhaustion ?? ((error) =>
      String(error?.message ?? error).startsWith('Video memory budget exceeded:')),
    configureMemoryBudget: async (maxBytes) => {
      if (typeof video.configureVideoMemory !== 'function') {
        return { requestedMaxBytes: maxBytes, applied: false, reportedMaxBytes: null,
          reason: 'This backend does not expose a library-owned memory budget API' };
      }
      video.configureVideoMemory({ maxBytes });
      const reportedMaxBytes = video.getVideoResourceStats?.().budget?.maxBytes ?? null;
      if (reportedMaxBytes !== null && reportedMaxBytes !== maxBytes) {
        throw new Error('Backend did not apply the requested memory budget');
      }
      return { requestedMaxBytes: maxBytes, applied: true, reportedMaxBytes };
    },
    sampleOperatingConditions: async () => await memory?.operatingConditions?.() ?? null,
    sampleMemory: async (context) => {
      const measured = await memory?.sample?.(context) ?? {};
      const owned = video.getVideoResourceStats?.();
      if (owned) {
        // Stats are library-owned estimates, never substitute for RSS / physical GPU allocation.
        const count = owned.budget?.allocations ?? owned.native?.frameBuffersCurrent;
        const bytes = owned.budget?.currentBytes ?? owned.native?.frameBytesCurrent;
        if (Number.isFinite(count)) measured.ownedResources = { value: count, source: owned.budget ? 'RNSkiaVideo memory budget reservations' : 'RNSkiaVideo native frame buffer counters' };
        if (Number.isFinite(bytes)) measured.ownedBytes = { value: bytes, source: owned.budget ? 'RNSkiaVideo memory budget byte estimates' : 'RNSkiaVideo native frame byte estimates' };
        if (Number.isFinite(owned.native?.decodersCurrent)) measured.decoderCount = { value: owned.native.decodersCurrent, source: 'RNSkiaVideo native decoder counters' };
        if (Number.isFinite(owned.native?.encoderSubmittingBuffersCurrent)) measured.inFlightFrames = { value: owned.native.encoderSubmittingBuffersCurrent, source: 'RNSkiaVideo encoder submitting buffer counters' };
      }
      return measured;
    },
    export: async ({ scenario, composition, output, outputPath, signal, onProgress }) => {
      // Identical requested codec, dimensions and bitrate. No capability helper silently changes output.
      const codec = output.codec === 'unknown-fallback' ? 'intentionally-unknown' : output.codec;
      const exportStarted = clock.now();
      const mediaValidation = await video.exportVideoComposition({ videoComposition: composition, drawFrame: drawFrame(scenario.extension), outPath: outputPath, ...output, codec, abortSignal: signal, onProgress });
      const encodeMs = clock.now() - exportStarted;
      const probeStarted = clock.now();
      const stat = await files.stat(outputPath);
      if (!(Number(stat.size) > 0)) throw new Error('Export created no media');
      const actualOutput = await files.probe?.(outputPath) ?? null;
      return { bytes: Number(stat.size), encodeMs, probeMs: clock.now() - probeStarted,
        actualOutput, mediaValidation: mediaValidation ?? null };
    },
  };
}

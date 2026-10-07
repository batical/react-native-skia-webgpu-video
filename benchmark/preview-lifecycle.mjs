/** Hook dimensions are points; the workload dimensions are physical pixels.
 * The tiny bias avoids floor(width / ratio * ratio) losing a pixel to rounding. */
export function previewDimensions(preview, pixelRatio) {
  if (!(Number.isFinite(pixelRatio) && pixelRatio > 0) ||
      !Number.isSafeInteger(preview?.width) || preview.width <= 0 ||
      !Number.isSafeInteger(preview?.height) || preview.height <= 0 ||
      preview.resolutionUnit !== 'physical-pixels') {
    throw new Error('Preview requires positive physical pixel dimensions and pixel ratio');
  }
  return { pixelWidth: preview.width, pixelHeight: preview.height, pixelRatio,
    logicalWidth: (preview.width + 1e-6) / pixelRatio,
    logicalHeight: (preview.height + 1e-6) / pixelRatio };
}

/** A controller becoming null after an error is not a React unmount. Wait for
 * the child cleanup, then queue a UI acknowledgement after all hook cleanups. */
export async function detachPreviewSession(session, { deactivate, waitFor, flushUiQueue }) {
  if (!session) return;
  deactivate(session);
  try {
    await waitFor(() => session.detached, 10000, false);
    await flushUiQueue();
  } catch (error) {
    const failure = error && typeof error === 'object' ? error : new Error(String(error));
    failure.unsafeToContinue = true;
    throw failure;
  }
}

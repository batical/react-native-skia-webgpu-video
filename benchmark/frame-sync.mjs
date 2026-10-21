// Frame-sync analysis, shared by the example app and the host tests. The
// sync fixtures (scripts/make-sync-fixtures.mjs) carry their frame index as a
// 12-bit code on a 12×9 grid: bits in rows 0–1, their complement in rows 2–3.
// An export stamps its own output frame index the same way in rows 4–7.

// Where a frame's rendering is compared between frame pixel formats and with
// ffmpeg: a 6×4 grid of the upright picture, at three times of each clip.
export const RENDER_GRID = Array.from({ length: 24 }, (_, i) =>
  [`g${i % 6}${Math.floor(i / 6)}`, ((i % 6) + 0.5) / 6, (Math.floor(i / 6) + 0.5) / 4]);
export const RENDER_TIMES = [0.5, 3, 5.5];

/** The largest and the mean channel difference between two lists of RGB patches. */
export function patchDifference(a, b) {
  let max = 0;
  let sum = 0;
  let count = 0;
  a.forEach((rgb, i) => rgb.forEach((value, c) => {
    const difference = Math.abs(value - b[i][c]);
    max = Math.max(max, difference);
    sum += difference;
    count++;
  }));
  return { max, mean: count ? Math.round(sum / count * 100) / 100 : null };
}

export const GRID_COLUMNS = 12;
export const GRID_ROWS = 9;

/** One code from a 12×9 RGBA readback: bits on `row`, complement on `complementRow`; -1 when unreadable. */
export function readCode(pixels, row, complementRow) {
  'worklet';
  let index = 0;
  for (let x = 0; x < GRID_COLUMNS; x++) {
    const bit = pixels[(row * GRID_COLUMNS + x) * 4 + 1] > 128;
    const complement = pixels[(complementRow * GRID_COLUMNS + x) * 4 + 1] > 128;
    if (bit === complement) return -1;
    if (bit) index |= 1 << x;
  }
  return index;
}

/** The source frame an item shows at a composition time: the last one at or before it. */
export function expectedIndex(item, compositionTime, fps) {
  'worklet';
  const sourceTime = compositionTime - item.compositionStartTime + item.startTime;
  // A millisecond of slack: a clock read at exactly k/fps rounds either way.
  return Math.floor(sourceTime * fps + 1e-3);
}

/** The item on screen at a composition time, as the preview draws it. */
export function itemAt(items, compositionTime) {
  'worklet';
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.compositionStartTime <= compositionTime && compositionTime < item.compositionStartTime + item.duration) return item;
  }
  return null;
}

const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
const round = (value, digits = 2) => value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

export function histogram(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * The share (%) of the intervals between two new frames that are off by more
 * than 3/4 of a refresh period from the duration of a frame: a frame shown a
 * refresh too early or too late (judder). 24 fps on 60 Hz alternates 33 and
 * 50 ms, half a period from 41.7 ms, and stays regular.
 */
export function irregularPercent(intervals, frameMs, refreshMs) {
  if (!intervals.length || !(refreshMs > 0)) return null;
  const irregular = intervals.filter((interval) => Math.abs(interval - frameMs) > 0.75 * refreshMs).length;
  return round(irregular / intervals.length * 100, 1);
}

/**
 * Preview samples:
 * - draws: one per drawFrame, { at (ms), time (composition s), item, index,
 *   seq } with index the source frame drawn (-1 unreadable, -2 not read) and
 *   seq the count of distinct frames drawn so far;
 * - vsyncs: the intervals (ms) between two UI frames.
 * Offsets are drawn index minus the index due at the draw's clock: negative
 * is late, positive ahead. A new frame is a draw whose seq changed. Reading
 * one frame in N keeps the readback's GPU round trip off most vsyncs: a frame
 * skipped between two frames read shows as an index step larger than the
 * distinct frames drawn between them. Without seq, a new frame is a draw whose
 * index changed, and every frame is read.
 */
export function analyzePreview({ items, fps, draws, vsyncs, warmUpSeconds = 0.5 }) {
  let synthetic = 0;
  let last = null;
  const sequenced = draws.map((draw) => {
    if (draw.seq !== undefined) return draw;
    if (!last || last.item !== draw.item || last.index !== draw.index) synthetic++;
    last = draw;
    return { ...draw, seq: synthetic };
  });
  const measured = sequenced.filter((draw) => draw.time >= warmUpSeconds && draw.item >= 0);
  const offsets = [];
  const worst = [];
  for (const draw of measured) {
    if (draw.index < 0) continue;
    const offset = draw.index - expectedIndex(items[draw.item], draw.time, fps);
    offsets.push(offset);
    if (offset !== 0 && worst.length < 12) worst.push({ time: round(draw.time, 3), item: draw.item, index: draw.index, offset });
  }
  let skipped = 0;
  let backwards = 0;
  let repeated = 0;
  const intervals = [];
  let fresh = null;
  let read = null;
  let newFrames = 0;
  for (const draw of measured) {
    if (!fresh || draw.seq !== fresh.seq || draw.item !== fresh.item) {
      newFrames++;
      if (fresh && fresh.item === draw.item) intervals.push(draw.at - fresh.at);
      fresh = draw;
    }
    if (draw.index < 0) continue;
    if (read && read.item === draw.item && draw.seq !== read.seq) {
      if (draw.index < read.index) backwards++;
      else skipped += Math.max(0, (draw.index - read.index) - (draw.seq - read.seq));
    }
    if (!read || draw.seq !== read.seq || draw.item !== read.item) read = draw;
  }
  // A frame held for two frame durations or more, beyond a refresh of slack.
  const sortedVsyncs = [...vsyncs].sort((a, b) => a - b);
  const refreshMs = percentile(sortedVsyncs, 0.5);
  const frameMs = 1000 / fps;
  if (refreshMs) repeated = intervals.filter((interval) => interval > 2 * frameMs + 0.75 * refreshMs).length;
  const exact = offsets.filter((offset) => offset === 0).length;
  const missedVsyncs = refreshMs ? vsyncs.reduce((sum, interval) => sum + Math.max(0, Math.round(interval / refreshMs) - 1), 0) : null;
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  return {
    draws: measured.length,
    unreadable: measured.filter((draw) => draw.index === -1).length,
    exactPercent: offsets.length ? round(exact / offsets.length * 100, 1) : null,
    offsets: histogram(offsets),
    worstOffsets: worst,
    newFrames,
    skippedFrames: skipped,
    backwardSteps: backwards,
    heldFrames: repeated,
    frameMs: round(frameMs),
    newFrameIntervalMs: { p5: round(percentile(sortedIntervals, 0.05)), p50: round(percentile(sortedIntervals, 0.5)),
      p95: round(percentile(sortedIntervals, 0.95)), max: round(sortedIntervals.at(-1) ?? null) },
    irregularPercent: irregularPercent(intervals, frameMs, refreshMs),
    refreshMs: round(refreshMs),
    missedVsyncs,
  };
}

export function previewPassed(result, { minExactPercent = 95, maxIrregularPercent = 5 } = {}) {
  const beyondOne = Object.keys(result.offsets).some((offset) => Math.abs(Number(offset)) >= 2);
  return result.unreadable === 0 && !beyondOne && result.exactPercent != null && result.exactPercent >= minExactPercent &&
    result.skippedFrames === 0 && result.backwardSteps === 0 &&
    result.irregularPercent != null && result.irregularPercent <= maxIrregularPercent;
}

/**
 * Exported frames, in file order: { stamp, source } as read back. stamp is
 * the output index the export drew, source the source frame it drew under it.
 */
export function analyzeExport({ items, sourceFps, outputFps, frames, expectedFrames }) {
  const mismatches = [];
  const offsets = [];
  let stampErrors = 0;
  let unreadable = 0;
  frames.forEach((frame, k) => {
    if (frame.stamp < 0 || frame.source < 0) { unreadable++; return; }
    if (frame.stamp !== k) stampErrors++;
    const time = frame.stamp / outputFps;
    const item = itemAt(items, time);
    if (!item) return;
    const offset = frame.source - expectedIndex(item, time, sourceFps);
    offsets.push(offset);
    if ((offset !== 0 || frame.stamp !== k) && mismatches.length < 12)
      mismatches.push({ frame: k, stamp: frame.stamp, source: frame.source, offset });
  });
  return {
    frames: frames.length,
    expectedFrames,
    unreadable,
    stampErrors,
    offsets: histogram(offsets),
    mismatches,
    passed: frames.length === expectedFrames && unreadable === 0 && stampErrors === 0 && offsets.every((offset) => offset === 0),
  };
}

/** A frame-sync report as terminal lines. */
export function formatFrameSyncReport(report) {
  const lines = [`frame sync ${report.status} · frames ${report.framePixelFormat ?? 'auto'} · vote ${report.frameRateVote ?? 'none'} · ${report.deviceModel} · ${report.displayRefreshRate} Hz · ` +
    `Skia ${report.skiaVersion} · ${report.buildMode}`];
  if (report.failure) lines.push(`  ${report.failure}`);
  for (const preview of report.previews ?? []) {
    if (preview.failure) { lines.push(`  ${preview.id} failed · ${preview.failure}`); continue; }
    const cadence = preview.cadence;
    const cadenceLine = cadence ? `    cadence: ${cadence.distinctFrames}/${cadence.dueFrames} distinct frames · ` +
      `${cadence.drawsPerSecond} draws/s · drawFrame p50 ${cadence.drawMs.p50?.toFixed(2)} ms, p95 ${cadence.drawMs.p95?.toFixed(2)} ms` : null;
    const extra = [preview.conditions?.thermalState && `thermal ${preview.conditions.thermalState}`,
      preview.counters && Object.keys(preview.counters).length &&
        Object.entries(preview.counters).map(([key, value]) => `${key.replace(/^preview/, '')} ${value}`).join(' ')]
      .filter(Boolean).join(' · ');
    const extraLine = extra ? `    ${extra}` : null;
    const playback = preview.playback;
    if (!playback) {
      lines.push(`  ${preview.id} ${preview.status} · no readback`);
      if (cadenceLine) lines.push(cadenceLine);
      if (extraLine) lines.push(extraLine);
      continue;
    }
    lines.push(`  ${preview.id} ${preview.status} · exact ${playback.exactPercent}% · offsets ${JSON.stringify(playback.offsets)}` +
      ` · skipped ${playback.skippedFrames} · backward ${playback.backwardSteps} · held ${playback.heldFrames}` +
      ` · irregular ${playback.irregularPercent}% · missed vsyncs ${playback.missedVsyncs}` +
      ` · unreadable ${playback.unreadable} · readback p50 ${preview.readbackMs?.p50?.toFixed(2)} ms`);
    if (cadenceLine) lines.push(cadenceLine);
    if (extraLine) lines.push(extraLine);
    if (playback.worstOffsets.length) lines.push(`    first offsets: ${playback.worstOffsets.map((entry) =>
      `${entry.time}s ${entry.offset > 0 ? '+' : ''}${entry.offset}`).join(', ')}`);
    if (preview.seeks.length) {
      const wrong = preview.seeks.filter((seek) => seek.shown !== seek.expected);
      const flashes = preview.seeks.filter((seek) => seek.drawnBefore.length);
      lines.push(`    seeks ${preview.seeks.length - wrong.length}/${preview.seeks.length} exact` +
        wrong.map((seek) => ` · ${seek.time.toFixed(4)}s shows ${seek.shown}, expected ${seek.expected}`).join('') +
        (flashes.length ? ` · wrong frame drawn first at ${flashes.map((seek) => `${seek.time.toFixed(4)}s (${seek.drawnBefore.join('/')})`).join(', ')}` : ''));
    }
  }
  for (const entry of report.colors ?? []) {
    if (entry.failure) { lines.push(`  ${entry.id} failed · ${entry.failure}`); continue; }
    const max = entry.maxDifference;
    lines.push(`  ${entry.id} ${entry.status} · max difference: yuv ${max.yuv}, rgba ${max.rgba} (vs ffmpeg) · yuv vs rgba ${max.yuvVsRgba}`);
  }
  for (const entry of report.renders ?? []) {
    if (entry.status === 'skipped') { lines.push(`  ${entry.id} skipped · ${entry.reason}`); continue; }
    if (entry.failure) { lines.push(`  ${entry.id} failed · ${entry.failure}`); continue; }
    const { yuvVsRgba, yuv, rgba } = entry.difference;
    lines.push(`  ${entry.id} ${entry.status} · yuv vs rgba max ${yuvVsRgba.max} mean ${yuvVsRgba.mean}` +
      (yuv ? ` · vs ffmpeg: yuv max ${yuv.max} mean ${yuv.mean}, rgba max ${rgba.max} mean ${rgba.mean}` : ''));
  }
  for (const entry of report.exports ?? []) {
    if (entry.failure) { lines.push(`  ${entry.id} failed · ${entry.failure}`); continue; }
    lines.push(`  ${entry.id} ${entry.status}${entry.size ? ` · ${entry.size}` : ''}${entry.exportMs ? ` · ${entry.exportMs} ms` : ''} · ${entry.frames}/${entry.expectedFrames} frames · file ${entry.file?.frameCount ?? '?'} frames` +
      `${entry.file?.presentationTimesExact === false ? ' (timestamps off the grid)' : ''}` +
      ` · source offsets ${JSON.stringify(entry.offsets)} · stamp errors ${entry.stampErrors} · unreadable ${entry.unreadable}`);
    if (entry.mismatches.length) lines.push(`    first mismatches: ${entry.mismatches.map((m) =>
      `#${m.frame} stamp ${m.stamp} source ${m.source} (${m.offset > 0 ? '+' : ''}${m.offset})`).join(', ')}`);
  }
  return lines;
}

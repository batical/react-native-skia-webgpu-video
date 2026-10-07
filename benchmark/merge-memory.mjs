import { normalizeMemory } from './metrics.mjs';

const PHYSICAL_FIELDS = ['rssBytes', 'pssBytes', 'nativeHeapBytes', 'gpuBytes'];
const nearestTo = (samples, target, maxGapMs) => {
  const nearest = samples.reduce((best, sample) => !best || Math.abs(sample.deviceWallMs - target) <
    Math.abs(best.deviceWallMs - target) ? sample : best, null);
  return nearest && Math.abs(nearest.deviceWallMs - target) <= maxGapMs ? nearest : null;
};

/** clockOffsetMs = device wall clock minus collector wall clock; caller must measure it.
 * Keep independent readings during a blocked JS export, rather than projecting
 * only onto sparse JS points and silently discarding the actual peak. */
export function mergeMemorySamples(result, externalSamples, { clockOffsetMs, maxGapMs = 3000 }) {
  if (!Number.isFinite(clockOffsetMs) || !Number.isFinite(maxGapMs) || maxGapMs < 0)
    throw new Error('An explicit measured clock offset and nonnegative max gap are required');
  const output = structuredClone(result);
  const samples = externalSamples.filter((sample) => sample.memory &&
    Number.isFinite(Date.parse(sample.requestedAtWallTime ?? sample.wallTime))).map((sample) => {
      const deviceWallMs = Date.parse(sample.requestedAtWallTime ?? sample.wallTime) + clockOffsetMs;
      const duration = Number.isFinite(sample.collectionMs) && sample.collectionMs >= 0 ? sample.collectionMs : 0;
      const completed = Date.parse(sample.completedAtWallTime);
      return { ...sample, deviceWallMs, completedDeviceWallMs: Number.isFinite(completed)
        ? completed + clockOffsetMs : deviceWallMs + duration };
    }).sort((a, b) => a.deviceWallMs - b.deviceWallMs);
  for (const entry of output.cases) {
    const start = Date.parse(entry.startedAt);
    if (!Number.isFinite(start)) continue;
    const originalPoints = entry.memorySamples ?? [];
    const events = entry.collection?.phaseEvents;
    const validTimeline = Array.isArray(events) && events.length > 0 && events[0].elapsedMs === 0 &&
      Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0 && events.every((event, index) =>
        Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs <= entry.elapsedMs &&
        ['running', 'settled'].includes(event.phase) && (!index || event.elapsedMs >= events[index - 1].elapsedMs));
    const phaseAt = (elapsedMs) => {
      if (!validTimeline || elapsedMs < 0 || elapsedMs > entry.elapsedMs) return null;
      let event = events[0];
      for (const next of events) { if (next.elapsedMs > elapsedMs) break; event = next; }
      return event;
    };
    const candidates = samples.filter((sample) => {
      if (!validTimeline) return true;
      const begin = sample.deviceWallMs - start;
      const end = sample.completedDeviceWallMs - start;
      const event = phaseAt(begin);
      return event && end >= begin && phaseAt(end) === event;
    });
    for (const point of originalPoints) {
      const target = start + point.elapsedMs;
      const relevant = validTimeline ? candidates.filter((sample) =>
        phaseAt(sample.deviceWallMs - start)?.phase === point.phase) : candidates;
      const nearest = nearestTo(relevant, target, maxGapMs);
      if (!nearest) continue;
      const measured = normalizeMemory(nearest.memory);
      for (const field of PHYSICAL_FIELDS) if (measured[field].value != null) point.memory[field] = measured[field];
      point.externalCollector = { pid: nearest.pid ?? null, gapMs: Math.abs(nearest.deviceWallMs - target),
        collectionMs: nearest.collectionMs ?? null, requestedAtWallTime: nearest.requestedAtWallTime ?? nearest.wallTime };
    }
    let inserted = 0;
    if (validTimeline) {
      const limit = entry.collection.maxMemorySamples ?? 2048;
      for (const sample of candidates) {
        const elapsedMs = sample.deviceWallMs - start;
        const event = phaseAt(elapsedMs);
        if (originalPoints.length >= limit) {
          entry.collection.memorySamplesDropped = (entry.collection.memorySamplesDropped ?? 0) + 1;
          continue;
        }
        // Keep contemporaneous native conditions when available; do not assume
        // startup thermal state throughout a long synchronous export.
        const conditionsPoint = originalPoints.filter((point) => !point.externalCollector?.independent &&
          point.operatingConditions?.source && Math.abs(point.elapsedMs - elapsedMs) <= maxGapMs)
          .sort((a, b) => Math.abs(a.elapsedMs - elapsedMs) - Math.abs(b.elapsedMs - elapsedMs))[0];
        originalPoints.push({ elapsedMs, collectedAtElapsedMs: sample.completedDeviceWallMs - start,
          phase: event.phase, ...(event.cycle == null ? {} : { cycle: event.cycle }),
          memory: normalizeMemory(sample.memory), operatingConditions: sample.operatingConditions ??
            conditionsPoint?.operatingConditions ?? { thermalState: null, powerMode: null, source: null,
              reason: 'No contemporaneous operating-condition collector during external memory reading' },
          externalCollector: { independent: true, pid: sample.pid ?? null, gapMs: 0,
            collectionMs: sample.collectionMs ?? null,
            operatingConditionGapMs: conditionsPoint ? Math.abs(conditionsPoint.elapsedMs - elapsedMs) : null } });
        inserted++;
      }
      originalPoints.sort((a, b) => a.elapsedMs - b.elapsedMs);
      entry.memorySamples = originalPoints;
    }
    (entry.collection ??= {}).externalMemory = { clockOffsetMs, maxGapMs, samples: samples.length,
      insertedSamples: inserted, phaseTimelineVerified: validTimeline,
      ...(validTimeline ? {} : { reason: 'No phase timeline: external peaks cannot be assigned safely to workloads' }) };
  }
  return output;
}

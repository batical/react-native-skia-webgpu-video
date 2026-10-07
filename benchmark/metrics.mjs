export const MEMORY_FIELDS = ['rssBytes', 'physicalFootprintBytes', 'pssBytes', 'nativeHeapBytes', 'gpuBytes', 'ownedBytes', 'ownedResources', 'decoderCount', 'inFlightFrames'];
export const unavailable = (reason = 'No collector attached') => ({ value: null, source: null, reason });

export function normalizeMemory(snapshot = {}) {
  return Object.fromEntries(MEMORY_FIELDS.map((field) => {
    const reading = snapshot[field];
    if (!reading || !Number.isFinite(reading.value) || reading.value < 0 || typeof reading.source !== 'string' || !reading.source) {
      return [field, unavailable(reading?.reason ?? 'Collector does not expose this metric')];
    }
    return [field, { value: reading.value, source: reading.source, reason: null }];
  }));
}

export function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export function summarizeDurations(values) {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  return { samples: finite.length, medianMs: percentile(finite, 0.5), p95Ms: percentile(finite, 0.95), p99Ms: percentile(finite, 0.99), maxMs: finite.length ? Math.max(...finite) : null };
}

/** Keep fixed histograms on the device: no frame-by-frame JS telemetry allocations. */
export const FRAME_BUCKETS = [0.25, 0.5, 1, 2, 4, 8, 12, 16.667, 25, 33.333, 50, 100, 250, 1000];
export function createHistogram() { return { bounds: FRAME_BUCKETS, counts: Array(FRAME_BUCKETS.length + 1).fill(0), total: 0, sumMs: 0, maxMs: 0 }; }
export function recordHistogram(histogram, durationMs) {
  'worklet';
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  let index = 0;
  while (index < histogram.bounds.length && durationMs > histogram.bounds[index]) index++;
  histogram.counts[index]++;
  histogram.total++;
  histogram.sumMs += durationMs;
  histogram.maxMs = Math.max(histogram.maxMs, durationMs);
}

export function histogramPercentile(histogram, quantile) {
  if (!histogram?.total) return null;
  const target = Math.ceil(histogram.total * quantile);
  let count = 0;
  for (let i = 0; i < histogram.counts.length; i++) {
    count += histogram.counts[i];
    if (count >= target) return histogram.bounds[i] ?? histogram.maxMs;
  }
  return null;
}

export function memoryTrend(samples, field, phase = 'settled', warmupCycles = 10) {
  // A non-cyclic workload has no evidence that warmup completed. Repeated
  // asynchronous readings from one settle phase are not independent cycles.
  const eligible = samples.filter((sample) => sample.phase === phase &&
    Number.isSafeInteger(sample.cycle) && sample.cycle >= warmupCycles &&
    Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0 &&
    Number.isFinite(sample.memory?.[field]?.value) && sample.memory[field].value >= 0 &&
    typeof sample.memory[field].source === 'string' && sample.memory[field].source);
  const cycles = new Map();
  for (const point of eligible) {
    const previous = cycles.get(point.cycle);
    if (!previous || point.elapsedMs > previous.elapsedMs) cycles.set(point.cycle, point);
  }
  const points = [...cycles.values()].sort((a, b) => a.cycle - b.cycle);
  const unavailable = (reason) => ({ samples: points.length, rawSamples: eligible.length,
    cycles: points.map((point) => point.cycle), peak: null, delta: null, slopePerMinute: null, reason });
  if (points.length < 3) return unavailable('At least three distinct settled cycles with explicit warmup evidence are required');
  if (new Set(eligible.map((point) => point.memory[field].source)).size > 1)
    return unavailable('Collector source changed during the run');
  if (points.some((point, index) => index > 0 && point.elapsedMs <= points[index - 1].elapsedMs))
    return unavailable('Distinct settled cycles require strictly increasing timestamps');
  const meanX = points.reduce((sum, point) => sum + point.elapsedMs / 60000, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.memory[field].value, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const dx = point.elapsedMs / 60000 - meanX;
    numerator += dx * (point.memory[field].value - meanY);
    denominator += dx * dx;
  }
  return { samples: points.length, rawSamples: eligible.length, cycles: points.map((point) => point.cycle),
    peak: Math.max(...points.map((point) => point.memory[field].value)),
    delta: points.at(-1).memory[field].value - points[0].memory[field].value,
    slopePerMinute: denominator > 0 ? numerator / denominator : null,
    source: points[0].memory[field].source, reason: denominator > 0 ? null : 'Samples have identical timestamps' };
}

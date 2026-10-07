import { memoryTrend, MEMORY_FIELDS, percentile, histogramPercentile } from './metrics.mjs';
import { RESULT_SCHEMA } from './runner.mjs';
import { expectedFrameCount } from './cases.mjs';
import { FIXTURE_SCHEMA, validateFixtureManifest } from './fixtures.mjs';

export const DEFAULT_THRESHOLDS = { drawP95Percent: 15, drawP95AbsoluteMs: 1, exportPercent: 10, exportAbsoluteMs: 100, peakMemoryPercent: 10, peakMemoryAbsoluteBytes: 8 * 1024 * 1024, slopeBytesPerMinute: 1024 * 1024, settledGrowthBytes: 8 * 1024 * 1024 };
const canonical = (value) => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
const median = (values) => percentile(values.filter(Number.isFinite), 0.5);
const peak = (samples, field) => {
  const values = samples.filter((sample) => typeof sample.memory?.[field]?.source === 'string' && sample.memory[field].source)
    .map((sample) => sample.memory[field].value).filter((value) => Number.isFinite(value) && value >= 0);
  return values.length ? Math.max(...values) : null;
};

export function validateResult(result) {
  if (result?.schema !== RESULT_SCHEMA || !Array.isArray(result.cases) || !Array.isArray(result.caseCatalog) ||
      !result.caseCatalog.length || result.fixtureManifest?.schema !== FIXTURE_SCHEMA || !Array.isArray(result.fixtureManifest.files) ||
      !Number.isInteger(result.repetitions) || result.repetitions < 1) throw new Error('Unsupported or incomplete benchmark result');
  for (const field of ['deviceId', 'deviceModel', 'executionTarget', 'platform', 'osVersion', 'reactNativeVersion', 'buildMode', 'measurementClock']) {
    const value = result.environment?.[field];
    if (typeof value !== 'string' || !value.trim() || /^(unknown|unavailable|unspecified|not-measured)$/i.test(value))
      throw new Error('Missing measured environment identity: ' + field);
  }
  for (const field of ['pixelRatio', 'displayRefreshRate'])
    if (!(Number.isFinite(result.environment?.[field]) && result.environment[field] > 0))
      throw new Error('Missing measured environment identity: ' + field);
  const identities = new Set();
  const catalog = new Set(result.caseCatalog.map((entry) => entry.id));
  if (catalog.size !== result.caseCatalog.length || [...catalog].some((id) => typeof id !== 'string' || !id)) throw new Error('Invalid or duplicate workload IDs');
  for (const entry of result.cases) {
    if (!catalog.has(entry.id)) throw new Error(`Result case is missing from the catalog: ${entry.id}`);
    if (!['passed', 'failed', 'skipped', 'resource-limit'].includes(entry.status)) throw new Error(`Invalid case status: ${entry.id}`);
    if (entry.status !== 'skipped' && !(Number.isFinite(entry.collection?.periodMs) && entry.collection.periodMs > 0))
      throw new Error(`Missing or invalid memory sample period: ${entry.id}`);
    const key = `${entry.id}:${entry.repetition}`;
    if (identities.has(key)) throw new Error(`Duplicate result: ${key}`);
    identities.add(key);
    if (entry.status !== 'skipped' && (!Number.isInteger(entry.repetition) || entry.repetition < 0 || entry.repetition >= result.repetitions)) throw new Error(`Invalid repetition: ${key}`);
  }
  for (const scenario of result.caseCatalog) {
    if (!result.cases.some((entry) => entry.id === scenario.id)) throw new Error(`Missing result: ${scenario.id}`);
    if (result.cases.some((entry) => entry.id === scenario.id && entry.status !== 'skipped'))
      validateFixtureManifest(result.fixtureManifest, scenario.composition.items.map((item) => item.fixture));
  }
}

export function validateCompatibility(baseline, candidate) {
  validateResult(baseline);
  validateResult(candidate);
  const mismatches = [];
  for (const field of ['workloadVersion', 'seed', 'profile']) if (baseline[field] !== candidate[field]) mismatches.push(field);
  if ((baseline.memoryBudget?.requestedMaxBytes ?? null) !== (candidate.memoryBudget?.requestedMaxBytes ?? null)) mismatches.push('memoryBudget.requestedMaxBytes');
  for (const field of ['deviceId', 'deviceModel', 'executionTarget', 'platform', 'osVersion', 'reactNativeVersion', 'buildMode', 'measurementClock', 'displayRefreshRate', 'pixelRatio']) if (baseline.environment?.[field] !== candidate.environment?.[field]) mismatches.push(`environment.${field}`);
  if (baseline.environment?.buildMode !== 'release') mismatches.push('release-build-required');
  if (canonical(baseline.caseCatalog) !== canonical(candidate.caseCatalog)) mismatches.push('caseCatalog (dimensions, modes, codec, seeks or operations differ)');
  for (const scenario of baseline.caseCatalog) {
    const periods = (result) => [...new Set(result.cases.filter((entry) => entry.id === scenario.id && entry.status !== 'skipped')
      .map((entry) => entry.collection.periodMs))].sort((a, b) => a - b);
    const a = periods(baseline);
    const b = periods(candidate);
    if (a.length > 1 || b.length > 1 || (a.length && b.length && canonical(a) !== canonical(b)))
      mismatches.push(`collection.periodMs.${scenario.id}`);
  }
  const required = new Set(baseline.caseCatalog.flatMap((scenario) => scenario.composition.items.map((item) => item.fixture)));
  for (const id of required) {
    const a = baseline.fixtureManifest.files.find((entry) => entry.id === id);
    const b = candidate.fixtureManifest.files.find((entry) => entry.id === id);
    if (a?.sha256 !== b?.sha256 || a?.bytes !== b?.bytes) mismatches.push(`fixture.${id}`);
  }
  if (mismatches.length) throw new Error(`Incompatible benchmark results: ${mismatches.join(', ')}`);
}

export function change(baseline, candidate) {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) return { baseline: baseline ?? null, candidate: candidate ?? null, delta: null, percent: null, status: 'unavailable' };
  const delta = candidate - baseline;
  return { baseline, candidate, delta, percent: baseline === 0 ? null : delta / baseline * 100, status: 'measured' };
}

function sources(entries, field) {
  return [...new Set(entries.flatMap((entry) => (entry.memorySamples ?? []).map((sample) => sample.memory?.[field]?.source).filter(Boolean)))].sort();
}

function operatingConditionIssues(entries) {
  const issues = [];
  const readings = entries.flatMap((entry) => entry.memorySamples ?? []).map((point) => point.operatingConditions);
  if (!readings.length || readings.some((reading) => !reading?.source ||
      !['nominal', 'fair', 'serious', 'critical'].includes(reading.thermalState) || !['normal', 'low-power'].includes(reading.powerMode)))
    issues.push('Operating conditions were not measured throughout every repetition');
  if (readings.some((reading) => reading?.thermalState && reading.thermalState !== 'nominal'))
    issues.push('Thermal state was non-nominal during the workload');
  if (readings.some((reading) => reading?.applicationState != null && reading.applicationState !== 'active'))
    issues.push('Application was not active throughout the workload');
  if (new Set(readings.map((reading) => reading?.powerMode).filter(Boolean)).size > 1)
    issues.push('Power mode changed during or between repetitions');
  if (new Set(readings.map((reading) => reading?.source).filter(Boolean)).size > 1)
    issues.push('Operating condition collector sources differ');
  return issues;
}

function inspectCompletedEntry(entry, scenario, environment) {
  const failed = [];
  const incomplete = [];
  if (entry.status !== 'passed') return { failed, incomplete };
  const operations = entry.operations ?? [];
  if ((entry.validations ?? []).some((validation) => validation.status === 'failed')) failed.push('A media correctness validator failed');
  if (canonical(operations.map((op) => op.operation)) !== canonical(scenario.operations))
    incomplete.push('Requested operations are missing or out of order');
  for (const check of scenario.validation ?? []) {
    const readings = (entry.validations ?? []).filter((validation) => validation.check === check);
    if (readings.some((validation) => validation.status === 'failed')) failed.push('Media validation failed: ' + check);
    else if (readings.length !== 1 || readings[0].status !== 'passed') incomplete.push('Media validation unavailable: ' + check);
  }
  if (entry.collection?.memorySamplesDropped > 0) incomplete.push('Memory sample limit was reached; peak/trend coverage is incomplete');
  if (entry.collection?.externalMemory && entry.collection.externalMemory.phaseTimelineVerified !== true)
    incomplete.push('External memory peaks lack a verified workload phase timeline');
  const hasPreview = scenario.operations.some((name) => !['export', 'export-allow-clean-error',
    'cancel-before', 'cancel-export', 'mixed-exports', 'open-error'].includes(name));
  if (hasPreview) {
    const preview = entry.collection?.preview;
    if (preview?.actualPixelWidth !== scenario.preview.width || preview?.actualPixelHeight !== scenario.preview.height ||
        preview?.resolutionUnit !== 'physical-pixels' || preview.pixelRatio !== environment?.pixelRatio ||
        !Number.isFinite(preview.logicalWidth) || !Number.isFinite(preview.logicalHeight) ||
        Math.floor(preview.logicalWidth * preview.pixelRatio) !== scenario.preview.width ||
        Math.floor(preview.logicalHeight * preview.pixelRatio) !== scenario.preview.height)
      incomplete.push('Actual preview physical dimensions were not verified');
  }
  for (const op of operations) {
    if (op.operation === 'perf' && (!(op.draws > 0) || histogramPercentile(op.drawHistogram, 0.95) == null))
      incomplete.push('Playback timing has no measured draw samples');
    if (op.operation === 'export' && (!(Number.isFinite(op.exportMs) && op.exportMs >= 0) ||
        op.framesCompleted !== op.expectedFrames || op.expectedFrames !== expectedFrameCount(scenario.composition.duration, scenario.output.frameRate)))
      incomplete.push('Export timing or completed frame count is missing');
    if (op.operation === 'mixed-exports' && op.exports?.length !== scenario.exportCycles)
      incomplete.push('Mixed-size export cycles are incomplete');
    const exports = op.operation === 'export' ? [{ ...op, output: scenario.output }]
      : op.operation === 'mixed-exports' ? (op.exports ?? []) : [];
    for (const item of exports) {
      const actual = item.actualOutput;
      const output = item.output;
      if (!actual || !output) { incomplete.push('Encoded output was not probed'); continue; }
      const expectedCodec = output.codec === 'unknown-fallback' ? 'h264' : output.codec;
      if (actual.width !== output.width || actual.height !== output.height || actual.codec !== expectedCodec)
        failed.push('Encoded codec or dimensions differ from the request');
      const frames = expectedFrameCount(scenario.composition.duration, output.frameRate);
      if (Number.isFinite(actual.frameCount) && actual.frameCount !== frames) failed.push('Encoded frame count differs from the request');
      if (Number.isFinite(actual.fps) && Math.abs(actual.fps - output.frameRate) > 0.01) failed.push('Encoded frame rate differs from the request');
      if (Number.isFinite(actual.duration) && Math.abs(actual.duration - frames / output.frameRate) > 1 / output.frameRate + 0.001)
        failed.push('Encoded duration differs from the request');
      if (actual.timestampsMonotonic === false || actual.presentationTimesExact === false) failed.push('Encoded presentation timestamps are incorrect');
      if (!Number.isFinite(actual.frameCount) || !Number.isFinite(actual.fps) || !Number.isFinite(actual.duration) ||
          actual.timestampsMonotonic !== true || actual.presentationTimesExact !== true)
        incomplete.push('Encoded frame/timestamp metadata is incomplete');
    }
  }
  return { failed, incomplete };
}

export function compareResults(baseline, candidate, thresholds = {}) {
  validateCompatibility(baseline, candidate);
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const report = { schema: 1, baseline: baseline.backend, candidate: candidate.backend, thresholds: limits, environment: baseline.environment, memoryBudget: { baseline: baseline.memoryBudget ?? null, candidate: candidate.memoryBudget ?? null }, assessment: 'passed', warnings: [], confounders: [], cases: [] };
  if (baseline.memoryBudget?.applied !== candidate.memoryBudget?.applied) report.warnings.push('Library-owned memory budget enforcement differs between backends; requested limits are identical, enforcement availability is recorded');
  if (canonical(baseline.backend?.paths) !== canonical(candidate.backend?.paths)) report.warnings.push('Decode/render/encode transport changed; record the intended change and do not describe CPU readback results as GPU-only');
  if (baseline.environment?.thermalState !== 'nominal' || candidate.environment?.thermalState !== 'nominal') report.confounders.push('Thermal state was not confirmed nominal for both runs');
  if (!baseline.environment?.powerMode || !candidate.environment?.powerMode) report.confounders.push('Power mode was not measured for both runs');
  else if (baseline.environment.powerMode !== candidate.environment.powerMode) report.confounders.push('Power mode differs');
  report.warnings.push(...report.confounders);
  for (const scenario of baseline.caseCatalog) {
    const before = baseline.cases.filter((entry) => entry.id === scenario.id);
    const after = candidate.cases.filter((entry) => entry.id === scenario.id);
    const row = { id: scenario.id, assessment: 'passed', repetitions: { baseline: before.filter((entry) => entry.status === 'passed').length, candidate: after.filter((entry) => entry.status === 'passed').length }, findings: [], metrics: {}, memory: {}, confounders: operatingConditionIssues([...before, ...after]) };
    if (after.some((entry) => entry.status === 'failed' || entry.unsafeToContinue)) { row.assessment = 'failed'; row.findings.push('Candidate correctness / termination failure'); }
    if (before.some((entry) => entry.status === 'failed' || entry.unsafeToContinue)) { row.assessment = 'failed'; row.findings.push('Baseline correctness / termination failure'); }
    if (row.assessment !== 'failed' && (before.some((entry) => entry.status !== 'passed') || after.some((entry) => entry.status !== 'passed'))) { row.assessment = 'incomplete'; row.findings.push('Skipped or resource-limited execution; no performance pass can be inferred'); }
    if (row.repetitions.baseline < 3 || row.repetitions.candidate < 3) { row.findings.push('At least three successful repetitions per backend are required'); if (row.assessment !== 'failed') row.assessment = 'incomplete'; }
    if (before.length !== baseline.repetitions || after.length !== candidate.repetitions) {
      row.findings.push('Declared repetitions are missing'); if (row.assessment !== 'failed') row.assessment = 'incomplete';
    }
    for (const [name, entries] of [['Baseline', before], ['Candidate', after]]) {
      for (const entry of entries) {
        const inspection = inspectCompletedEntry(entry, scenario, name === 'Baseline' ? baseline.environment : candidate.environment);
        if (inspection.failed.length) row.assessment = 'failed';
        else if (inspection.incomplete.length && row.assessment !== 'failed') row.assessment = 'incomplete';
        for (const message of [...inspection.failed, ...inspection.incomplete]) {
          const finding = name + ': ' + message;
          if (!row.findings.includes(finding)) row.findings.push(finding);
        }
      }
    }
    if (row.confounders.length) {
      row.findings.push(...row.confounders);
      if (row.assessment !== 'failed') row.assessment = 'incomplete';
    }
    const opValues = (entries, operation, read) => entries.flatMap((entry) => (entry.operations ?? []).filter((op) => op.operation === operation).map(read));
    row.metrics.exportMs = change(median(opValues(before, 'export', (op) => op.exportMs)), median(opValues(after, 'export', (op) => op.exportMs)));
    row.metrics.encodeMs = change(median(opValues(before, 'export', (op) => op.encodeMs)), median(opValues(after, 'export', (op) => op.encodeMs)));
    row.metrics.probeMs = change(median(opValues(before, 'export', (op) => op.probeMs)), median(opValues(after, 'export', (op) => op.probeMs)));
    row.metrics.mixedExportMs = change(median(opValues(before, 'mixed-exports', (op) => median((op.exports ?? []).map((item) => item.durationMs)))), median(opValues(after, 'mixed-exports', (op) => median((op.exports ?? []).map((item) => item.durationMs)))));
    row.metrics.drawP95Ms = change(median(opValues(before, 'perf', (op) => histogramPercentile(op.drawHistogram, 0.95))), median(opValues(after, 'perf', (op) => histogramPercentile(op.drawHistogram, 0.95))));
    row.metrics.callbackGapP95Ms = change(median(opValues(before, 'perf', (op) => histogramPercentile(op.callbackGapHistogram, 0.95))), median(opValues(after, 'perf', (op) => histogramPercentile(op.callbackGapHistogram, 0.95))));
    row.metrics.seekP95Ms = change(median(opValues(before, 'seek', (op) => op.latencies?.p95Ms)), median(opValues(after, 'seek', (op) => op.latencies?.p95Ms)));
    row.metrics.droppedFrames = change(median(opValues(before, 'perf', (op) => op.droppedFrames)), median(opValues(after, 'perf', (op) => op.droppedFrames)));
    const regress = (metric, percentLimit, absoluteLimit, label, physicalMemory = false) => {
      if ((metric.baseline === 0 || metric.percent > percentLimit) && metric.delta > absoluteLimit) {
        if (!physicalMemory && (row.confounders.length || report.confounders.length)) {
          row.findings.push(label + ' observed; operating conditions prevent a qualified performance verdict');
          if (row.assessment !== 'failed') row.assessment = 'incomplete';
        } else { row.assessment = 'failed'; row.findings.push(label); }
      }
    };
    regress(row.metrics.exportMs, limits.exportPercent, limits.exportAbsoluteMs, 'Export duration regression');
    regress(row.metrics.encodeMs, limits.exportPercent, limits.exportAbsoluteMs, 'Encode duration regression');
    regress(row.metrics.mixedExportMs, limits.exportPercent, limits.exportAbsoluteMs, 'Mixed-size export duration regression');
    regress(row.metrics.drawP95Ms, limits.drawP95Percent, limits.drawP95AbsoluteMs, 'Draw callback p95 regression');
    for (const field of MEMORY_FIELDS) {
      const aSources = sources(before, field);
      const bSources = sources(after, field);
      const sameSource = aSources.length === 1 && canonical(aSources) === canonical(bSources) &&
        [...before, ...after].every((entry) => peak(entry.memorySamples ?? [], field) !== null);
      const measured = sameSource ? change(median(before.map((entry) => peak(entry.memorySamples ?? [], field))), median(after.map((entry) => peak(entry.memorySamples ?? [], field)))) : { ...change(null, null), reason: 'Missing or different collector sources' };
      const hasRepeatedCycles = scenario.operations.some((operation) => ['mixed-exports', 'leak', 'churn'].includes(operation));
      const trends = after.map((entry) => {
        if (!hasRepeatedCycles) return { samples: 0, peak: null, delta: null, slopePerMinute: null,
          reason: 'Scenario has no repeated lifecycle or export cycles' };
        // The mixed-export loop increments its index once after its last
        // export. Final cleanup at N and the last export at N-1 are the
        // same completed workload cycle, not two independent observations.
        const samples = scenario.operations.length === 1 && scenario.operations[0] === 'mixed-exports' &&
          Number.isSafeInteger(scenario.exportCycles) && scenario.exportCycles > 0
          ? (entry.memorySamples ?? []).map((sample) => Number.isSafeInteger(sample.cycle)
            ? { ...sample, cycle: Math.min(sample.cycle, scenario.exportCycles - 1) } : sample)
          : entry.memorySamples ?? [];
        return memoryTrend(samples, field);
      });
      row.memory[field] = { peak: measured, candidateTrends: trends };
      if (field.endsWith('Bytes')) {
        regress(measured, limits.peakMemoryPercent, limits.peakMemoryAbsoluteBytes, `${field} peak regression`, true);
        if (trends.some((trend) => trend.slopePerMinute > limits.slopeBytesPerMinute && trend.delta > limits.settledGrowthBytes)) { row.assessment = 'failed'; row.findings.push(`${field} grows after warmup; inspect retained resources`); }
      }
    }
    // A missing physical memory collector is never reported as a memory pass.
    if (row.memory.rssBytes.peak.status === 'unavailable' && row.memory.pssBytes.peak.status === 'unavailable') {
      row.findings.push('Process memory unavailable; owned counters do not measure total native/GPU memory');
      if (row.assessment !== 'failed') row.assessment = 'incomplete';
    }
    const physicalPhasesComplete = ['rssBytes', 'pssBytes'].some((field) =>
      row.memory[field].peak.status === 'measured' && [...before, ...after].every((entry) =>
        ['running', 'settled'].every((phase) => (entry.memorySamples ?? []).some((sample) => sample.phase === phase &&
          Number.isFinite(sample.memory?.[field]?.value) && sample.memory[field].value >= 0 && sample.memory[field].source))));
    if (!physicalPhasesComplete) {
      row.findings.push('Process memory is missing from a repeated running/settled phase');
      if (row.assessment !== 'failed') row.assessment = 'incomplete';
    }
    if ([...before, ...after].some((entry) => entry.validations?.some((validation) => validation.status !== 'passed'))) {
      row.findings.push('Pixel / audio / timestamp validation incomplete');
      if (row.assessment !== 'failed') row.assessment = 'incomplete';
    }
    const actualOutputs = (entries) => entries.flatMap((entry) => (entry.operations ?? []).flatMap((op) =>
      op.operation === 'export' ? [op.actualOutput] : op.operation === 'mixed-exports' ? (op.exports ?? []).map((item) => item.actualOutput) : []));
    const outputsBefore = actualOutputs(before);
    const outputsAfter = actualOutputs(after);
    if (outputsBefore.length !== outputsAfter.length) {
      row.findings.push('Encoded output repetitions are incomplete');
      if (row.assessment !== 'failed') row.assessment = 'incomplete';
    } else if ([...outputsBefore, ...outputsAfter].some((output) => output == null)) {
      row.findings.push('Encoded metadata is unavailable for one or both backends');
      if (row.assessment !== 'failed') row.assessment = 'incomplete';
    } else {
      const core = (outputs) => outputs.map(({ width, height, codec, frameCount }) => ({ width, height, codec, frameCount }));
      if (canonical(core(outputsBefore)) !== canonical(core(outputsAfter))) {
        row.assessment = 'failed'; row.findings.push('Actual encoded dimensions, codec or frame count differ');
      }
    }
    if (scenario.operations.includes('export') && actualOutputs(after).some((output) => output == null)) {
      row.findings.push('Actual codec / encoded dimensions were not probed');
      if (row.assessment !== 'failed') row.assessment = 'incomplete';
    }
    report.cases.push(row);
    if (row.assessment === 'failed') report.assessment = 'failed';
    else if (row.assessment === 'incomplete' && report.assessment !== 'failed') report.assessment = 'incomplete';
  }
  if (report.confounders.length && report.assessment === 'passed') report.assessment = 'incomplete';
  return report;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildCases, expectedFrameCount, WORKLOAD_VERSION } from '../../benchmark/cases.mjs';
import { FIXTURES } from '../../benchmark/fixtures.mjs';
import { createHistogram, recordHistogram, normalizeMemory } from '../../benchmark/metrics.mjs';
import { main, summarizeAB, renderABMarkdown } from '../../scripts/benchmark-ab-summary.mjs';

const ids = ['single-h264-1080p30-audio.mp4', 'encode-h264-copy', 'repeated-mixed-size-exports'];
function fixture(backend, minute, times = [10, 20, 30]) {
  const candidate = backend === 'candidate';
  const start = Date.parse('2026-10-06T10:00:00.000Z') + minute * 60000;
  const catalog = buildCases().filter((scenario) => ids.includes(scenario.id));
  const outcome = (scenario, output, time) => {
    const frames = expectedFrameCount(scenario.composition.duration, output.frameRate);
    return { output, encodeMs: time, probeMs: 3, exportMs: time + 4, durationMs: time + 4,
      expectedFrames: frames, framesCompleted: frames,
      actualOutput: { width: output.width, height: output.height, fps: output.frameRate,
        codec: output.codec, frameCount: frames, duration: frames / output.frameRate,
        presentationTimesExact: true, timestampsMonotonic: true } };
  };
  return { schema: 1, workloadVersion: WORKLOAD_VERSION, seed: 123, profile: 'full', repetitions: 3,
    startedAt: new Date(start).toISOString(), finishedAt: new Date(start + 30000).toISOString(),
    backend: { name: backend, version: 'test', skiaVersion: candidate ? '3' : '2', paths: { export: candidate ? 'cpu-readback' : 'metal-texture' } },
    memoryBudget: { requestedMaxBytes: 536870912, applied: candidate, reportedMaxBytes: candidate ? 536870912 : null },
    environment: { deviceId: 'test-simulator', deviceModel: 'test', executionTarget: 'simulator', platform: 'ios',
      osVersion: '27', reactNativeVersion: '0.86.2', buildMode: 'release', measurementClock: 'performance.now',
      pixelRatio: 3, displayRefreshRate: 60, thermalState: 'nominal', powerMode: 'normal' },
    fixtureManifest: { schema: 1, files: FIXTURES.map((item) => ({ ...item, bytes: 1024, sha256: 'a'.repeat(64) })) },
    caseCatalog: catalog,
    cases: catalog.flatMap((scenario) => times.map((time, repetition) => {
      const point = (phase, elapsedMs, rss) => ({ phase, elapsedMs, collectedAtElapsedMs: elapsedMs + 1,
        memory: normalizeMemory({ rssBytes: { value: rss, source: 'test RSS' },
          ...(candidate ? { ownedBytes: { value: phase === 'settled' ? 0 : 1000, source: 'test own estimates' } } : {}) }),
        operatingConditions: { thermalState: 'nominal', powerMode: 'normal', source: 'test conditions' } });
      return { id: scenario.id, repetition, status: 'passed', elapsedMs: 2001,
        startedAt: new Date(start + repetition * 3000).toISOString(),
        collection: { periodMs: 100, memorySamplesDropped: 0, preview: { resolutionUnit: 'physical-pixels',
          pixelRatio: 3, logicalWidth: 240, logicalHeight: 240, actualPixelWidth: 720, actualPixelHeight: 720 } },
        memorySamples: [point('running', 0, 100000000), point('running', 100, 150000000), point('settled', 2000, 100000000)],
        validations: (scenario.validation ?? []).map((check) => ({ check, status: 'passed' })),
        operations: scenario.operations.map((operation) => {
          if (operation === 'export') return { operation, ...outcome(scenario, scenario.output, time) };
          if (operation === 'mixed-exports') return { operation, exports: Array.from({ length: scenario.exportCycles }, (_, index) => {
            const dimensions = [{ width: 640, height: 360 }, { width: 1920, height: 1080 }, { width: 720, height: 1280 }][index % 3];
            return outcome(scenario, { ...scenario.output, ...dimensions }, time);
          }) };
          if (operation === 'perf') {
            const drawHistogram = createHistogram(); const callbackGapHistogram = createHistogram();
            for (let index = 0; index < 60; index++) { recordHistogram(drawHistogram, 0.1); if (index) recordHistogram(callbackGapHistogram, 16.67); }
            return { operation, drawHistogram, callbackGapHistogram, draws: 60, durationMs: 1000, missingFrames: 0 };
          }
          return { operation };
        }) };
    })) };
}
const pairs = () => [
  { label: 'AB', baseline: fixture('baseline', 0), candidate: fixture('candidate', 1, [20, 40, 60]) },
  { label: 'BA', baseline: fixture('baseline', 3, [40, 50, 100]), candidate: fixture('candidate', 2, [80, 100, 200]) },
];

test('A/B summary preserves chronological reversal and weights each repetition equally', () => {
  const summary = summarizeAB(pairs());
  assert.equal(summary.balancedOrder, true);
  assert.deepEqual(summary.runs.map((run) => run.backend), ['baseline', 'candidate', 'candidate', 'baseline']);
  const output = summary.combined.find((row) => row.id === 'encode-h264-copy');
  assert.equal(output.baseline.exports[0].encodeMs.median, 35);
  assert.equal(output.candidate.exports[0].encodeMs.median, 70);
  assert.equal(output.baseline.exports[0].encodeMs.samples, 6);
  const mixed = summary.combined.find((row) => row.id === 'repeated-mixed-size-exports');
  assert.equal(mixed.baseline.exports.length, 3);
  assert.equal(mixed.baseline.verifiedExports, 120);
  assert.ok(mixed.baseline.exports.every((entry) => entry.encodeMs.median === 35));
});

test('unavailable old resource counters stay null rather than an invented zero', () => {
  const summary = summarizeAB(pairs());
  const row = summary.combined[0];
  assert.equal(row.baseline.memory.ownedBytes.peak.median, null);
  assert.equal(row.baseline.memory.ownedBytes.final.median, null);
  assert.equal(row.candidate.memory.ownedBytes.final.median, 0);
  assert.equal(summary.memoryBudget.baseline.applied, false);
  assert.match(renderABMarkdown(summary), /jamais remplacés par zéro/);
});

test('physical footprint growth is flagged even when RSS stays flat, and its table stays separate', () => {
  const input = pairs();
  const source = 'iOS task_vm_info phys_footprint';
  for (const pair of input) for (const backend of ['baseline', 'candidate']) for (const entry of pair[backend].cases) {
    for (const point of entry.memorySamples) {
      point.memory.rssBytes.value = 100e6;
      point.memory.physicalFootprintBytes = { value: 200e6, source };
    }
    if (backend === 'candidate' && entry.id === 'repeated-mixed-size-exports') {
      const point = entry.memorySamples[0];
      const settledMemory = entry.memorySamples.at(-1).memory;
      entry.memorySamples = [point, ...[10, 15, 19].map((cycle, index) => ({
        ...point, phase: 'settled', cycle, elapsedMs: (index + 1) * 600,
        collectedAtElapsedMs: (index + 1) * 600 + 1,
        memory: { ...settledMemory, physicalFootprintBytes: { value: 200e6 + index * 20e6, source } },
      }))];
    }
  }
  const summary = summarizeAB(input);
  const row = summary.combined.find((entry) => entry.id === 'repeated-mixed-size-exports');
  assert.equal(row.baseline.memory.rssBytes.peak.median, 100e6);
  assert.equal(row.candidate.memory.rssBytes.peak.median, 100e6);
  assert.equal(row.baseline.memory.physicalFootprintBytes.peak.median, 200e6);
  assert.equal(row.candidate.memory.physicalFootprintBytes.peak.median, 240e6);
  for (const pair of summary.comparisons) {
    const comparison = pair.comparison.cases.find((entry) => entry.id === row.id);
    assert.equal(comparison.assessment, 'failed');
    assert.ok(comparison.findings.includes('physicalFootprintBytes grows after warmup; inspect retained resources'));
    assert.ok(!comparison.findings.some((finding) => finding.startsWith('rssBytes')));
    assert.ok(comparison.memory.physicalFootprintBytes.candidateTrends.every((trend) => trend.delta === 40e6));
  }
  const markdown = renderABMarkdown(summary);
  assert.match(markdown, /Pic RSS ancien \/ nouveau/);
  assert.match(markdown, /Pic empreinte physique ancien \/ nouveau/);
  assert.match(markdown, /95\.37 \/ 95\.37/);
  assert.match(markdown, /190\.73 \/ 228\.88/);
  assert.match(markdown, /mesurée séparément du RSS/);
});

test('old JSON without physical footprint preserves unknown readings and does not invent an A/B percentage', () => {
  const input = pairs();
  for (const pair of input) for (const entry of pair.baseline.cases)
    for (const point of entry.memorySamples) delete point.memory.physicalFootprintBytes;
  for (const pair of input) for (const entry of pair.candidate.cases)
    for (const point of entry.memorySamples)
      point.memory.physicalFootprintBytes = { value: 80e6, source: 'iOS task_vm_info phys_footprint' };
  const summary = summarizeAB(input);
  const row = summary.combined[0];
  const previous = row.baseline.memory.physicalFootprintBytes;
  assert.equal(previous.peak.median, null);
  assert.equal(previous.final.median, null);
  assert.equal(previous.peak.samples, 0);
  assert.equal(previous.availability, 'unavailable-or-partial');
  assert.equal(row.candidate.memory.physicalFootprintBytes.peak.median, 80e6);
  assert.equal(summary.comparisons[0].comparison.cases[0].memory.physicalFootprintBytes.peak.status, 'unavailable');
  assert.match(renderABMarkdown(summary), /indisponible \/ 76\.29 \| indisponible/);
});

test('legacy simulator reports omit the footprint table and never substitute RSS for it', () => {
  const summary = summarizeAB(pairs());
  assert.equal(summary.combined[0].baseline.memory.rssBytes.peak.median, 150e6);
  assert.equal(summary.combined[0].baseline.memory.physicalFootprintBytes.peak.median, null);
  assert.equal(summary.combined[0].candidate.memory.physicalFootprintBytes.peak.median, null);
  assert.doesNotMatch(renderABMarkdown(summary), /Pic empreinte physique/);
  const oldSummary = structuredClone(summary);
  for (const rows of [oldSummary.combined, ...oldSummary.pairSummaries.map((pair) => pair.cases)])
    for (const row of rows) for (const backend of ['baseline', 'candidate']) delete row[backend].memory.physicalFootprintBytes;
  assert.doesNotThrow(() => renderABMarkdown(oldSummary));
  assert.doesNotMatch(renderABMarkdown(oldSummary), /Pic empreinte physique/);
  const normalized = normalizeMemory({ rssBytes: { value: 150e6, source: 'test RSS' },
    physicalFootprintBytes: { value: 80e6, source: 'iOS task_vm_info phys_footprint' } });
  assert.equal(normalized.physicalFootprintBytes.value, 80e6);
  assert.equal(normalized.rssBytes.value, 150e6);
  for (const reading of [undefined, { value: -1, source: 'iOS task_vm_info phys_footprint' }, { value: 80e6, source: null }]) {
    const unavailable = normalizeMemory({ rssBytes: { value: 150e6, source: 'test RSS' }, physicalFootprintBytes: reading });
    assert.equal(unavailable.physicalFootprintBytes.value, null);
    assert.equal(unavailable.rssBytes.value, 150e6);
  }
});

test('missing media validation stays incomplete although numerical measurements exist', () => {
  const input = pairs();
  for (const pair of input) for (const backend of ['baseline', 'candidate']) for (const entry of pair[backend].cases)
    for (const validation of entry.validations) validation.status = 'unavailable';
  const summary = summarizeAB(input);
  assert.equal(summary.assessment, 'incomplete');
  assert.equal(summary.combined[0].baseline.playback.callbacksPerSecond.median, 60);
  assert.match(renderABMarkdown(summary), /Media validation unavailable/);
});

test('incorrect output is excluded from numeric exports and preserves a failed verdict', () => {
  const input = pairs();
  const entry = input[0].candidate.cases.find((item) => item.id === 'encode-h264-copy');
  entry.operations[0].actualOutput.width++;
  const summary = summarizeAB(input);
  assert.equal(summary.assessment, 'failed');
  const row = summary.combined.find((item) => item.id === entry.id);
  assert.equal(row.candidate.invalidExports, 1);
  assert.equal(row.candidate.verifiedExports, 5);
  assert.match(renderABMarkdown(summary), /Encoded codec or dimensions differ/);
});

test('overlapping runs and changed backends cannot produce an A/B report', () => {
  const overlap = pairs();
  overlap[0].candidate.startedAt = overlap[0].baseline.startedAt;
  assert.throws(() => summarizeAB(overlap), /windows overlap/);
  const changed = pairs();
  changed[1].baseline.backend.version = 'different implementation';
  assert.throws(() => summarizeAB(changed), /Changed baseline implementation/);
});

test('clock or sampling changes between pairs are incompatible', () => {
  for (const modify of [
    (input) => { input[1].candidate.environment.measurementClock = 'Date.now'; },
    (input) => { input[1].baseline.cases[0].collection.periodMs = 1000; },
  ]) { const input = pairs(); modify(input); assert.throws(() => summarizeAB(input), /Incompatible/); }
});

test('missing RSS is explicitly unavailable and cannot become a memory pass', () => {
  const input = pairs();
  for (const pair of input) for (const entry of pair.baseline.cases)
    for (const point of entry.memorySamples) point.memory.rssBytes = { value: null, source: null };
  const summary = summarizeAB(input);
  assert.equal(summary.assessment, 'incomplete');
  assert.equal(summary.combined[0].baseline.memory.rssBytes.peak.median, null);
  assert.match(renderABMarkdown(summary), /indisponible/);
});

test('failed repetitions retain their failure and never add successful observations', () => {
  const input = pairs(); input[0].candidate.cases[0].status = 'failed';
  input[0].candidate.cases[0].reason = 'Fixture failed';
  const summary = summarizeAB(input);
  assert.equal(summary.assessment, 'failed');
  assert.equal(summary.combined[0].candidate.passed, 5);
  assert.equal(summary.combined[0].candidate.total, 6);
  assert.equal(summary.combined[0].candidate.playback.callbacksPerSecond.samples, 5);
  assert.equal(summary.combined[0].candidate.failures[0].reason, 'Fixture failed');
});

test('CLI preserves raw JSON and records hashes without leaking invented measurements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rnskv-ab-report-'));
  try {
    const pair = pairs()[0];
    const baseline = join(directory, 'old.json'); const candidate = join(directory, 'new.json');
    const output = join(directory, 'report.md'); const json = join(directory, 'summary.json');
    const original = JSON.stringify(pair.baseline);
    await writeFile(baseline, original); await writeFile(candidate, JSON.stringify(pair.candidate));
    const summary = await main(['--pair', 'AB', baseline, candidate, '--output', output, '--json', json]);
    assert.equal(summary.runs[0].source.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(await readFile(baseline, 'utf8'), original);
    assert.match(await readFile(output, 'utf8'), /Pipeline ancien \/ nouveau/);
    assert.equal(JSON.parse(await readFile(json, 'utf8')).combined[0].baseline.memory.ownedBytes.peak.median, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('different RSS collectors retain observations but do not calculate a percentage', () => {
  const input = pairs();
  for (const pair of input) for (const entry of pair.baseline.cases)
    for (const point of entry.memorySamples) point.memory.rssBytes.source = 'different RSS collector';
  const summary = summarizeAB(input);
  assert.equal(summary.assessment, 'incomplete');
  const firstDataLine = renderABMarkdown(summary).split('\n').find((line) => line.startsWith('| Lecture H.264 1080p |'));
  assert.match(firstDataLine, /indisponible/);
  assert.equal(summary.combined[0].baseline.memory.rssBytes.peak.median, 150000000);
});


test('a long gap between reversed pairs stays visible without inventing its cause', () => {
  const input = pairs();
  for (const backend of ['baseline', 'candidate']) {
    const result = input[1][backend];
    result.startedAt = new Date(Date.parse(result.startedAt) + 2 * 3600000).toISOString();
    result.finishedAt = new Date(Date.parse(result.finishedAt) + 2 * 3600000).toISOString();
  }
  const summary = summarizeAB(input);
  assert.equal(summary.balancedOrder, true);
  assert.equal(summary.interrunGaps.length, 3);
  assert.equal(summary.interrunGaps[1].seconds, 7230);
  const markdown = renderABMarkdown(summary);
  assert.match(markdown, /Intervalle prolongé : 120.5 minutes/);
  assert.match(markdown, /Examiner la cohérence des résultats par paire/);
  assert.doesNotMatch(markdown, /network|réseau/);
});

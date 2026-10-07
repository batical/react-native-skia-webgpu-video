import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildCases, randomSource, expectedFrameCount } from '../../benchmark/cases.mjs';
import { FIXTURES, validateFixtureManifest } from '../../benchmark/fixtures.mjs';
import { memoryTrend, normalizeMemory, createHistogram, recordHistogram } from '../../benchmark/metrics.mjs';
import { annotateFailureStage, failureDiagnostic, runBenchmarks, runCase } from '../../benchmark/runner.mjs';
import { compareResults } from '../../benchmark/compare.mjs';
import { parseAndroidMemory } from '../../benchmark/android-memory.mjs';
import { mergeMemorySamples } from '../../benchmark/merge-memory.mjs';
import { createPublicApiAdapter } from '../../benchmark/public-api-adapter.mjs';
import { previewDimensions, detachPreviewSession } from '../../benchmark/preview-lifecycle.mjs';

const manifest = { schema: 1, files: FIXTURES.map((fixture) => ({ ...fixture, sha256: 'a'.repeat(64), bytes: 1024 })) };
const environment = { deviceId: 'physical-test-fixture', deviceModel: 'fixture', executionTarget: 'device', measurementClock: 'fixture monotonic clock', platform: 'ios', osVersion: 'test', reactNativeVersion: '0.86.2', buildMode: 'release', displayRefreshRate: 60, pixelRatio: 1, thermalState: 'nominal', powerMode: 'normal' };
const options = { fixtureManifest: manifest, fixtureDirectory: '/fixture', environment, backend: { name: 'fixture', paths: { decoder: 'fake', renderer: 'fake', encoder: 'fake' } }, settleMs: 0, enableIntervalSampling: false };
function fakeAdapter() {
  let time = 0;
  const calls = [];
  return { calls, paths: options.backend.paths, now: () => time, sleep: async (ms) => { time += ms; }, mount: async (config) => { calls.push(['mount', config]); return config; }, unmount: async () => { calls.push(['unmount']); }, play: async () => { calls.push(['play']); }, seek: async (_session, position, config) => { calls.push(['seek', position, config]); time += 8; return { correct: true }; }, playToEnd: async () => ({ completed: true }), measurePlayback: async () => ({ draws: 60, droppedFrames: null }), loop: async () => ({ wrapped: true }), outputPath: async () => '/fixture/out.mp4', removeOutput: async () => { calls.push(['remove-output']); }, export: async ({ composition, output, signal, onProgress }) => {
    calls.push(['export', output]);
    if (signal?.aborted) { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; }
    const total = expectedFrameCount(composition.duration, output.frameRate);
    for (let frame = 1; frame <= total; frame++) {
      onProgress?.({ framesCompleted: frame, nbFrames: total });
      if (signal?.aborted) { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; }
      time += 2;
    }
    return { encodeMs: total * 2, probeMs: 0, actualOutput: { width: output.width, height: output.height,
      codec: output.codec === 'unknown-fallback' ? 'h264' : output.codec, fps: output.frameRate,
      duration: total / output.frameRate, frameCount: total, timestampsMonotonic: true, presentationTimesExact: true } };
  }, validate: async ({ check }) => ({ check, status: 'passed' }),
    sampleOperatingConditions: async () => ({ thermalState: 'nominal', powerMode: 'normal', source: 'fixture-native-operating-conditions' }),
    sampleMemory: async () => ({ rssBytes: { value: 100 * 1024 * 1024, source: 'fixture-native-collector' } }) };
}

test('all legacy stress cases stay in the matrix, independently of missing media', () => {
  const cases = buildCases();
  assert.equal(cases.length, 65);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  for (const name of ['montage-all-crossfade-eager', 'montage-all-crossfade-lazy', 'montage-all-crossfade-lazy-direct', '4k-x8-lazy', '4k-x8-lazy-maxLongSide1280', '4k-x8-lazy-direct', '4k-x8-eager', '4k-x3-simultaneous', 'shorts-x20-lazy', 'audio-lazy', 'start-past-file-end']) assert.ok(cases.some((entry) => entry.id === name));
  for (const fixture of FIXTURES.slice(0, 10)) for (const suffix of ['', '-direct']) assert.ok(cases.some((entry) => entry.id === `single-${fixture.file}${suffix}`));
});

test('fixed seed reproduces seeks and churn timings; a new seed changes them', () => {
  assert.deepEqual(buildCases({ seed: 42 }), buildCases({ seed: 42 }));
  assert.notDeepEqual(buildCases({ seed: 42 })[0].scrubTimes, buildCases({ seed: 43 })[0].scrubTimes);
  const random = randomSource(1);
  for (let i = 0; i < 1000; i++) assert.ok(random() >= 0 && random() < 1);
});

test('summed decimal durations match legacy whole-frame rounding', () => {
  assert.equal(expectedFrameCount(0.1 + 0.2, 30), 9);
  assert.equal(expectedFrameCount(1.01, 30), 31);
});

test('unverified fixtures cannot run a benchmark', () => {
  assert.throws(() => validateFixtureManifest({ schema: 1, files: [{ id: 'h264-638x358', sha256: 'invalid', bytes: 0 }] }, ['h264-638x358']), /Invalid verified fixture/);
});

test('memory trend excludes warmup and running samples', () => {
  const memory = (value) => ({ rssBytes: { value, source: 'native' } });
  const samples = [{ elapsedMs: 0, phase: 'settled', cycle: 0, memory: memory(500) }, { elapsedMs: 60000, phase: 'settled', cycle: 10, memory: memory(100) }, { elapsedMs: 120000, phase: 'running', cycle: 20, memory: memory(9000) }, { elapsedMs: 120000, phase: 'settled', cycle: 20, memory: memory(200) }, { elapsedMs: 180000, phase: 'settled', cycle: 30, memory: memory(300) }];
  const trend = memoryTrend(samples, 'rssBytes');
  assert.equal(trend.slopePerMinute, 100);
  assert.equal(trend.delta, 200);
  assert.equal(trend.peak, 300);
});

test('JS heap or invalid counters never become native/GPU/RSS measurements', () => {
  const result = normalizeMemory({ jsHeapBytes: 1000, nativeHeapBytes: { value: -1, source: 'bad' } });
  assert.equal(result.rssBytes.value, null);
  assert.equal(result.gpuBytes.value, null);
  assert.equal(result.nativeHeapBytes.value, null);
});

test('runner cancellation waits for rejection and releases output after it', async () => {
  const adapter = fakeAdapter();
  const scenario = buildCases().find((entry) => entry.id === 'cancel-mid-export');
  scenario.operations = ['cancel-export'];
  const result = await runCase(adapter, scenario, options);
  assert.equal(result.status, 'passed');
  assert.equal(result.operations[0].cancelled, true);
  assert.equal(result.operations[0].framesCompleted, 10);
  assert.equal(adapter.calls.at(-1)[0], 'remove-output');
});

test('bad progress becomes a recorded failure, not an exception in an event callback', async () => {
  const adapter = fakeAdapter();
  adapter.export = async ({ onProgress }) => { onProgress({ framesCompleted: 999, nbFrames: 999 }); return {}; };
  const scenario = buildCases().find((entry) => entry.id === 'encode-h264-copy');
  const result = await runCase(adapter, scenario, options);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Invalid export progress/);
});

test('missing fixtures and extensions are explicit skips, never removed scenarios', async () => {
  const result = await runBenchmarks(fakeAdapter(), { ...options, caseIds: ['extension-three', 'encode-h264-copy'], repetitions: 1, fixtureManifest: { schema: 1, files: [] } });
  assert.equal(result.caseCatalog.length, 2);
  assert.equal(result.cases.length, 2);
  assert.ok(result.cases.every((entry) => entry.status === 'skipped'));
});

test('missing preview observation is an explicit skip for clock and pruning assertions', async () => {
  const result = await runBenchmarks(fakeAdapter(), { ...options, caseIds: ['paused-clock-and-resume', 'closed-item-leaves-frame-map'], repetitions: 1 });
  assert.ok(result.cases.every((entry) => entry.status === 'skipped'));
  assert.match(result.cases[0].reason, /Preview capability/);
});

test('seeks and scrubs while playing preserve playback rather than testing paused seeks', async () => {
  const adapter = fakeAdapter();
  adapter.pause = async () => { adapter.calls.push(['pause']); };
  for (const id of ['seek-while-playing', 'scrub-while-playing']) {
    const result = await runCase(adapter, buildCases().find((entry) => entry.id === id), options);
    assert.equal(result.status, 'passed');
    assert.equal(result.operations[0].whilePlaying, true);
  }
  assert.ok(adapter.calls.filter((entry) => entry[0] === 'seek').every((entry) => entry[2].preservePlaying));
  assert.equal(adapter.calls.filter((entry) => entry[0] === 'pause').length, 2);
});

test('pause/resume observes an actual clock and rejects a clock which keeps advancing paused', async () => {
  const adapter = fakeAdapter();
  let time = 0.5;
  let playing = false;
  adapter.play = async () => { playing = true; };
  adapter.pause = async () => { playing = false; };
  adapter.observe = async () => ({ currentTime: time });
  const sleep = adapter.sleep;
  adapter.sleep = async (ms) => { await sleep(ms); if (playing) time += ms / 1000; };
  const scenario = buildCases().find((entry) => entry.id === 'paused-clock-and-resume');
  const result = await runCase(adapter, scenario, options);
  assert.equal(result.status, 'passed');
  assert.equal(result.operations[0].pausedDelta, 0);
  assert.ok(result.operations[0].resumedDelta > 0.1);
  adapter.pause = async () => { playing = true; };
  assert.equal((await runCase(adapter, scenario, options)).status, 'failed');
});

test('closed-item pruning examines all frame-map keys rather than visible item IDs', async () => {
  const adapter = fakeAdapter();
  adapter.observe = async () => ({ frameIds: ['clip-0', 'clip-2'] });
  const scenario = buildCases().find((entry) => entry.id === 'closed-item-leaves-frame-map');
  const failed = await runCase(adapter, scenario, options);
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /Closed item remains/);
  adapter.observe = async () => ({ frameIds: ['clip-2'] });
  const passed = await runCase(adapter, scenario, options);
  assert.equal(passed.status, 'passed');
  assert.deepEqual(passed.operations[0].removedIds, ['clip-0', 'clip-1']);
});

test('missing audio permits a bounded clean error but never accepts a hanging export', async () => {
  const adapter = fakeAdapter();
  adapter.export = async () => { throw new Error('No audio track'); };
  const scenario = buildCases().find((entry) => entry.id === 'audio-track-absent-does-not-hang');
  const clean = await runCase(adapter, scenario, options);
  assert.equal(clean.status, 'passed');
  assert.equal(clean.operations[0].cleanFailure, true);
  adapter.export = async () => new Promise(() => {});
  const hung = await runCase(adapter, scenario, { ...options, exportDeadlineMs: 5 });
  assert.equal(hung.status, 'failed');
  assert.equal(hung.unsafeToContinue, true);
});

async function validResult() {
  return runBenchmarks(fakeAdapter(), { ...options, caseIds: ['encode-h264-copy'], repetitions: 3 });
}
test('comparator refuses different fixture hashes, device, build, seed or dimensions', async () => {
  const before = await validResult();
  for (const modify of [
    (result) => { result.seed++; },
    (result) => { result.environment.deviceId = 'another-device'; },
    (result) => { result.environment.buildMode = 'debug'; },
    (result) => { result.fixtureManifest.files.find((entry) => entry.id === 'h264-638x358').sha256 = 'b'.repeat(64); },
    (result) => { result.caseCatalog[0].output.width = 1280; },
    (result) => { result.memoryBudget.requestedMaxBytes = 512 * 1024 * 1024; },
  ]) { const after = structuredClone(before); modify(after); assert.throws(() => compareResults(before, after), /Incompatible/); }
});

test('comparator reports measured export regression without penalizing settle duration', async () => {
  const before = await validResult();
  const after = structuredClone(before);
  for (const entry of after.cases) entry.operations[0].exportMs += 200;
  const report = compareResults(before, after);
  assert.equal(report.assessment, 'failed');
  assert.ok(report.cases[0].findings.includes('Export duration regression'));
});

test('comparator detects settled memory growth after warmup', async () => {
  const before = await runBenchmarks(fakeAdapter(), { ...options,
    caseIds: ['repeated-mixed-size-exports'], repetitions: 3 });
  const after = structuredClone(before);
  for (const entry of after.cases) entry.memorySamples = [10, 15, 19].map((cycle, index) => ({ phase: 'settled', cycle, elapsedMs: index * 60000, memory: normalizeMemory({ rssBytes: { value: 100e6 + index * 10e6, source: 'fixture-native-collector' } }) }));
  const report = compareResults(before, after);
  assert.equal(report.assessment, 'failed');
  assert.ok(report.cases[0].findings.some((entry) => entry.includes('grows after warmup')));
});

test('missing physical memory yields incomplete, never a memory pass', async () => {
  const before = await validResult();
  const after = structuredClone(before);
  for (const entry of after.cases) for (const sample of entry.memorySamples) sample.memory = normalizeMemory();
  assert.equal(compareResults(before, after).assessment, 'incomplete');
});

test('histograms retain constant storage for prolonged frame pacing measurements', () => {
  const histogram = createHistogram();
  for (let i = 0; i < 100000; i++) recordHistogram(histogram, i % 25);
  assert.equal(histogram.counts.length, 15);
  assert.equal(histogram.total, 100000);
});

test('Android collector distinguishes native PSS, process RSS and partial graphics accounting', () => {
  const parsed = parseAndroidMemory(' Native Heap   100  0 0\n GL mtrack 200 0 0\n EGL mtrack 50 0 0\n TOTAL 500 0 0\n', 'VmRSS: 800 kB\n');
  assert.equal(parsed.rssBytes.value, 800 * 1024);
  assert.equal(parsed.nativeHeapBytes.value, 100 * 1024);
  assert.equal(parsed.pssBytes.value, 500 * 1024);
  assert.equal(parsed.graphicsMtrackBytes.value, 250 * 1024);
  assert.equal(parsed.gpuBytes.value, null);
});

test('external samples require measured clock offset and respect max alignment gap', async () => {
  const result = await validResult();
  const entry = result.cases[0];
  const point = entry.memorySamples[0];
  const samples = [{ wallTime: new Date(Date.parse(entry.startedAt) + point.elapsedMs - 1000).toISOString(), memory: { rssBytes: { value: 1234, source: 'host-collector' } } }];
  assert.throws(() => mergeMemorySamples(result, samples, {}), /explicit measured clock offset/);
  assert.equal(mergeMemorySamples(result, samples, { clockOffsetMs: 1000, maxGapMs: 10 }).cases[0].memorySamples[0].memory.rssBytes.value, 1234);
  assert.notEqual(mergeMemorySamples(result, samples, { clockOffsetMs: 0, maxGapMs: 10 }).cases[0].memorySamples[0].memory.rssBytes.value, 1234);
});

test('public adapter forwards abortSignal and codec through the legacy contract', async () => {
  let captured;
  const adapter = createPublicApiAdapter({ video: { exportVideoComposition: async (options) => { captured = options; } }, preview: {}, clock: { now: () => 0, sleep: async () => {} }, files: { stat: async () => ({ size: 100 }) }, drawFrame: () => () => {} });
  const controller = new AbortController();
  await adapter.export({ scenario: {}, composition: {}, output: { codec: 'hevc' }, outputPath: '/fixture/out', signal: controller.signal });
  assert.equal(captured.abortSignal, controller.signal);
  assert.equal(captured.codec, 'hevc');
  assert.equal(captured.signal, undefined);
});

test('explicit memory budget is applied before workloads and absent backend enforcement is recorded', async () => {
  const bytes = 512 * 1024 * 1024;
  let applied;
  const adapter = fakeAdapter();
  adapter.configureMemoryBudget = async (maxBytes) => { applied = maxBytes; return { requestedMaxBytes: maxBytes, applied: true, reportedMaxBytes: maxBytes }; };
  const mount = adapter.mount;
  adapter.mount = async (...args) => { assert.equal(applied, bytes); return mount(...args); };
  const result = await runBenchmarks(adapter, { ...options, memoryBudgetBytes: bytes, caseIds: ['single-h264-638x358.mp4'], repetitions: 1 });
  assert.equal(result.memoryBudget.reportedMaxBytes, bytes);
  delete adapter.configureMemoryBudget;
  const unenforced = await runBenchmarks(adapter, { ...options, memoryBudgetBytes: bytes, caseIds: ['encode-h264-copy'], repetitions: 3 });
  assert.equal(unenforced.memoryBudget.applied, false);
  assert.equal(unenforced.memoryBudget.requestedMaxBytes, bytes);
  await assert.rejects(runBenchmarks(adapter, { ...options, memoryBudgetBytes: 0 }), /positive safe integer/);
});

test('public adapter applies candidate budget and records legacy API absence without pretending enforcement', async () => {
  let configured;
  const config = { preview: {}, clock: {}, files: {}, drawFrame: () => () => {} };
  const candidate = createPublicApiAdapter({ ...config, video: { exportVideoComposition: () => {}, configureVideoMemory: (value) => { configured = value; }, getVideoResourceStats: () => ({ budget: { maxBytes: 2048 } }) } });
  assert.deepEqual(await candidate.configureMemoryBudget(2048), { requestedMaxBytes: 2048, applied: true, reportedMaxBytes: 2048 });
  assert.deepEqual(configured, { maxBytes: 2048 });
  const legacy = createPublicApiAdapter({ ...config, video: { exportVideoComposition: () => {} } });
  assert.equal((await legacy.configureMemoryBudget(2048)).applied, false);
  await assert.rejects(candidate.configureMemoryBudget(4096), /did not apply/);
});

test('public adapter keeps reservation estimates distinct from native process memory', async () => {
  const adapter = createPublicApiAdapter({ video: { exportVideoComposition: () => {}, getVideoResourceStats: () => ({ budget: { currentBytes: 1024, allocations: 2 }, native: { decodersCurrent: 3, encoderSubmittingBuffersCurrent: 1 } }) }, preview: {}, clock: {}, files: {}, drawFrame: () => () => {} });
  const sample = normalizeMemory(await adapter.sampleMemory({}));
  assert.equal(sample.ownedBytes.value, 1024);
  assert.equal(sample.ownedResources.value, 2);
  assert.equal(sample.decoderCount.value, 3);
  assert.equal(sample.inFlightFrames.value, 1);
  assert.equal(sample.rssBytes.value, null);
});

test('baseline inventory includes all 40 JS tests and all native source cases', async () => {
  const inventory = JSON.parse(await readFile(new URL('../../benchmark/baseline-test-inventory.json', import.meta.url), 'utf8'));
  assert.deepEqual(inventory.counts, { jest: 40, 'cpp-host': 20, 'android-host': 12, 'android-device': 40, 'ios-device': 50 });
  assert.equal(inventory.cases.length, 162);
  assert.ok(inventory.cases.every((entry) => entry.reproduction && entry.line > 0));
  assert.ok(inventory.cases.every((entry) => entry.candidateAssertion?.line > 0));
  assert.equal(inventory.schema, 3);
  assert.ok(inventory.cases.every((entry) => /^[a-f0-9]{64}$/.test(entry.sourceSha256)));
  const workloadIds = new Set(inventory.sharedWorkloads.map((entry) => entry.id));
  for (const entry of inventory.cases) for (const id of entry.scenarioIds ?? []) assert.ok(workloadIds.has(id));
  assert.ok(inventory.cases.filter((entry) => entry.kind === 'jest' || entry.kind.endsWith('-host')).every((entry) => entry.candidateAssertion));
  assert.ok(inventory.cases.filter((entry) => entry.kind === 'android-device').every((entry) => entry.executionStatus === 'pending-device-run'));
  const { currentSimulatorVerification } = await import('../../scripts/benchmark-record-ios-simulator-verification.mjs');
  const simulator = await currentSimulatorVerification(JSON.parse(await readFile(
    new URL('../../benchmark/ios-simulator-verification.json', import.meta.url), 'utf8')));
  const ios = inventory.cases.filter((entry) => entry.kind === 'ios-device');
  assert.ok(ios.every((entry) => entry.executionStatus === (simulator ? 'passed-ios-simulator' : 'pending-device-run')));
  if (simulator) {
    assert.equal(ios.length, simulator.passedCases.length);
    assert.ok(ios.every((entry) => simulator.passedAssertions.includes(`${entry.candidateAssertion.file}:${entry.candidateAssertion.name}`)));
    assert.ok(ios.every((entry) => entry.hardwareQualification === 'pending-physical-ios-run'));
  }
  assert.ok(inventory.cases.filter((entry) => entry.kind === 'ios-device').every((entry) => entry.candidateAssertion?.file === 'ios/tests/LegacyParityTests.mm'));
  assert.equal(inventory.cases.filter((entry) => entry.kind === 'ios-device' && entry.status === 'intentional-safety-change').length, 3);
});

test('invalid manifests and empty selections are configuration failures, not media skips', async () => {
  await assert.rejects(runBenchmarks(fakeAdapter(), { ...options, fixtureManifest: { schema: 99, files: [] } }), /Unsupported fixture manifest/);
  const corrupt = structuredClone(manifest);
  corrupt.files.find((entry) => entry.id === 'h264-638x358').sha256 = 'broken';
  await assert.rejects(runBenchmarks(fakeAdapter(), { ...options, fixtureManifest: corrupt, caseIds: ['encode-h264-copy'] }), /Invalid verified fixture/);
  await assert.rejects(runBenchmarks(fakeAdapter(), { ...options, caseIds: ['a-typo'] }), /No workloads/);
});

test('physical preview pixels are identical at 1x, 2x, 3x and fractional pixel ratios', () => {
  const preview = buildCases()[0].preview;
  for (const pixelRatio of [1, 2, 3, 2.625, 3.5]) {
    const dimensions = previewDimensions(preview, pixelRatio);
    assert.equal(Math.floor(dimensions.logicalWidth * pixelRatio), 720);
    assert.equal(Math.floor(dimensions.logicalHeight * pixelRatio), 720);
    assert.equal(dimensions.pixelWidth, 720);
  }
  assert.throws(() => previewDimensions({ width: 720, height: 720 }, 3), /physical pixel/);
  assert.throws(() => previewDimensions(preview, 0), /physical pixel/);
});

test('preview teardown waits for the child unmount, not only a null controller', async () => {
  const session = { player: null, detached: false };
  const order = [];
  await detachPreviewSession(session, {
    deactivate: () => { order.push('deactivate'); },
    waitFor: async (predicate, timeout, checkErrors) => {
      assert.equal(predicate(), false);
      assert.equal(timeout, 10000);
      assert.equal(checkErrors, false);
      order.push('hook-cleanup');
      session.detached = true;
      assert.equal(predicate(), true);
    },
    flushUiQueue: async () => { order.push('ui-acknowledged'); },
  });
  assert.deepEqual(order, ['deactivate', 'hook-cleanup', 'ui-acknowledged']);
  await assert.rejects(detachPreviewSession(session, {
    deactivate: () => {}, waitFor: async () => {}, flushUiQueue: async () => { throw new Error('lost runtime'); },
  }), (error) => error.unsafeToContinue === true);
});

test('the screen owns a real preview child per repetition and closes it after an expected open error', async () => {
  const React = await import('react');
  const { create, act } = await import('react-test-renderer');
  const { createBenchmarkScreen } = await import('../../benchmark/screen.mjs');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let live = 0, mounted = 0, closed = 0, result;
  const useSharedValue = (initial) => {
    const ref = React.useRef(null);
    ref.current ??= { value: initial, modify: (fn) => { ref.current.value = fn(ref.current.value); } };
    return ref.current;
  };
  const Screen = createBenchmarkScreen({
    React, native: { View: 'View', Text: 'Text', Button: 'Button', PixelRatio: { get: () => 3 } },
    skia: { Canvas: 'Canvas', Image: 'Image' },
    reanimated: { useSharedValue, runOnUI: (fn) => fn, runOnJS: (fn) => fn },
    video: { exportVideoComposition: async () => {}, drawVideoFrame: () => {},
      useVideoCompositionPlayer: (config) => {
        assert.ok(config.composition);
        React.useEffect(() => {
          live++; mounted++;
          config.onError(new Error('Expected missing file'));
          return () => { live--; closed++; };
        }, []);
        return { player: null, currentFrame: null };
      } },
    files: {}, memory: { sample: async () => ({}) },
  });
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(Screen, {
      options: { ...options, repetitions: 2, caseIds: ['missing-file'], autorun: true },
      onResult: (value) => { result = value; },
    }));
  });
  for (let attempt = 0; attempt < 30 && !result; attempt++)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.ok(result, 'Expected the two bounded open-error repetitions to finish');
  assert.equal(result.cases.length, 2);
  assert.ok(result.cases.every((entry) => entry.status === 'passed'));
  assert.equal(mounted, 2);
  assert.equal(closed, 2);
  assert.equal(live, 0);
  assert.equal(renderer.root.findAllByType('Canvas').length, 0);
  await act(async () => renderer.unmount());
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

test('mixed-size exports abort on a deadline and block all following workloads', async () => {
  const adapter = fakeAdapter();
  let signal;
  adapter.export = async (config) => { signal = config.signal; return new Promise(() => {}); };
  const result = await runBenchmarks(adapter, { ...options,
    caseIds: ['repeated-mixed-size-exports', 'seek-past-end-resume'], repetitions: 3, exportDeadlineMs: 5 });
  assert.equal(result.cases[0].status, 'failed');
  assert.equal(result.cases[0].unsafeToContinue, true);
  assert.equal(signal.aborted, true);
  assert.equal(result.cases[1].status, 'skipped');
  assert.match(result.cases[1].reason, /restart the process/);
  assert.ok(!adapter.calls.some((entry) => entry[0] === 'remove-output'));
});

test('an asynchronous running RSS sample never becomes a settled sample', async () => {
  const adapter = fakeAdapter();
  let resolveRunning;
  let deferred = false;
  adapter.sampleMemory = async ({ phase }) => {
    if (phase === 'running' && !deferred) {
      // The initial call is immediate; defer the interval during an export.
      if (!adapter.inExport) return { rssBytes: { value: 100, source: 'native' } };
      deferred = true;
      return new Promise((resolve) => { resolveRunning = resolve; });
    }
    if (phase === 'settled' && resolveRunning) {
      resolveRunning({ rssBytes: { value: 9999, source: 'native' } });
      resolveRunning = null;
      await Promise.resolve();
    }
    return { rssBytes: { value: 100, source: 'native' } };
  };
  const exporting = adapter.export;
  adapter.export = async (config) => {
    adapter.inExport = true;
    await new Promise((resolve) => setTimeout(resolve, 8));
    adapter.inExport = false;
    return exporting(config);
  };
  const scenario = buildCases().find((entry) => entry.id === 'repeated-mixed-size-exports');
  scenario.exportCycles = 1;
  const result = await runCase(adapter, scenario, { ...options, enableIntervalSampling: true, memorySamplePeriodMs: 1 });
  assert.equal(result.status, 'passed');
  const delayed = result.memorySamples.find((sample) => sample.memory.rssBytes.value === 9999);
  assert.ok(delayed);
  assert.equal(delayed.phase, 'running');
  assert.ok(delayed.collectedAtElapsedMs >= delayed.elapsedMs);
});

test('memory telemetry stays bounded and a truncated collection cannot qualify', async () => {
  const result = await runBenchmarks(fakeAdapter(), { ...options,
    caseIds: ['repeated-mixed-size-exports'], repetitions: 3, maxMemorySamples: 4 });
  for (const entry of result.cases) {
    assert.equal(entry.memorySamples.length, 4);
    assert.ok(entry.collection.memorySamplesDropped > 0);
  }
  assert.equal(compareResults(result, structuredClone(result)).assessment, 'incomplete');
});

test('comparator requires every requested operation and validation on both backends', async () => {
  const complete = await validResult();
  assert.equal(compareResults(complete, structuredClone(complete)).assessment, 'passed');
  for (const modify of [
    (entry) => { entry.operations = []; },
    (entry) => { entry.validations = []; },
    (entry) => { entry.validations[0].status = 'unavailable'; },
  ]) {
    const incomplete = structuredClone(complete);
    modify(incomplete.cases[0]);
    assert.equal(compareResults(complete, incomplete).assessment, 'incomplete');
    assert.equal(compareResults(incomplete, complete).assessment, 'incomplete');
  }
});

test('comparator does not hide a missing physical memory repetition in the median', async () => {
  const before = await validResult();
  const after = structuredClone(before);
  after.cases[1].memorySamples.forEach((point) => { point.memory = normalizeMemory(); });
  assert.equal(compareResults(before, after).assessment, 'incomplete');
});

test('identically wrong encoded dimensions or timestamps fail instead of qualifying', async () => {
  const complete = await validResult();
  for (const corrupt of [
    (output) => { output.width = 1280; },
    (output) => { output.codec = 'hevc'; },
    (output) => { output.frameCount--; },
    (output) => { output.presentationTimesExact = false; },
  ]) {
    const bad = structuredClone(complete);
    for (const entry of bad.cases) corrupt(entry.operations[0].actualOutput);
    assert.equal(compareResults(bad, structuredClone(bad)).assessment, 'failed');
  }
  const noProbe = structuredClone(complete);
  for (const entry of noProbe.cases) entry.operations[0].actualOutput = null;
  assert.equal(compareResults(noProbe, complete).assessment, 'incomplete');
});

test('encode time is measured separately from full media decoding and file cleanup', async () => {
  let time = 0;
  const adapter = createPublicApiAdapter({
    video: { exportVideoComposition: async () => { time += 40; } }, preview: {},
    clock: { now: () => time, sleep: async () => {} }, drawFrame: () => () => {},
    files: { stat: async () => { time += 10; return { size: 100 }; },
      probe: async () => { time += 90; return { codec: 'h264', width: 640, height: 360 }; } },
  });
  const output = await adapter.export({ scenario: {}, composition: {}, output: {},
    outputPath: '/fixture/out.mp4' });
  assert.equal(output.encodeMs, 40);
  assert.equal(output.probeMs, 100);
});

test('a measured zero baseline does not suppress an absolute encode regression', async () => {
  const before = await validResult();
  const after = structuredClone(before);
  for (const entry of before.cases) entry.operations[0].encodeMs = 0;
  for (const entry of after.cases) entry.operations[0].encodeMs = 200;
  assert.equal(compareResults(before, after).assessment, 'failed');
});

test('pixel ratio and declared repetition IDs are validated for comparison', async () => {
  const before = await validResult();
  const after = structuredClone(before);
  after.environment.pixelRatio = 3;
  assert.throws(() => compareResults(before, after), /pixelRatio/);
  after.environment.pixelRatio = before.environment.pixelRatio;
  after.cases[0].repetition = after.repetitions;
  assert.throws(() => compareResults(before, after), /Invalid repetition/);
  assert.throws(() => compareResults({ ...before, cases: [], caseCatalog: [] }, after), /incomplete benchmark/);
});

test('a missing-audio workload never converts a GPU/encoder failure into an expected error', async () => {
  const adapter = fakeAdapter();
  adapter.export = async () => { throw new Error('GPU completion fence failed'); };
  const result = await runCase(adapter, buildCases().find((entry) => entry.id === 'audio-track-absent-does-not-hang'), options);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /GPU completion/);
});

test('retained library reservations after teardown block subsequent workloads', async () => {
  const adapter = fakeAdapter();
  let bytes = 0;
  adapter.verifyOwnedCleanup = true;
  adapter.sampleMemory = async () => ({ rssBytes: { value: 1000, source: 'native' },
    ownedBytes: { value: bytes, source: 'library budget' } });
  const exporting = adapter.export;
  adapter.export = async (config) => { bytes = 4096; return exporting(config); };
  const result = await runBenchmarks(adapter, { ...options,
    caseIds: ['encode-h264-copy', 'cancel-before-export'], repetitions: 3 });
  assert.equal(result.cases[0].status, 'failed');
  assert.equal(result.cases[0].unsafeToContinue, true);
  assert.deepEqual(result.cases[0].collection.ownedCleanup.ownedBytes, { before: 0, after: 4096 });
  assert.equal(result.cases[1].status, 'skipped');
  assert.match(result.cases[1].reason, /restart the process/);
});

test('a missing-file workload rejects preview timeouts and unrelated initialization errors', async () => {
  const scenario = buildCases().find((entry) => entry.id === 'missing-file');
  for (const message of ['Preview operation timed out', 'Cannot allocate GPU surface']) {
    const adapter = fakeAdapter();
    adapter.mount = async () => { throw new Error(message); };
    const result = await runCase(adapter, scenario, options);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, message);
  }
  const adapter = fakeAdapter();
  adapter.mount = async () => { throw new Error('No video track for path: /fixture/intentionally-missing.mp4'); };
  assert.equal((await runCase(adapter, scenario, options)).status, 'passed');
});

test('process RSS before an export alone cannot validate the settled memory phase', async () => {
  const before = await validResult();
  const after = structuredClone(before);
  after.cases[0].memorySamples = after.cases[0].memorySamples.filter((point) => point.phase === 'running');
  assert.equal(compareResults(before, after).assessment, 'incomplete');
});

test('mixed-size metadata and requested cycle counts are validated', async () => {
  const before = await runBenchmarks(fakeAdapter(), { ...options, caseIds: ['repeated-mixed-size-exports'], repetitions: 3 });
  assert.equal(compareResults(before, structuredClone(before)).assessment, 'passed');
  const corrupt = structuredClone(before);
  corrupt.cases[0].operations[0].exports[1].actualOutput.height = 500;
  assert.equal(compareResults(before, corrupt).assessment, 'failed');
  const missing = structuredClone(before);
  missing.cases[0].operations[0].exports.pop();
  assert.equal(compareResults(before, missing).assessment, 'incomplete');
});

test('changed transport and known budget API differences are reported without invalidating comparable measurements', async () => {
  const before = await validResult();
  const after = structuredClone(before);
  after.backend.paths = { decodeTransport: 'cpu-rgba-readback', zeroCopy: false };
  after.memoryBudget.applied = true;
  const report = compareResults(before, after);
  assert.equal(report.assessment, 'passed');
  assert.equal(report.warnings.length, 2);
  assert.equal(report.confounders.length, 0);
  delete after.environment.powerMode;
  assert.equal(compareResults(before, after).assessment, 'incomplete');
});

test('identically corrupted fixture identities cannot validate completed benchmark results', async () => {
  const complete = await validResult();
  const bad = structuredClone(complete);
  bad.fixtureManifest.files.find((entry) => entry.id === 'h264-638x358').sha256 = 'broken';
  assert.throws(() => compareResults(bad, structuredClone(bad)), /Invalid verified fixture/);
  bad.fixtureManifest = structuredClone(manifest);
  bad.fixtureManifest.files.push(structuredClone(bad.fixtureManifest.files[0]));
  assert.throws(() => compareResults(bad, structuredClone(bad)), /Duplicate fixture identity/);
});

test('operating conditions are sampled throughout a case, not assumed from startup constants', async () => {
  const before = await validResult();
  const after = structuredClone(before);
  after.cases[0].memorySamples[1].operatingConditions.thermalState = 'serious';
  for (const entry of after.cases) entry.operations[0].exportMs += 200;
  const report = compareResults(before, after);
  assert.equal(report.assessment, 'incomplete');
  assert.ok(report.cases[0].confounders.some((message) => message.includes('non-nominal')));
  assert.ok(report.cases[0].findings.some((message) => message.includes('qualified performance verdict')));
  const missing = structuredClone(before);
  delete missing.cases[1].memorySamples[0].operatingConditions;
  assert.equal(compareResults(before, missing).assessment, 'incomplete');
});

test('a failed operating-condition collector does not erase a valid RSS reading', async () => {
  const adapter = fakeAdapter();
  adapter.sampleOperatingConditions = async () => { throw new Error('conditions unavailable'); };
  const result = await runCase(adapter, buildCases().find((entry) => entry.id === 'encode-h264-copy'), options);
  assert.equal(result.status, 'passed');
  assert.ok(result.memorySamples.every((point) => point.memory.rssBytes.value > 0));
  assert.ok(result.memorySamples.every((point) => point.operatingConditions.thermalState === null));
});

test('identically missing device identities cannot qualify unknown environments', async () => {
  const complete = await validResult();
  for (const field of ['deviceId', 'deviceModel', 'osVersion', 'reactNativeVersion', 'pixelRatio', 'displayRefreshRate']) {
    const missing = structuredClone(complete);
    delete missing.environment[field];
    assert.throws(() => compareResults(missing, structuredClone(missing)), /Missing measured environment identity/);
  }
  const unknown = structuredClone(complete);
  unknown.environment.deviceId = 'unknown';
  assert.throws(() => compareResults(unknown, structuredClone(unknown)), /deviceId/);
});

test('external collection retains peaks during a blocked JS export and rejects phase-crossing readings', () => {
  const startedAt = '2026-10-06T12:00:00.000Z';
  const source = { cases: [{ startedAt, elapsedMs: 20000, memorySamples: [
    { elapsedMs: 0, phase: 'running', memory: normalizeMemory(), operatingConditions:
      { thermalState: 'nominal', powerMode: 'normal', source: 'native-conditions' } },
    { elapsedMs: 18000, phase: 'settled', memory: normalizeMemory(), operatingConditions:
      { thermalState: 'nominal', powerMode: 'normal', source: 'native-conditions' } },
  ], collection: { maxMemorySamples: 2048, phaseEvents: [
    { elapsedMs: 0, phase: 'running' }, { elapsedMs: 18000, phase: 'settled' },
  ] } }] };
  const external = (begin, duration, bytes) => ({ wallTime: new Date(Date.parse(startedAt) + begin).toISOString(),
    collectionMs: duration, memory: { rssBytes: { value: bytes, source: 'external-native' } } });
  const merged = mergeMemorySamples(source, [external(0, 100, 100), external(10000, 100, 900),
    external(17950, 100, 9999), external(18000, 100, 100)], { clockOffsetMs: 0, maxGapMs: 200 });
  const points = merged.cases[0].memorySamples;
  const independentPeak = points.find((point) => point.elapsedMs === 10000);
  assert.equal(independentPeak.memory.rssBytes.value, 900);
  assert.equal(independentPeak.phase, 'running');
  assert.equal(independentPeak.operatingConditions.source, null);
  assert.equal(points.some((point) => point.memory.rssBytes.value === 9999), false);
  assert.equal(merged.cases[0].collection.externalMemory.insertedSamples, 3);
  assert.equal(source.cases[0].memorySamples.length, 2);
});

test('external telemetry remains bounded and missing phase timelines cannot qualify', async () => {
  const complete = await validResult();
  const entry = complete.cases[0];
  const point = entry.memorySamples[0];
  const sample = { wallTime: new Date(Date.parse(entry.startedAt) + point.elapsedMs).toISOString(),
    memory: { rssBytes: { value: 100, source: 'external-native' } } };
  entry.collection.maxMemorySamples = entry.memorySamples.length;
  const bounded = mergeMemorySamples(complete, [sample], { clockOffsetMs: 0 });
  assert.equal(bounded.cases[0].memorySamples.length, entry.memorySamples.length);
  assert.ok(bounded.cases[0].collection.memorySamplesDropped > 0);
  assert.equal(compareResults(complete, bounded).assessment, 'incomplete');
  delete entry.collection.phaseEvents;
  const noTimeline = mergeMemorySamples(complete, [sample], { clockOffsetMs: 0 });
  assert.equal(noTimeline.cases[0].collection.externalMemory.phaseTimelineVerified, false);
  assert.equal(compareResults(complete, noTimeline).assessment, 'incomplete');
});

test('failed mount diagnostics preserve the original stack and separate teardown errors', async () => {
  const adapter = fakeAdapter();
  const original = new TypeError('Cannot read property current of undefined');
  original.stack = 'TypeError: Cannot read property current of undefined\n at previewLifecycle (videoCompositionPlayer.ts:91)';
  adapter.mount = async () => { throw annotateFailureStage(original, 'mount:wait-ready-and-first-frame',
    { ready: false, attached: true, hasPlayer: false, hasCounters: true, errorCount: 1 }); };
  adapter.drain = async () => { throw new Error('GPU drain rejected'); };
  const result = await runCase(adapter, buildCases().find((entry) => entry.id === 'single-h264-638x358.mp4'), options);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, original.message);
  assert.equal(result.diagnostic.stack, original.stack);
  assert.equal(result.diagnostic.stage, 'mount:wait-ready-and-first-frame');
  assert.equal(result.diagnostic.runnerStage, 'mount');
  assert.equal(result.diagnostic.operation, 'play');
  assert.equal(result.diagnostic.preview.errorCount, 1);
  assert.equal(result.cleanupDiagnostic.stage, 'settle:drain');
  assert.equal(result.cleanupDiagnostic.message, 'GPU drain rejected');
  assert.equal(result.operations.length, 0);
  assert.equal(result.unsafeToContinue, true);
});

test('diagnostics bound strings and causes, serialize cycles and preserve frozen error classification', () => {
  const error = new Error('x'.repeat(10000));
  error.stack = 'stack'.repeat(10000);
  const cause = new Error('nested');
  cause.cause = error;
  error.cause = cause;
  const diagnostic = failureDiagnostic(error, { stage: 's'.repeat(500), operation: 'o'.repeat(500) });
  assert.equal(diagnostic.message.length, 1024);
  assert.equal(diagnostic.stack.length, 4096);
  assert.equal(diagnostic.stage.length, 128);
  assert.equal(diagnostic.operation.length, 128);
  assert.equal(diagnostic.cause.message, 'nested');
  assert.equal(diagnostic.cause.cause, undefined);
  assert.doesNotThrow(() => JSON.stringify(diagnostic));
  const aborted = new Error('cancelled');
  aborted.name = 'AbortError';
  aborted.unsafeToContinue = true;
  Object.freeze(aborted);
  const annotated = annotateFailureStage(aborted, 'mount:attach-react-child');
  assert.equal(annotated.name, 'AbortError');
  assert.equal(annotated.message, 'cancelled');
  assert.equal(annotated.unsafeToContinue, true);
  assert.equal(failureDiagnostic(annotated).cause.stack, aborted.stack);
});


test('comparator rejects different timing clocks, execution targets, or RSS sampling periods', async () => {
  const before = await validResult();
  for (const modify of [
    (result) => { result.environment.measurementClock = 'Date.now'; },
    (result) => { result.environment.executionTarget = 'simulator'; },
    (result) => { result.cases.forEach((entry) => { entry.collection.periodMs = 100; }); },
    (result) => { result.cases[0].collection.periodMs = 100; },
  ]) {
    const after = structuredClone(before);
    modify(after);
    assert.throws(() => compareResults(before, after), /Incompatible/);
  }
});

test('identically missing timing provenance cannot qualify a comparison', async () => {
  const before = await validResult();
  for (const field of ['executionTarget', 'measurementClock']) {
    const missing = structuredClone(before);
    delete missing.environment[field];
    assert.throws(() => compareResults(missing, structuredClone(missing)), /Missing measured environment identity/);
  }
  for (const value of [undefined, null, 0, -100, NaN]) {
    const missing = structuredClone(before);
    missing.cases[0].collection.periodMs = value;
    assert.throws(() => compareResults(missing, structuredClone(missing)), /Missing or invalid memory sample period/);
  }
});


test('steady playback has explicit separate IDs and never seeks before timing', async () => {
  for (const fixture of ['h264-1080p30-audio', 'h264-4k30', 'hevc-4k30']) {
    const scenario = buildCases().find((entry) => entry.id === `steady-playback-${fixture}`);
    assert.deepEqual(scenario.operations, ['perf']);
    assert.equal(scenario.seekBeforePerf, false);
    assert.equal(scenario.composition.duration, 4);
    assert.equal(scenario.composition.lazyDecoders, false);
    assert.equal(scenario.composition.items[0].textureMode, 'copy');
    const adapter = fakeAdapter();
    const result = await runCase(adapter, scenario, options);
    assert.equal(result.status, 'passed');
    assert.equal(adapter.calls.filter(([name]) => name === 'seek').length, 0);
    const legacy = buildCases().find((entry) => entry.id === `single-${fixture}.mp4`);
    assert.deepEqual(legacy.operations, ['play', 'seek', 'loop', 'hold', 'perf']);
    const originalAdapter = fakeAdapter();
    await runCase(originalAdapter, legacy, options);
    assert.ok(originalAdapter.calls.some(([name, time, config]) => name === 'seek' && time === 0 && config.settle));
  }
});

test('steady direct playback differs only by ID and requested texture mode, with no seek operation', async () => {
  const cases = buildCases();
  const directIds = new Set();
  for (const fixture of ['h264-1080p30-audio', 'h264-4k30', 'hevc-4k30']) {
    const copy = cases.find((entry) => entry.id === `steady-playback-${fixture}`);
    const direct = cases.find((entry) => entry.id === `${copy.id}-direct`);
    directIds.add(direct.id);
    assert.deepEqual(direct.operations, ['perf']);
    assert.equal(direct.seekBeforePerf, false);
    assert.equal(direct.composition.lazyDecoders, false);
    assert.equal(direct.composition.duration, 4);
    assert.equal(direct.composition.items[0].textureMode, 'direct');
    const normalized = structuredClone(direct);
    normalized.id = copy.id;
    normalized.composition.items[0].textureMode = 'copy';
    assert.deepEqual(normalized, copy);
    const adapter = fakeAdapter();
    const result = await runCase(adapter, direct, options);
    assert.equal(result.status, 'passed');
    assert.equal(adapter.calls.filter(([name]) => name === 'seek').length, 0);
    const mounted = adapter.calls.find(([name]) => name === 'mount')[1];
    assert.equal(mounted.composition.items[0].textureMode, 'direct');
  }
  // Golden content captured before adding direct readings: the original 62
  // scenarios, their ordering and all seeded seek/scrub/churn values survive.
  const previous = cases.filter((entry) => !directIds.has(entry.id));
  assert.equal(previous.length, 62);
  assert.equal(createHash('sha256').update(JSON.stringify(previous)).digest('hex'),
    '1285e0436fc374da87c3c523508a8d903deffb97d9c4a12548dc04bc61e27563');
  assert.ok(cases.some((entry) => entry.id === 'encode-h264-direct'));
});


test('uncycled exports and duplicate settle readings cannot prove post-warmup growth', async () => {
  const memory = (value) => normalizeMemory({ rssBytes: { value, source: 'fixture-native-collector' } });
  const uncycled = [
    { phase: 'settled', elapsedMs: 2008.806, memory: memory(313e6) },
    { phase: 'settled', elapsedMs: 2009.458, memory: memory(313e6) },
    { phase: 'settled', elapsedMs: 4275.326, memory: memory(349e6) },
  ];
  assert.equal(memoryTrend(uncycled, 'rssBytes').slopePerMinute, null);
  const oneCycle = uncycled.map((point) => ({ ...point, cycle: 10 }));
  const trend = memoryTrend(oneCycle, 'rssBytes');
  assert.equal(trend.samples, 1);
  assert.equal(trend.rawSamples, 3);
  assert.equal(trend.slopePerMinute, null);
  const before = await validResult();
  const after = structuredClone(before);
  for (const entry of after.cases) entry.memorySamples = uncycled;
  const comparison = compareResults(before, after);
  assert.ok(comparison.cases[0].findings.includes('rssBytes peak regression'));
  assert.ok(!comparison.cases[0].findings.some((finding) => finding.includes('grows after warmup')));
  // Even forged cycle labels cannot turn a declared single export into a soak.
  for (const entry of after.cases) entry.memorySamples = uncycled.map((point, index) => ({ ...point, cycle: 10 + index }));
  assert.ok(!compareResults(before, after).cases[0].findings.some((finding) => finding.includes('grows after warmup')));
});

test('cyclic growth uses one latest settled point per cycle and retains real growth', () => {
  const point = (cycle, elapsedMs, value) => ({ phase: 'settled', cycle, elapsedMs,
    memory: { rssBytes: { value, source: 'native' } } });
  const samples = [point(10, 60000, 90), point(10, 60001, 100),
    point(15, 120001, 200), point(19, 180001, 300)];
  const trend = memoryTrend(samples, 'rssBytes');
  assert.equal(trend.samples, 3);
  assert.equal(trend.rawSamples, 4);
  assert.deepEqual(trend.cycles, [10, 15, 19]);
  assert.equal(trend.delta, 200);
  assert.ok(Math.abs(trend.slopePerMinute - 100) < 1e-9);
  assert.equal(memoryTrend(samples.slice(0, 3), 'rssBytes').slopePerMinute, null);
  assert.equal(memoryTrend([point(10, 1, 100), point(15, 1, 200), point(19, 1, 300)], 'rssBytes').slopePerMinute, null);
  assert.equal(memoryTrend([point(10, 3, 100), point(15, 2, 200), point(19, 1, 300)], 'rssBytes').slopePerMinute, null);
});


test('mixed export final cleanup is the same completed cycle as the last export', async () => {
  const before = await runBenchmarks(fakeAdapter(), { ...options,
    caseIds: ['repeated-mixed-size-exports'], repetitions: 3 });
  before.caseCatalog[0].exportCycles = 15;
  for (const entry of before.cases) entry.operations[0].exports = entry.operations[0].exports.slice(0, 15);
  const after = structuredClone(before);
  for (const entry of after.cases) entry.memorySamples = [10, 14, 15].map((cycle, index) => ({
    phase: 'settled', cycle, elapsedMs: (index + 1) * 60000,
    memory: normalizeMemory({ rssBytes: { value: 100e6 + index * 20e6, source: 'fixture-native-collector' } }) }));
  const original = structuredClone(after);
  const row = compareResults(before, after).cases[0];
  assert.ok(row.findings.includes('rssBytes peak regression'));
  assert.ok(!row.findings.some((finding) => finding.includes('grows after warmup')));
  assert.equal(row.memory.rssBytes.candidateTrends[0].samples, 2);
  assert.deepEqual(row.memory.rssBytes.candidateTrends[0].cycles, [10, 14]);
  assert.deepEqual(after, original, 'Raw telemetry must stay untouched');
});

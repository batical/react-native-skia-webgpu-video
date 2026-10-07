import test from 'node:test';
import assert from 'node:assert/strict';
import { createBenchmarkScreen, snapshotPreviewSeekState } from '../../benchmark/screen.mjs';
import { annotateFailureStage, failureDiagnostic, runCase } from '../../benchmark/runner.mjs';
import { assessPlayingSeek, observePlayingSeekClock, shouldResumeAfterNaturalEnd, summarizeSeekValidation } from '../../benchmark/playing-seek.mjs';
import { buildCases, WORKLOAD_VERSION } from '../../benchmark/cases.mjs';

const seekDiagnostic = (preview, error = new Error('Preview operation timed out')) =>
  failureDiagnostic(annotateFailureStage(error, 'preview:seek-settle', preview),
    { stage: 'operation:seek-playing', operation: 'seek-playing' });

test('seek snapshots survive in-place shared counter mutation without retaining native frames', () => {
  const texture = new ArrayBuffer(4096);
  const entry = { itemId: 'clip-6', frameId: 17, producerId: 4, texture };
  const value = { currentTime: 4.25, drawnIds: '|clip-6|', frameIds: ['clip-6'],
    frameIdentities: [entry], renderSequence: 120, lastDrawAtMs: 1000, texture };
  const session = { player: { currentTime: 4.3, isPlaying: true }, counters: { value } };
  const before = snapshotPreviewSeekState(session);
  value.currentTime = 9.7;
  value.drawnIds = '|clip-7|';
  value.frameIds[0] = 'clip-7';
  entry.itemId = 'clip-7';
  entry.frameId = 18;
  value.renderSequence++;
  value.lastDrawAtMs = 1100;
  const after = snapshotPreviewSeekState(session);
  assert.equal(before.drawnTime, 4.25);
  assert.equal(before.renderSequence, 120);
  assert.equal(before.lastDrawAtMs, 1000);
  assert.deepEqual(before.frameMapIds, ['clip-6']);
  assert.deepEqual(before.frameIdentities, [{ itemId: 'clip-6', frameId: 17, producerId: 4 }]);
  assert.deepEqual(after.frameIdentities, [{ itemId: 'clip-7', frameId: 18, producerId: 4 }]);
  assert.equal(after.renderSequence, 121);
  assert.equal('texture' in before, false);
  assert.equal('texture' in before.frameIdentities[0], false);
  assert.equal('counters' in before, false);
  assert.equal('player' in before, false);
});

test('seek snapshots contain at most sixteen bounded identities and plain scalar data', () => {
  const longId = 'i'.repeat(300);
  const unsafeNativeObject = { toString() { throw new Error('Do not stringify native objects'); } };
  const snapshot = snapshotPreviewSeekState({ player: { currentTime: Infinity, isPlaying: 1 },
    counters: { value: { currentTime: NaN, drawnIds: Array(30).fill(longId).join('|'),
      frameIds: [unsafeNativeObject, ...Array(30).fill(longId)],
      frameIdentities: Array.from({ length: 30 }, (_, index) => ({ itemId: longId,
        frameId: index === 0 ? Number.MAX_SAFE_INTEGER + 1 : index, producerId: 3 })),
      renderSequence: 4, lastDrawAtMs: -Infinity } } });
  assert.equal(snapshot.playerTime, null);
  assert.equal(snapshot.drawnTime, null);
  assert.equal(snapshot.isPlaying, null);
  assert.equal(snapshot.lastDrawAtMs, null);
  assert.equal(snapshot.drawnFrameIds.length, 16);
  assert.equal(snapshot.frameMapIds.length, 15);
  assert.equal(snapshot.frameIdentities.length, 16);
  assert.equal(snapshot.frameIdentities[0].frameId, null);
  assert.ok(snapshot.drawnFrameIds.every((id) => id.length === 96));
  assert.ok(snapshot.frameIdentities.every((entry) => entry.itemId.length === 96));
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test('unavailable player getters cannot replace a seek timeout with another failure', () => {
  const throwing = {};
  for (const key of ['currentTime', 'isPlaying', 'value']) Object.defineProperty(throwing, key,
    { get() { throw new Error('Disposed native object'); } });
  const snapshot = snapshotPreviewSeekState({ player: throwing, counters: throwing });
  assert.deepEqual(snapshot, { playerTime: null, drawnTime: null, isPlaying: null,
    drawnFrameIds: [], frameMapIds: [], frameIdentities: [], renderSequence: null, lastDrawAtMs: null });
  const diagnostic = seekDiagnostic({ ...snapshot, requestedTime: 9.613, elapsedMs: 4016 });
  assert.equal(diagnostic.message, 'Preview operation timed out');
  assert.equal(diagnostic.preview.playerTime, null);
  assert.equal(diagnostic.preview.renderedSinceSeek, null);
});

test('seek timeout JSON distinguishes advancing playback from the fixed requested clock', () => {
  const diagnostic = seekDiagnostic({ requestedTime: 9.613, elapsedMs: 4016,
    playerTime: 13.629, drawnTime: 13.58, isPlaying: true, preservePlaying: true,
    expectedFrameIds: ['clip-6', 'clip-7'], drawnFrameIds: ['clip-8'], frameMapIds: ['clip-8'],
    beforeFrameIdentities: [{ itemId: 'clip-0', frameId: 8, producerId: 11 }],
    frameIdentities: [{ itemId: 'clip-8', frameId: 47, producerId: 12 }],
    beforeRenderSequence: 2, renderSequence: 72, lastDrawAtMs: 24501,
    nativeFramePTSReason: 'VideoFrame API does not expose presentation timestamps' });
  const json = JSON.parse(JSON.stringify(diagnostic));
  assert.equal(json.stage, 'preview:seek-settle');
  assert.equal(json.runnerStage, 'operation:seek-playing');
  assert.equal(json.operation, 'seek-playing');
  assert.equal(json.preview.requestedTime, 9.613);
  assert.equal(json.preview.playerTime, 13.629);
  assert.equal(json.preview.drawnTime, 13.58);
  assert.equal(json.preview.elapsedMs, 4016);
  assert.equal(json.preview.isPlaying, true);
  assert.equal(json.preview.renderedSinceSeek, true);
  assert.deepEqual(json.preview.expectedFrameIds, ['clip-6', 'clip-7']);
  assert.deepEqual(json.preview.frameIdentities, [{ itemId: 'clip-8', frameId: 47, producerId: 12 }]);
  assert.equal(json.preview.nativeFramePTS, null);
  assert.equal(json.preview.nativeFramePTSReason, 'VideoFrame API does not expose presentation timestamps');
});

test('seek diagnostics bound external observations and never serialize buffers or native objects', () => {
  const preview = { requestedTime: NaN, elapsedMs: Infinity, playerTime: '9.6', drawnTime: 9.6,
    isPlaying: false, preservePlaying: false, beforeRenderSequence: 5, renderSequence: 5,
    expectedFrameIds: Array(100).fill('e'.repeat(1000)), drawnFrameIds: Array(100).fill('d'.repeat(1000)),
    frameMapIds: Array(100).fill('f'.repeat(1000)),
    frameIdentities: Array(100).fill({ itemId: 'i'.repeat(1000), frameId: 7, producerId: NaN,
      texture: new ArrayBuffer(1000) }), beforeFrameIdentities: [],
    nativeFramePTS: new ArrayBuffer(1000), nativeFramePTSReason: 'p'.repeat(1000) };
  Object.defineProperty(preview, 'ready', { get() { throw new Error('Not a mount diagnostic'); } });
  const diagnostic = seekDiagnostic(preview).preview;
  assert.equal(diagnostic.requestedTime, null);
  assert.equal(diagnostic.elapsedMs, null);
  assert.equal(diagnostic.playerTime, null);
  assert.equal(diagnostic.isPlaying, false);
  assert.equal(diagnostic.renderedSinceSeek, false);
  for (const key of ['expectedFrameIds', 'drawnFrameIds', 'frameMapIds', 'frameIdentities'])
    assert.equal(diagnostic[key].length, 16);
  assert.equal(diagnostic.frameIdentities[0].itemId.length, 96);
  assert.equal(diagnostic.frameIdentities[0].producerId, null);
  assert.equal('texture' in diagnostic.frameIdentities[0], false);
  assert.equal(diagnostic.nativeFramePTS, null);
  assert.equal(diagnostic.nativeFramePTSReason.length, 160);
  assert.doesNotThrow(() => JSON.stringify(diagnostic));
});

test('annotated frozen seek errors retain their original stack and cancellation classification', () => {
  const original = new Error('Cancelled while seeking');
  original.name = 'AbortError';
  original.unsafeToContinue = true;
  original.stack = 'AbortError: Cancelled while seeking\n at actualSeek';
  Object.freeze(original);
  const diagnostic = seekDiagnostic({ requestedTime: 7.213, elapsedMs: 500,
    playerTime: 7.3, drawnTime: 6.9, isPlaying: false, beforeRenderSequence: 9, renderSequence: 8 }, original);
  assert.equal(diagnostic.name, 'AbortError');
  assert.equal(diagnostic.stage, 'preview:seek-settle');
  assert.equal(diagnostic.cause.stack, original.stack);
  assert.equal(diagnostic.preview.renderedSinceSeek, false);
  assert.equal(diagnostic.preview.isPlaying, false);
});

const composition = { duration: 3, items: [
  { id: 'a', compositionStartTime: 0, duration: 1 },
  { id: 'b', compositionStartTime: 1, duration: 1 },
  { id: 'c', compositionStartTime: 2, duration: 1 },
] };
const before = { renderSequence: 10,
  frameIdentities: [{ itemId: 'a', frameId: 11, producerId: 1 }] };
const runningSeek = (changes = {}) => assessPlayingSeek({ composition, requestedTime: 0.4,
  elapsedMs: 400, before, observation: { playerTime: 0.8, drawnTime: 0.79, isPlaying: true,
    renderSequence: 11, drawnFrameIds: ['a'],
    frameIdentities: [{ itemId: 'a', frameId: 12, producerId: 1 }], ...changes } });

test('moving seek accepts the recorded simulator clocks without enlarging the existing skew', () => {
  const scenario = buildCases().find((entry) => entry.id === 'scrub-while-playing');
  const result = assessPlayingSeek({ composition: scenario.composition,
    requestedTime: 7.213, elapsedMs: 4010.8236670047045,
    before: { renderSequence: 153, frameIdentities: [] },
    observation: { playerTime: 11.222056984, drawnTime: 11.219732999, isPlaying: true,
      renderSequence: 392, drawnFrameIds: ['clip-7'],
      frameIdentities: [{ itemId: 'clip-7', frameId: 178, producerId: 49 }] } });
  assert.equal(result.settled, true);
  assert.equal(result.nativeIdentityValidation, 'uncompared');
  assert.equal(runningSeek().settled, true);
  assert.equal(runningSeek().nativeIdentityValidation, 'verified');
  assert.equal(runningSeek({ playerTime: 1.001 }).settled, false);
  assert.equal(runningSeek({ drawnTime: 0.599 }).settled, false);
  assert.equal(WORKLOAD_VERSION, '2026-10-07.1');
});

test('moving seek rejects wrong clocks, wrong item IDs and premature pause', () => {
  assert.equal(runningSeek({ playerTime: 1.5, drawnTime: 1.5 }).settled, false);
  assert.equal(runningSeek({ drawnTime: 0.4 }).settled, false);
  assert.equal(runningSeek({ drawnFrameIds: ['b'] }).settled, false);
  assert.equal(runningSeek({ drawnFrameIds: ['a', 'b'] }).settled, false);
  assert.equal(runningSeek({ drawnFrameIds: ['a', 'a'] }).settled, false);
  assert.equal(runningSeek({ drawnFrameIds: [] }).settled, false);
  assert.equal(runningSeek({ isPlaying: false }).settled, false);
  assert.equal(runningSeek({ playerTime: NaN }).settled, false);
});

test('moving seek rejects a redraw of a native frame held before seeking', () => {
  assert.equal(runningSeek({ renderSequence: 10 }).settled, false);
  assert.equal(runningSeek({ renderSequence: 9 }).settled, false);
  assert.equal(runningSeek({ frameIdentities: [{ itemId: 'a', frameId: 11, producerId: 1 }] }).settled, false);
  assert.equal(runningSeek({ frameIdentities: [{ itemId: 'a', frameId: null, producerId: null }] }).settled, false);
  assert.equal(runningSeek({ frameIdentities: [] }).settled, false);
  assert.equal(runningSeek({ frameIdentities: [{ itemId: 'a', frameId: 11, producerId: 2 }] }).settled, true);
});

test('visibility changes at an item boundary follow the drawn clock rather than the original target', () => {
  const input = { composition, requestedTime: 0.9, elapsedMs: 150, before,
    observation: { playerTime: 1.05, drawnTime: 1.04, isPlaying: true,
      renderSequence: 11, drawnFrameIds: ['b'],
      frameIdentities: [{ itemId: 'b', frameId: 21, producerId: 2 }] } };
  assert.equal(assessPlayingSeek(input).settled, true);
  assert.equal(assessPlayingSeek(input).nativeIdentityValidation, 'uncompared');
  assert.equal(assessPlayingSeek({ ...input, observation: { ...input.observation,
    drawnFrameIds: ['a'], frameIdentities: [{ itemId: 'a', frameId: 12, producerId: 1 }] } }).settled, false);
});

test('natural end requires an observed running requested clock and a fresh coherent terminal render', () => {
  const input = { composition, requestedTime: 2.9, elapsedMs: 200, before, sawMovingClock: true,
    observation: { playerTime: 3, drawnTime: 3, isPlaying: false,
      renderSequence: 11, drawnFrameIds: [], frameIdentities: [] } };
  assert.equal(assessPlayingSeek(input).settled, true);
  assert.equal(assessPlayingSeek(input).settlementKind, 'terminal-completion-only');
  assert.equal(assessPlayingSeek(input).frameValidation, 'unavailable');
  assert.equal(assessPlayingSeek(input).nativeIdentityValidation, 'unavailable');
  assert.equal(assessPlayingSeek({ ...input, sawMovingClock: false }).settled, false);
  for (const changes of [{ playerTime: 2.99 }, { drawnTime: 2.99 }, { isPlaying: true },
    { renderSequence: 10 }, { drawnFrameIds: ['c'] }])
    assert.equal(assessPlayingSeek({ ...input, observation: { ...input.observation, ...changes } }).settled, false);
  const initial = observePlayingSeekClock({ duration: 3, requestedTime: 2.9,
    elapsedMs: 0, playerTime: 2.9, isPlaying: true });
  assert.equal('drawnTime' in initial, false);
  assert.equal('settled' in initial, false);
  assert.equal(initial.sawMovingClock, true);
  assert.equal(assessPlayingSeek({ ...input, sawMovingClock: initial.sawMovingClock }).settled, true);
});

test('legacy missing state getters require observed clock advancement and report unavailable frame identity', () => {
  const input = { composition, requestedTime: 0.4, elapsedMs: 400,
    before: { renderSequence: 10, frameIdentities: [{ itemId: 'a', frameId: null, producerId: null }] },
    observation: { playerTime: 0.8, drawnTime: 0.79, isPlaying: null, renderSequence: 11,
      drawnFrameIds: ['a'], frameIdentities: [{ itemId: 'a', frameId: null, producerId: null }] } };
  const result = assessPlayingSeek(input);
  assert.equal(result.settled, true);
  assert.equal(result.nativeIdentityValidation, 'unavailable');
  assert.equal(assessPlayingSeek({ ...input, elapsedMs: 50,
    observation: { ...input.observation, playerTime: 0.45, drawnTime: 0.45 } }).settled, false);
  assert.equal(assessPlayingSeek({ ...input,
    observation: { ...input.observation, playerTime: 0.4, drawnTime: 0.4 } }).settled, false);
});

test('the next seek resumes after natural completion without replaying an already running legacy clock', () => {
  const next = { before: { playerTime: 3, isPlaying: false }, requestedTime: 0.4, duration: 3 };
  assert.equal(shouldResumeAfterNaturalEnd(next), true);
  assert.equal(shouldResumeAfterNaturalEnd({ ...next, before: { playerTime: 3, isPlaying: true } }), false);
  assert.equal(shouldResumeAfterNaturalEnd({ ...next, before: { playerTime: 3, isPlaying: null } }), false);
  assert.equal(shouldResumeAfterNaturalEnd({ ...next, before: { playerTime: 2.9, isPlaying: false } }), false);
  assert.equal(shouldResumeAfterNaturalEnd({ ...next, requestedTime: 3 }), false);
  assert.equal(shouldResumeAfterNaturalEnd({ ...next, requestedTime: -1 }), false);
});

test('a prefetched but previously invisible cached frame must change before it can settle after seeking', () => {
  const input = { composition, requestedTime: 1.1, elapsedMs: 100,
    before: { renderSequence: 10, frameIdentities: [
      { itemId: 'a', frameId: 11, producerId: 1 }, { itemId: 'b', frameId: 21, producerId: 2 }] },
    observation: { playerTime: 1.2, drawnTime: 1.19, isPlaying: true, renderSequence: 11,
      drawnFrameIds: ['b'], frameIdentities: [{ itemId: 'b', frameId: 21, producerId: 2 }] } };
  assert.equal(assessPlayingSeek(input).settled, false);
  const fresh = assessPlayingSeek({ ...input, observation: { ...input.observation,
    frameIdentities: [{ itemId: 'b', frameId: 22, producerId: 2 }] } });
  assert.equal(fresh.settled, true);
  assert.equal(fresh.nativeIdentityValidation, 'verified');
});

test('the actual draw callback records scalar identities from invisible prefetched frames too', () => {
  const session = { scenario: { composition }, composition,
    dimensions: { logicalWidth: 10, logicalHeight: 10 } };
  let stateCalls = 0, shared, playerConfig;
  const React = { useState: (initial) => [stateCalls++ === 0 ? session : initial, () => {}],
    useRef: () => ({ current: null }), useCallback: (fn) => fn, useEffect: (fn) => { fn(); },
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const Screen = createBenchmarkScreen({ React,
    native: { View: 'View', Text: 'Text', Button: 'Button', PixelRatio: { get: () => 1 } },
    skia: { Canvas: 'Canvas', Image: 'Image' }, files: {}, memory: {},
    reanimated: { runOnUI: (fn) => fn, runOnJS: (fn) => fn, useSharedValue: (value) => {
      shared = { value, modify: (fn) => { shared.value = fn(shared.value); } }; return shared;
    } },
    video: { drawVideoFrame: () => {}, useVideoComposition: (config) => {
      playerConfig = config; return { player: {}, currentFrame: null };
    } } });
  const screen = Screen({ options: { autorun: false } });
  const child = screen.props.children[0];
  child.type(child.props);
  const buffer = new ArrayBuffer(1024);
  playerConfig.drawFrame({ canvas: {}, videoComposition: composition, currentTime: 0.4,
    width: 10, height: 10, frames: { a: { id: 11, producerId: 1, texture: buffer },
      b: { id: 21, producerId: 2, texture: buffer } } });
  assert.equal(shared.value.drawnIds, '|a|');
  assert.deepEqual(shared.value.frameIdentities, [
    { itemId: 'a', frameId: 11, producerId: 1 }, { itemId: 'b', frameId: 21, producerId: 2 }]);
  assert.equal('texture' in shared.value.frameIdentities[1], false);
  const before = snapshotPreviewSeekState({ counters: shared });
  playerConfig.drawFrame({ canvas: {}, videoComposition: composition, currentTime: 1.2,
    width: 10, height: 10, frames: { b: { id: 21, producerId: 2, texture: buffer } } });
  const observation = { ...snapshotPreviewSeekState({ counters: shared }), playerTime: 1.2, isPlaying: true };
  assert.equal(assessPlayingSeek({ composition, requestedTime: 1.1, elapsedMs: 100, before, observation }).settled, false);
});

test('terminal-only summary explicitly contains no frame validation and stays bounded', () => {
  const assessment = assessPlayingSeek({ composition, requestedTime: 2.9, elapsedMs: 200,
    before, sawMovingClock: true, observation: { playerTime: 3, drawnTime: 3, isPlaying: false,
      renderSequence: 11, drawnFrameIds: [], frameIdentities: [] } });
  const summary = summarizeSeekValidation({ seekValidation: { ...assessment, elapsedMs: 200,
    observation: { playerTime: 3, drawnTime: 3, isPlaying: false, renderSequence: 11,
      frameMapIds: Array(50).fill('x'.repeat(1000)), drawnFrameIds: [],
      frameIdentities: Array(50).fill({ itemId: 'x'.repeat(1000), frameId: 12, producerId: 3,
        texture: new ArrayBuffer(1024) }) } } }, 2.9);
  assert.equal(summary.settlementKind, 'terminal-completion-only');
  assert.equal(summary.frameValidation, 'unavailable');
  assert.equal(summary.nativeIdentityValidation, 'unavailable');
  assert.equal(summary.frameMapIds.length, 16);
  assert.equal(summary.frameIdentities.length, 16);
  assert.equal(summary.frameIdentities[0].itemId.length, 96);
  assert.equal('texture' in summary.frameIdentities[0], false);
  assert.equal(summary.nativeFramePTS, null);
  assert.doesNotThrow(() => JSON.stringify(summary));
});

test('runner records bounded seek summaries after stopping each latency clock', async () => {
  let time = 0;
  let summaryReads = 0;
  const scenario = { ...buildCases().find((entry) => entry.id === 'seek-while-playing'),
    seeks: Array.from({ length: 20 }, (_, index) => index / 10) };
  const adapter = { now: () => time,
    sleep: async (ms) => { time += ms; }, mount: async () => ({}), unmount: async () => {},
    play: async () => {}, pause: async () => {}, sampleMemory: async () => ({}),
    seek: async () => { time += 10; return { correct: true, seekValidation: {
      settlementKind: 'frame-and-clock', frameValidation: 'frame-presence-and-composition-clock',
      nativeIdentityValidation: 'uncompared', elapsedMs: 10, observation: {
        get frameIdentities() { summaryReads++; time += 1000; return []; },
        playerTime: 0.5, drawnTime: 0.5, isPlaying: true, renderSequence: 2 } } }; } };
  const result = await runCase(adapter, scenario, { fixtureDirectory: '/fixtures',
    settleMs: 0, enableIntervalSampling: false, backend: { paths: {} } });
  assert.equal(result.status, 'passed');
  const operation = result.operations[0];
  assert.equal(operation.latencies.samples, 20);
  assert.equal(operation.latencies.medianMs, 10);
  assert.equal(operation.seekObservations.length, 10);
  assert.equal(operation.seekObservationsDropped, 10);
  assert.equal(operation.seekObservations[0].nativeIdentityValidation, 'uncompared');
  assert.ok(summaryReads > 0);
  assert.ok(operation.elapsedMs > 1000, 'Summary copying cost must not enter seek latency samples');
});

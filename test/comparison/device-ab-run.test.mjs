import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNED_APPS, ownedProcesses, resultFiles, parseOptions, validateDeviceResult, validateIdleResult, launchWhenUnlocked } from '../../scripts/test-ios-device-ab-run.mjs';
import { buildCases, WORKLOAD_VERSION } from '../../benchmark/cases.mjs';
import { FIXTURES } from '../../benchmark/fixtures.mjs';

const device = '00000000-0000000000000000';
const runId = 'test-unique-run';
const options = { device, backend: 'candidate', profile: 'full', repetitions: 3, cases: ['encode-h264-copy'] };
function result() {
  return { schema: 1, workloadVersion: WORKLOAD_VERSION, profile: 'full', repetitions: 3, seed: 123,
    startedAt: '2026-10-07T08:00:00Z', finishedAt: '2026-10-07T08:00:15Z',
    environment: { deviceId: device, deviceModel: 'iPhone16,1', osVersion: '27.0.1', executionTarget: 'device', platform: 'ios',
      buildMode: 'release', measurementClock: 'performance.now', reactNativeVersion: '0.86.2',
      benchmarkRunId: runId, processIdentifier: 123, displayRefreshRate: 120, pixelRatio: 3 },
    backend: { name: OWNED_APPS.candidate.package },
    fixtureManifest: { schema: 1, files: FIXTURES.map((fixture) => ({ ...fixture, bytes: 1024, sha256: 'a'.repeat(64) })) },
    caseCatalog: buildCases({ profile: 'full', seed: 123 }).filter((scenario) => scenario.id === 'encode-h264-copy'),
    cases: [0, 1, 2].map((repetition) => ({ id: 'encode-h264-copy', repetition, status: 'passed', collection: { periodMs: 100 } })) };
}
const context = { options, runId, pid: 123, deviceModel: 'iPhone16,1', osVersion: '27.0.1' };
function idle() {
  return { schema: 1, benchmarkFilename: 'candidate-123456.json', benchmarkRunId: runId, processIdentifier: 123, requestedSeconds: 180,
    intervalSeconds: 30, startedAt: '2026-10-07T08:00:15Z', finishedAt: '2026-10-07T08:03:15Z',
    samples: [0, 30, 60, 90, 120, 150, 180].map((elapsedSeconds) => ({ elapsedSeconds,
      memory: { rssBytes: { value: 100000000, source: 'iOS mach task_info resident_size' },
        physicalFootprintBytes: { value: 90000000, source: 'iOS task_vm_info phys_footprint' } },
      operatingConditions: { source: 'NSProcessInfo', thermalState: 'nominal', powerMode: 'normal' } })) };
}
const idleContext = { filename: 'candidate-123456.json', pid: 123, seconds: 180, runId };

test('launch retries a lock rejection and returns the first successful fresh process', async () => {
  let calls = 0; let time = 0; let waits = 0;
  const locked = Object.assign(new Error('Launch rejected'), { stderr: 'BSErrorCodeDescription = Locked' });
  const launched = await launchWhenUnlocked(async () => {
    if (++calls < 3) throw locked;
    return { pid: 42 };
  }, { waitMs: 5000, now: () => time, pause: async ms => { time += ms; }, onLocked: async () => { waits++; } });
  assert.deepEqual(launched, { pid: 42 }); assert.equal(calls, 3); assert.equal(waits, 2);
});

test('launch does not retry network, crash, signing, or ambiguous errors', async () => {
  for (const message of ['Connection lost', 'Application crashed', 'Invalid signature', 'RequestDenied']) {
    let calls = 0; const error = new Error(message);
    await assert.rejects(launchWhenUnlocked(async () => { calls++; throw error; }), e => e === error);
    assert.equal(calls, 1);
  }
});

test('launch lock wait is bounded and zero disables retries', async () => {
  for (const waitMs of [0, 3000]) {
    let time = 0; let calls = 0;
    const error = new Error('BSErrorCodeDescription = Locked');
    await assert.rejects(launchWhenUnlocked(async () => { calls++; throw error; },
      { waitMs, now: () => time, pause: async ms => { time += ms; } }), e => e === error);
    assert.equal(time, waitMs); assert.equal(calls, waitMs ? 2 : 1);
  }
});

test('physical runner terminates only exact installed benchmark executable paths', () => {
  const url = 'file:///private/var/containers/Bundle/Application/TEST/ReactNativeSkiaWebGPUVideoExample.app/';
  const app = { bundleIdentifier: OWNED_APPS.candidate.bundle, url };
  const process = { processIdentifier: 123, executable: url + OWNED_APPS.candidate.executable };
  assert.deepEqual(ownedProcesses([app], [process]), [process]);
  assert.equal(ownedProcesses([app], [{ ...process, executable: process.executable.replace('/private/var/', '/var/') }]).length, 1);
  for (const other of [
    { ...process, processIdentifier: 0 },
    { ...process, executable: process.executable + 'Other' },
    { ...process, executable: process.executable.replace('/TEST/', '/ANOTHER-APP/') },
    { ...process, executable: 'file:///System/Library/CoreServices/SpringBoard.app/SpringBoard' },
  ]) assert.equal(ownedProcesses([app], [other]).length, 0);
  assert.equal(ownedProcesses([{ ...app, bundleIdentifier: 'unrelated.application' }], [process]).length, 0);
});

test('main-file selection excludes idle artifacts, path traversal, unreadable files, and unrelated backends', () => {
  const file = (relativePath) => ({ relativePath, resources: { isDirectory: false, isSymbolicLink: false, isReadable: true } });
  const good = file('benchmark-results/candidate-1234.json');
  assert.deepEqual(resultFiles([good, file('benchmark-results/candidate-1234-idle.json'),
    file('benchmark-results/baseline-1234.json'), file('benchmark-results/../candidate-1234.json'),
    { ...file('benchmark-results/candidate-2345.json'), resources: { isDirectory: false, isReadable: false } }], 'candidate'), [good]);
});

test('physical attribution requires the native run token, phone PID, platform, and exact workload', () => {
  assert.doesNotThrow(() => validateDeviceResult(result(), context));
  for (const mutate of [
    (data) => { data.environment.benchmarkRunId = 'older-run'; },
    (data) => { data.environment.processIdentifier++; },
    (data) => { data.environment.executionTarget = 'simulator'; },
    (data) => { data.environment.buildMode = 'debug'; },
    (data) => { data.environment.deviceModel = 'iPhone19,2'; },
    (data) => { data.environment.deviceId = 'another-device'; },
    (data) => { data.workloadVersion = 'old-workload'; },
    (data) => { data.caseCatalog[0].output.width++; },
    (data) => { data.cases[0].collection.periodMs = 1000; },
    (data) => { data.finishedAt = data.startedAt; },
  ]) { const data = result(); mutate(data); assert.throws(() => validateDeviceResult(data, context)); }
});

test('phone wall-clock offset is not mistaken for a different run when the native token matches', () => {
  const data = result(); data.startedAt = '2026-10-07T07:00:00Z'; data.finishedAt = '2026-10-07T07:00:15Z';
  assert.doesNotThrow(() => validateDeviceResult(data, context));
});

test('idle validation accepts only native phone RSS across the complete same-process timeline', () => {
  assert.doesNotThrow(() => validateIdleResult(idle(), idleContext));
  for (const mutate of [
    (data) => { data.processIdentifier++; },
    (data) => { data.benchmarkFilename = 'candidate-older.json'; },
    (data) => { data.benchmarkRunId = 'older-run'; },
    (data) => { delete data.benchmarkRunId; },
    (data) => { data.samples.pop(); },
    (data) => { data.samples[3].elapsedSeconds = 2; },
    (data) => { data.samples[0].elapsedSeconds = 15; },
    (data) => { data.samples[2].memory.rssBytes.source = 'macOS ps RSS'; },
    (data) => { data.samples[2].memory.rssBytes.value = null; },
    (data) => { data.samples[2].operatingConditions.source = null; },
  ]) { const data = idle(); mutate(data); assert.throws(() => validateIdleResult(data, idleContext)); }
});

test('runner arguments require physical Release products and conservative polling intervals', () => {
  const args = ['--device', device, '--backend', 'candidate', '--label', 'physical-a1', '--app',
    '/private/tmp/Build/Products/Release-iphoneos/ReactNativeSkiaWebGPUVideoExample.app', '--case', 'encode-h264-copy'];
  assert.equal(parseOptions(args).pollSeconds, 30);
  for (const extra of [['--poll-seconds', '1'], ['--idle-seconds', '17'], ['--case', 'unknown'], ['--case', 'encode-h264-copy']])
    assert.throws(() => parseOptions([...args, ...extra]));
  const bad = [...args]; bad[7] = '/private/tmp/Release-iphonesimulator/ReactNativeSkiaWebGPUVideoExample.app';
  assert.throws(() => parseOptions(bad));
});


test('native footprint gaps are explicit partial or unavailable coverage while raw RSS stays intact', () => {
  const complete = validateIdleResult(idle(), idleContext);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.physicalFootprintBytes.status, 'measured');
  const partial = idle();
  partial.samples[1].memory.physicalFootprintBytes = { value: null, reason: 'task_vm_info physical footprint unavailable' };
  const original = structuredClone(partial);
  const qualification = validateIdleResult(partial, idleContext);
  assert.equal(qualification.status, 'incomplete');
  assert.equal(qualification.rssBytes.samples, 7);
  assert.equal(qualification.physicalFootprintBytes.status, 'partial');
  assert.equal(qualification.physicalFootprintBytes.samples, 6);
  assert.equal(qualification.physicalFootprintBytes.unavailable[0].reason, 'task_vm_info physical footprint unavailable');
  assert.deepEqual(partial, original);
  for (const sample of partial.samples) delete sample.memory.physicalFootprintBytes;
  const unavailable = validateIdleResult(partial, idleContext);
  assert.equal(unavailable.physicalFootprintBytes.status, 'unavailable');
  assert.equal(unavailable.physicalFootprintBytes.source, null);
  assert.equal(unavailable.physicalFootprintBytes.samples, 0);
  const wrongSource = idle();
  wrongSource.samples[0].memory.physicalFootprintBytes.source = 'macOS host process';
  assert.equal(validateIdleResult(wrongSource, idleContext).physicalFootprintBytes.status, 'partial');
  assert.throws(() => validateIdleResult(idle(), { ...idleContext, runId: undefined }));
});

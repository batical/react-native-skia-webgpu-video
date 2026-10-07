import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForBenchmarkForeground } from '../../benchmark/foreground-ready.mjs';

const active = { applicationState: 'active', source: 'UIApplication lifecycle' };
function clock(read) {
  let elapsed = 0;
  return { now: () => elapsed, sleep: async (ms) => { elapsed += ms; },
    readOperatingConditions: async () => read(elapsed), advance: (ms) => { elapsed += ms; } };
}

test('foreground gate waits through launch inactivity and one full active second', async () => {
  const injected = clock((elapsed) => elapsed < 1400 ? { ...active, applicationState: 'inactive' } : active);
  const report = await waitForBenchmarkForeground(injected);
  assert.equal(report.initialState, 'inactive');
  assert.equal(report.waitedMs, 2400);
  assert.equal(report.stableMs, 1000);
  assert.equal(report.observations, 25);
});

test('foreground gate resets after backgrounding instead of adding separate active periods', async () => {
  const injected = clock((elapsed) => elapsed === 700 ? { ...active, applicationState: 'background' } : active);
  const report = await waitForBenchmarkForeground(injected);
  assert.equal(report.waitedMs, 1800);
  assert.equal(report.stableMs, 1000);
});

test('a stalled collector cannot count as a continuously sampled active interval', async () => {
  let reads = 0;
  const injected = clock(() => { if (++reads === 2) injected.advance(2000); return active; });
  const report = await waitForBenchmarkForeground(injected);
  assert.equal(report.waitedMs, 3100);
  assert.equal(report.stableMs, 1000);
  assert.ok(report.observations >= 12);
});

test('missing foreground evidence times out and native errors retain their cause', async () => {
  const inactive = clock(() => ({ applicationState: 'unknown' }));
  await assert.rejects(waitForBenchmarkForeground({ ...inactive, timeoutMs: 2000 }), /foreground readiness timed out/);
  const failure = new Error('Native conditions collector failed');
  await assert.rejects(waitForBenchmarkForeground({ now: () => 0, sleep: async () => {},
    readOperatingConditions: async () => { throw failure; } }), (error) => error === failure);
});

test('a native promise which never resolves is bounded by the wall-clock deadline', async () => {
  await assert.rejects(waitForBenchmarkForeground({ readOperatingConditions: () => new Promise(() => {}),
    now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: 25, stableMs: 10, pollMs: 5 }), /foreground readiness timed out/);
});

test('readiness does not replace or suppress subsequent background observations', async () => {
  const injected = clock((elapsed) => elapsed <= 1000 ? active : { ...active, applicationState: 'inactive' });
  await waitForBenchmarkForeground(injected);
  injected.advance(100);
  assert.equal((await injected.readOperatingConditions()).applicationState, 'inactive');
});

test('Android and iOS screens reject an unavailable foreground collector before opening video resources', async () => {
  const { createBenchmarkScreen } = await import('../../benchmark/screen.mjs');
  for (const platform of ['android', 'ios']) {
    let collectorCalls = 0, opened = 0, status;
    const failure = new Error('Native foreground evidence unavailable');
    const React = { useState: (value) => [value, (next) => { if (typeof next === 'string') status = next; }],
      useRef: (value) => ({ current: value }), useCallback: (fn) => fn, useEffect: (fn) => fn(),
      createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
    const Screen = createBenchmarkScreen({ React,
      native: { View: 'View', Text: 'Text', Button: 'Button', PixelRatio: { get: () => 1 } },
      skia: { Canvas: 'Canvas', Image: 'Image' },
      reanimated: { runOnUI: (fn) => fn, runOnJS: (fn) => fn, useSharedValue: () => {} },
      video: { useVideoComposition: () => { opened++; }, drawVideoFrame: () => {} },
      files: {}, memory: { operatingConditions: async () => { collectorCalls++; throw failure; } } });
    const originalError = console.error;
    const diagnostics = [];
    console.error = (...args) => diagnostics.push(args);
    try {
      Screen({ options: { autorun: true, environment: { platform } } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(collectorCalls, 1, platform);
      assert.equal(opened, 0, platform);
      assert.match(status, /Native foreground evidence unavailable/);
      assert.equal(JSON.parse(diagnostics[0][1]).stage, 'screen:foreground-readiness');
    } finally { console.error = originalError; }
  }
});

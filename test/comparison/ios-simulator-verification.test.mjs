import test from 'node:test';
import assert from 'node:assert/strict';
import { iosSourceCases, passedSimulatorCases, requireSourcesPredateRun,
  requireUnchangedFiles } from '../../scripts/benchmark-record-ios-simulator-verification.mjs';

const names = ['Decoder.testForwardSeek', 'Preview.testCompletedClock'];
function evidence() {
  const device = { deviceId: 'local-only', platform: 'iOS Simulator' };
  return { summary: { result: 'Passed', totalTestCount: 2, passedTests: 2,
    failedTests: 0, skippedTests: 0, expectedFailures: 0, testFailures: [],
    devicesAndConfigurations: [{ device, passedTests: 2, failedTests: 0,
      skippedTests: 0, expectedFailures: 0 }] },
  tree: { devices: [device], testNodes: [{ nodeType: 'Test Suite', children: names.map((name) => ({
    nodeType: 'Test Case', name: name.split('.')[1], nodeIdentifier: name.replace('.', '/'), result: 'Passed',
  })) }] } };
}

test('simulator evidence requires every exact source name, rather than only a passing counter', () => {
  const { summary, tree } = evidence();
  assert.deepEqual(passedSimulatorCases(summary, tree, names).map((entry) => entry.name), names);
  tree.testNodes[0].children[1].nodeIdentifier = 'Preview/testUnrelated';
  assert.throws(() => passedSimulatorCases(summary, tree, names), /Unexpected/);
  tree.testNodes[0].children[1].nodeIdentifier = 'Decoder/testForwardSeek';
  assert.throws(() => passedSimulatorCases(summary, tree, names), /repeated/);
  tree.testNodes[0].children.pop();
  assert.throws(() => passedSimulatorCases(summary, tree, names), /every expected/);
});

test('failed, skipped, expected-failure and retried-failure cases cannot be recorded as passed', () => {
  for (const status of ['Failed', 'Skipped', 'Expected Failure', 'unknown']) {
    const { summary, tree } = evidence();
    tree.testNodes[0].children[0].result = status;
    assert.throws(() => passedSimulatorCases(summary, tree, names), /Unverified/);
  }
  const { summary, tree } = evidence();
  tree.testNodes[0].children[0].children = [{ nodeType: 'Test Case Run', result: 'Failed' }];
  assert.throws(() => passedSimulatorCases(summary, tree, names), /Unsuccessful/);
  summary.skippedTests = 1;
  assert.throws(() => passedSimulatorCases(summary, tree, names), /no failure, skip/);
});

test('a physical device or mismatched simulator identity cannot qualify as simulator execution', () => {
  const { summary, tree } = evidence();
  tree.devices = [{ ...tree.devices[0], platform: 'iOS' }];
  assert.throws(() => passedSimulatorCases(summary, tree, names), /Simulator run/);
  tree.devices = [{ ...summary.devicesAndConfigurations[0].device, deviceId: 'different' }];
  assert.throws(() => passedSimulatorCases(summary, tree, names), /Simulator run/);
});

test('source edits and fixture changes invalidate a recorded run, including edits made before test completion', () => {
  assert.deepEqual(iosSourceCases('@implementation Decoder\n- (void)testForwardSeek {}\n@implementation Preview\n- (void)testCompletedClock {}'), names);
  assert.throws(() => iosSourceCases('@implementation Decoder\n- (void)testForwardSeek {}\n- (void)testForwardSeek {}'), /unique/);
  requireSourcesPredateRun({ 'ios/decoder.mm': { mtimeMs: 99 } }, 100);
  assert.throws(() => requireSourcesPredateRun({ 'ios/decoder.mm': { mtimeMs: 101 } }, 100), /after the build invocation/);
  assert.throws(() => requireUnchangedFiles({ dependencies: 'before' }, { dependencies: 'after' }), /Sources or fixture changed/);
  assert.throws(() => requireUnchangedFiles({ files: { 'odd.mov': 'before' } }, { files: { 'odd.mov': 'after' } }), /Sources or fixture changed/);
});

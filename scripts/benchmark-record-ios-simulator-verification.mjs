#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { dependencyFingerprint } from './benchmark-verification.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testFile = 'ios/tests/LegacyParityTests.mm';
const fixtureFile = 'ios/tests/fixtures/legacy-odd1279x719.mov';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Count names from the concrete port, then require exactly those names in the
// XCTest tree. A summary saying "50 passed" is insufficient evidence.
export function iosSourceCases(source) {
  const classes = [...source.matchAll(/@implementation\s+(\w+)/g)];
  const names = [...source.matchAll(/-\s*\(void\)\s*(test\w+)/g)].map((match) => {
    const owner = classes.filter((entry) => entry.index < match.index).at(-1)?.[1];
    if (!owner) throw new Error(`XCTest method has no class: ${match[1]}`);
    return `${owner}.${match[1]}`;
  });
  if (!names.length || new Set(names).size !== names.length) {
    throw new Error('Expected a nonempty, unique set of XCTest source methods');
  }
  return names.sort();
}

export function passedSimulatorCases(summary, tree, expectedNames) {
  const expected = new Set(expectedNames);
  if (expected.size !== expectedNames.length || !expected.size) {
    throw new Error('Expected XCTest source names must be unique and nonempty');
  }
  if (summary.result !== 'Passed' || summary.failedTests !== 0 ||
      summary.skippedTests !== 0 || summary.expectedFailures !== 0 ||
      summary.passedTests !== expected.size || summary.totalTestCount !== expected.size ||
      summary.testFailures?.length !== 0) {
    throw new Error('XCTest summary must pass every source case, with no failure, skip or expected failure');
  }
  const configurations = summary.devicesAndConfigurations;
  const devices = tree.devices;
  if (!Array.isArray(configurations) || configurations.length !== 1 ||
      !Array.isArray(devices) || devices.length !== 1 ||
      configurations[0].device?.platform !== 'iOS Simulator' ||
      devices[0].platform !== 'iOS Simulator' ||
      !devices[0].deviceId || devices[0].deviceId !== configurations[0].device.deviceId ||
      configurations[0].passedTests !== expected.size ||
      configurations[0].failedTests !== 0 || configurations[0].skippedTests !== 0 ||
      configurations[0].expectedFailures !== 0) {
    throw new Error('Evidence must describe one actual iOS Simulator run');
  }
  const cases = [];
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) throw new Error('Missing XCTest test tree');
    for (const node of nodes) {
      if (node.nodeType === 'Test Case') {
        const identifier = /^([A-Za-z_]\w*)\/(test\w+)(?:\(\))?$/.exec(node.nodeIdentifier ?? '');
        if (!identifier || node.result !== 'Passed') {
          throw new Error(`Unverified XCTest case: ${node.nodeIdentifier ?? node.name}`);
        }
        const name = `${identifier[1]}.${identifier[2]}`;
        if (!expected.has(name) || cases.some((entry) => entry.name === name)) {
          throw new Error(`Unexpected or repeated XCTest case: ${name}`);
        }
        cases.push({ name, identifier: node.nodeIdentifier, result: node.result,
          ...(Number.isFinite(node.durationInSeconds) ? { durationSeconds: node.durationInSeconds } : {}) });
      } else if (['Test Case Run', 'Repetition', 'Expected Failure', 'Failure Message', 'Skip Message'].includes(node.nodeType)) {
        if (node.nodeType !== 'Test Case Run' && node.nodeType !== 'Repetition' || node.result !== 'Passed') {
          throw new Error(`Unsuccessful or incomplete XCTest run: ${node.nodeType}`);
        }
      }
      if (node.children) walk(node.children);
    }
  };
  walk(tree.testNodes);
  if (cases.length !== expected.size || expectedNames.some((name) => !cases.some((entry) => entry.name === name))) {
    throw new Error('XCTest tree does not contain every expected source case');
  }
  return cases.sort((a, b) => a.name.localeCompare(b.name));
}

export function requireUnchangedFiles(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('Sources or fixture changed while reading XCTest evidence; rerun on stable sources');
  }
}

export function requireSourcesPredateRun(files, runStartedAtMs) {
  if (!Number.isFinite(runStartedAtMs)) throw new Error('Missing build invocation start time');
  for (const [file, metadata] of Object.entries(files)) {
    if (metadata.mtimeMs > runStartedAtMs) {
      throw new Error(`Source changed after the build invocation started: ${file}`);
    }
  }
}

async function sourceIdentity(checkout) {
  const paths = [];
  const visit = async (directory) => {
    for (const entry of await readdir(join(checkout, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:[cm]?[jt]sx?|[hc](?:pp)?|mm|java)$/.test(entry.name)) paths.push(path);
    }
  };
  for (const directory of ['src', 'cpp', 'ios', 'android/src/main', 'android/src/test']) await visit(directory);
  paths.push('package.json', 'package-lock.json', 'test/utils/serializedUiRuntime.ts', fixtureFile,
    'ios/tests/fixtures/legacy-odd1279x719.json', 'react-native-skia-webgpu-video.podspec',
    'example/ios/Podfile', 'example/ios/Podfile.lock',
    'example/ios/ReactNativeSkiaWebGPUVideoExample.xcodeproj/project.pbxproj',
    'example/ios/ReactNativeSkiaWebGPUVideoExample/AppDelegate.swift',
    'example/ios/ReactNativeSkiaWebGPUVideoExample/Info.plist');
  const files = {};
  for (const file of [...new Set(paths)].sort()) {
    const metadata = await stat(join(checkout, file));
    files[file] = { sha256: sha256(await readFile(join(checkout, file))), mtimeMs: metadata.mtimeMs };
  }
  return { dependencies: await dependencyFingerprint(checkout), files };
}

// Inventory import does not run xcresulttool or rewrite any report. A source,
// dependency, fixture or project change invalidates the recorded labels.
export async function currentSimulatorVerification(report, checkout = root) {
  if (!report || report.schema !== 1 || report.executionEnvironment !== 'iOS Simulator' ||
      report.summary?.result !== 'Passed' || report.summary.failedTests !== 0 ||
      report.summary.skippedTests !== 0 || report.summary.expectedFailures !== 0) return null;
  const identity = await sourceIdentity(checkout);
  if (report.dependencies !== identity.dependencies) return null;
  for (const [file, metadata] of Object.entries(identity.files)) {
    if (report.files?.[file] !== metadata.sha256) return null;
  }
  const names = iosSourceCases(await readFile(join(checkout, testFile), 'utf8'));
  if (names.length !== 50 || report.summary.passedTests !== names.length ||
      report.summary.totalTestCount !== names.length || report.passedCases?.length !== names.length ||
      new Set(report.passedCases.map((entry) => entry.name)).size !== names.length ||
      names.some((name) => !report.passedCases.some((entry) => entry.name === name && entry.result === 'Passed')) ||
      report.passedAssertions?.length !== names.length ||
      names.some((name) => !report.passedAssertions.includes(`${testFile}:${name}`))) return null;
  if (report.fixture?.file !== fixtureFile || report.fixture.sha256 !== identity.files[fixtureFile].sha256 ||
      report.fixture.metadata?.sha256 !== identity.files[fixtureFile].sha256 ||
      !/^iphonesimulator[\d.]+$/.test(report.sdk ?? '')) return null;
  return report;
}

function runTool(args) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`xcrun ${args.slice(0, 4).join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function invocationStart(resultPath) {
  // The repository runner creates this directory before boot/build. Refuse
  // unrelated bundles whose pre-compilation identity cannot be established.
  const match = /^skia-webgpu-simulator-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/.exec(basename(dirname(resultPath)));
  if (!match) throw new Error('Use a result produced by scripts/test-ios-simulator.mjs (dated run directory required)');
  return Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
}

export async function recordSimulatorVerification(resultPath, output = join(root, 'benchmark/ios-simulator-verification.json')) {
  const bundle = resolve(resultPath);
  const startedAtMs = invocationStart(bundle);
  const before = await sourceIdentity(root);
  requireSourcesPredateRun(before.files, startedAtMs);
  const sourceNames = iosSourceCases(await readFile(join(root, testFile), 'utf8'));
  if (sourceNames.length !== 50) throw new Error('The concrete legacy iOS port must contain 50 test cases');
  const summaryText = runTool(['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle, '--compact']);
  const treeText = runTool(['xcresulttool', 'get', 'test-results', 'tests', '--path', bundle, '--compact']);
  const summary = JSON.parse(summaryText);
  const tree = JSON.parse(treeText);
  const passedCases = passedSimulatorCases(summary, tree, sourceNames);
  if (!Number.isFinite(summary.startTime) || !Number.isFinite(summary.finishTime) ||
      summary.startTime * 1000 < startedAtMs || summary.finishTime < summary.startTime) {
    throw new Error('XCTest timestamps do not match the build invocation');
  }
  const log = await readFile(join(dirname(bundle), 'xcodebuild.log'), 'utf8');
  if (!/\*\* TEST SUCCEEDED \*\*/.test(log) || !/-configuration Release/.test(log) ||
      !/platform=iOS Simulator/.test(log)) throw new Error('Expected completed Release Simulator build/test log');
  // This metadata survives an incremental build with no compiler commands.
  const actionsText = runTool(['xcresulttool', 'get', 'object', '--legacy', '--path', bundle, '--format', 'json']);
  const actions = JSON.parse(actionsText).actions?._values;
  const action = actions?.length === 1 ? actions[0] : null;
  const sdk = action?.runDestination?.targetSDKRecord?.identifier?._value;
  if (action?.schemeCommandName?._value !== 'Test' || !/^iphonesimulator[\d.]+$/.test(sdk ?? '') ||
      action.runDestination.targetDeviceRecord?.identifier?._value !== tree.devices[0].deviceId) {
    throw new Error('XCTest action metadata does not identify the same Simulator and SDK');
  }
  const loggedSdks = [...new Set([...log.matchAll(/(iPhoneSimulator[\d.]+)\.sdk/g)].map((entry) => entry[1].toLowerCase()))];
  if (loggedSdks.some((entry) => entry !== sdk)) throw new Error('Compiler SDK and XCTest action SDK differ');
  const fixtureMetadata = JSON.parse(await readFile(join(root, 'ios/tests/fixtures/legacy-odd1279x719.json'), 'utf8'));
  if (fixtureMetadata.sha256 !== before.files[fixtureFile].sha256 || fixtureMetadata.width !== 1279 ||
      fixtureMetadata.height !== 719 || fixtureMetadata.frames !== 30 ||
      !fixtureMetadata.frameIndicesExact || !fixtureMetadata.timestampsExact) {
    throw new Error('Odd-dimension fixture metadata does not match the actual tested file');
  }
  const after = await sourceIdentity(root);
  requireUnchangedFiles(before, after);
  const device = tree.devices[0];
  const report = { schema: 1, completedAt: new Date().toISOString(), executionEnvironment: 'iOS Simulator',
    buildInvocationStartedAt: new Date(startedAtMs).toISOString(),
    testStartedAt: new Date(summary.startTime * 1000).toISOString(),
    testFinishedAt: new Date(summary.finishTime * 1000).toISOString(),
    configuration: 'Release', sdk, dependencies: before.dependencies,
    files: Object.fromEntries(Object.entries(before.files).map(([file, value]) => [file, value.sha256])),
    simulator: { platform: device.platform, modelName: device.modelName, architecture: device.architecture,
      osVersion: device.osVersion, osBuildNumber: device.osBuildNumber },
    summary: { result: summary.result, totalTestCount: summary.totalTestCount, passedTests: summary.passedTests,
      failedTests: summary.failedTests, skippedTests: summary.skippedTests, expectedFailures: summary.expectedFailures },
    passedCases, passedAssertions: passedCases.map((entry) => `${testFile}:${entry.name}`),
    fixture: { file: fixtureFile, sha256: before.files[fixtureFile].sha256,
      metadata: fixtureMetadata },
    evidence: { resultBundle: bundle, resultInfoSha256: sha256(await readFile(join(bundle, 'Info.plist'))),
      summarySha256: sha256(summaryText), testNodesSha256: sha256(treeText),
      actionMetadataSha256: sha256(actionsText), buildLogSha256: sha256(log),
      xcode: runTool(['xcodebuild', '-version']).trim() },
    runtimeWarnings: (summary.runtimeWarnings ?? []).map((warning) => ({ issueType: warning.issueType,
      message: warning.message, ...(warning.sourceURL?.startsWith(`file://${root}/`)
        ? { sourceFile: warning.sourceURL.slice(`file://${root}/`.length) } : {}) })),
    limits: ['These are named XCTest cases with multiple pixel/frame/lifetime assertions, not 50 individual assertions.',
      'Simulator execution does not qualify physical iOS or Android hardware and is not an A/B memory/performance measurement.',
      'Source freshness uses the runner invocation timestamp and conservative file modification times; later source edits invalidate this proof.'] };
  // Raw device identity is retained only in the already-ignored local folder.
  await mkdir(join(root, 'benchmark/results'), { recursive: true });
  await writeFile(join(root, 'benchmark/results/ios-simulator-xcresult.local.json'),
    `${JSON.stringify({ resultBundle: bundle, summary, tree, actions: JSON.parse(actionsText) }, null, 2)}\n`);
  const temporary = `${output}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, output);
  return report;
}

function selfTest() {
  const expected = ['One.testA', 'Two.testB'];
  const device = { deviceId: 'local', platform: 'iOS Simulator' };
  const summary = { result: 'Passed', totalTestCount: 2, passedTests: 2, failedTests: 0, skippedTests: 0,
    expectedFailures: 0, testFailures: [], devicesAndConfigurations: [{ device, passedTests: 2,
      failedTests: 0, skippedTests: 0, expectedFailures: 0 }] };
  const tree = { devices: [device], testNodes: [{ nodeType: 'Test Suite', children: expected.map((name) => ({
    nodeType: 'Test Case', nodeIdentifier: name.replace('.', '/'), result: 'Passed', name: name.split('.')[1] })) }] };
  assert.deepEqual(passedSimulatorCases(summary, tree, expected).map((entry) => entry.name), expected);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  let assertions = 1;
  for (const edit of [
    (s) => { s.result = 'Failed'; }, (s) => { s.failedTests = 1; },
    (s) => { s.skippedTests = 1; }, (s) => { s.expectedFailures = 1; },
    (s) => { s.totalTestCount = 50; }, (s) => { s.passedTests = 50; },
    (s) => { s.testFailures = [{}]; },
    (s) => { s.devicesAndConfigurations[0].device.platform = 'iOS'; },
    (s) => { s.devicesAndConfigurations[0].failedTests = 1; },
  ]) { const value = clone(summary); edit(value); assert.throws(() => passedSimulatorCases(value, tree, expected)); assertions++; }
  for (const edit of [
    (t) => { t.testNodes[0].children.pop(); },
    (t) => { t.testNodes[0].children[1].nodeIdentifier = 'Two/testOther'; },
    (t) => { t.testNodes[0].children[1].nodeIdentifier = 'One/testA'; },
    (t) => { t.testNodes[0].children[1].result = 'Skipped'; },
    (t) => { t.testNodes[0].children[1].result = 'Expected Failure'; },
    (t) => { delete t.testNodes[0].children[1].nodeIdentifier; },
    (t) => { t.devices[0].deviceId = 'other'; },
    (t) => { t.testNodes[0].children[1].children = [{ nodeType: 'Test Case Run', result: 'Failed' }]; },
  ]) { const value = clone(tree); edit(value); assert.throws(() => passedSimulatorCases(summary, value, expected)); assertions++; }
  assert.deepEqual(iosSourceCases('@implementation One\n- (void)testA {}\n@implementation Two\n- (void)testB {}'), expected); assertions++;
  assert.throws(() => iosSourceCases('@implementation One\n- (void)testA {}\n- (void)testA {}')); assertions++;
  assert.throws(() => requireUnchangedFiles({ dependencies: 'old' }, { dependencies: 'new' })); assertions++;
  assert.throws(() => requireUnchangedFiles({ files: { [fixtureFile]: 'old' } }, { files: { [fixtureFile]: 'new' } })); assertions++;
  assert.throws(() => requireSourcesPredateRun({ 'ios/changed.mm': { mtimeMs: 101 } }, 100)); assertions++;
  requireSourcesPredateRun({ 'ios/stable.mm': { mtimeMs: 99 } }, 100); assertions++;
  console.log(JSON.stringify({ simulatorRecorderAssertions: assertions, passed: true }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') selfTest();
  else {
    const [bundle, output] = process.argv.slice(2);
    if (!bundle) throw new Error('Usage: node scripts/benchmark-record-ios-simulator-verification.mjs RESULT.xcresult [OUTPUT.json]\n  --self-test validates failure/skip/name/freshness rejection without running a simulator');
    const report = await recordSimulatorVerification(bundle, output);
    console.log(JSON.stringify({ passedCases: report.passedCases.length, executionEnvironment: report.executionEnvironment,
      failed: report.summary.failedTests, skipped: report.summary.skippedTests,
      output: output ?? 'benchmark/ios-simulator-verification.json' }));
  }
}

#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildCases } from '../benchmark/cases.mjs';
import { dependencyFingerprint } from './benchmark-verification.mjs';
import { currentSimulatorVerification } from './benchmark-record-ios-simulator-verification.mjs';

const [sourceDirectory = fileURLToPath(new URL('../../react-native-skia-video/', import.meta.url)), output = 'benchmark/baseline-test-inventory.json'] = process.argv.slice(2);
const roots = ['src/__tests__', 'test/native', 'android/src/test', 'android/src/androidTest', 'example/ios/ReactNativeSkiaVideoExampleTests'];
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const cases = [];
const sourceFiles = new Map();
async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await filesUnder(join(directory, entry.name)));
    else files.push(join(directory, entry.name));
  }
  return files.sort();
}
for (const root of roots) {
  for (const path of await filesUnder(join(sourceDirectory, root))) {
    const source = await readFile(path, 'utf8');
    const file = relative(sourceDirectory, path);
    sourceFiles.set(file, createHash('sha256').update(source).digest('hex'));
    const add = (match, kind, name, extra = {}) => cases.push({ id: `${file}:${name}`, file, line: lineAt(source, match.index), name, kind, ...extra });
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) {
      for (const match of source.matchAll(/\bit\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) add(match, 'jest', match[2]);
    } else if (file.endsWith('.java')) {
      const parameters = source.includes('@RunWith(Parameterized.class)') ? [...source.matchAll(/new Spec\("([^"\n]+)"/g)].map((match) => match[1]) : [];
      if (file.endsWith('/PlayerTest.java')) parameters.push('eager', 'lazy');
      for (const match of source.matchAll(/@Test(?:\([^)]*\))?\s+public\s+void\s+(\w+)/g)) add(match, file.includes('/androidTest/') ? 'android-device' : 'android-host', match[1], parameters.length ? { parameters } : {});
    } else if (file.endsWith('.mm')) {
      const classes = [...source.matchAll(/@implementation\s+(\w+)/g)];
      for (const match of source.matchAll(/-\s*\(void\)\s*(test\w+)/g)) {
        const owner = classes.filter((entry) => entry.index < match.index).at(-1)?.[1];
        add(match, 'ios-device', `${owner}.${match[1]}`);
      }
    } else if (file.endsWith('Test.cpp')) {
      for (const match of source.matchAll(/expect\(\s*"([^"]+)"/g)) add(match, 'cpp-host', match[1]);
    }
  }
}
const scenarios = buildCases();
function workloadFamily(entry) {
  const value = entry.name.toLowerCase();
  if (entry.kind === 'jest' || entry.kind.endsWith('-host')) return { reproduction: 'host-assertion', note: 'Source correspondence and execution are recorded separately; timing mocked JS or policy helpers is not native GPU performance' };
  const families = [];
  if (/seek|scrub|threshold|pasttheend|aftertheend|resume|paused/.test(value)) families.push('seek', 'scrub', 'seek-playing', 'scrub-playing', 'pause-resume', 'seek-past-end', 'seek-before-ready');
  if (/closed.*framesobject|closeditem|release|dispose/.test(value)) families.push('frame-map-pruning');
  if (/loop|wrap/.test(value)) families.push('loop');
  if (/release|dispose|retire|closed|fewer|fewdecoders/.test(value)) families.push('leak', 'churn');
  if (/export|encode|everyframe|framesat|gives.*frame/.test(value)) families.push('export', 'mixed-exports');
  if (/play|complete|clock/.test(value)) families.push('play', 'perf');
  if (/1080|4k|60fps|odd|hevc|rotate|rotation|cap|resolution|direct|crop|pixel|testvideo|slowmotion/.test(value)) families.push('seek', 'export', 'hold');
  if (/cannotopen|codecs|dolby|error/.test(value)) families.push('open-error');
  if (!families.length) families.push('play', 'seek', 'export');
  return { reproduction: 'related-shared-workload', scenarioIds: scenarios.filter((scenario) => scenario.operations.some((op) => families.includes(op))).map((scenario) => scenario.id), workloadMapping: 'related-operation-family; not an assertion-equivalence proof', note: /retire.*four/.test(value) ? 'Keep the safety intent; Graphite retirement uses completion ownership rather than reproducing the unsafe four-frame heuristic' : 'Native pixel/frame-index/thread assertions remain required; shared workload parity is not an assertion-equivalence proof' };
}
const aliases = new Map([
  ['encodes every frame from the offscreen surface and tears down', 'encodes every full BGRA frame, synchronizes rendering, and releases the surface'],
  ['forwards encoderMode to the native encoder, and nothing by default', 'forwards encoderMode and leaves it undefined by default'],
  ['reuses the surface across exports and rebuilds it when the size changes', 'retains no surface across equal or mixed-resolution exports'],
  ['reports progress after each frame', 'reports progress after every encoded frame'],
  ['encodes and reports a whole number of frames for a summed duration', 'encodes an integer frame count for summed durations near a frame boundary'],
  ['rejects with an AbortError when the signal is already aborted', 'rejects an already aborted signal without allocating native resources'],
  ["makes Skia's context before preparing, for a player drawn first", 'prepares a player drawn first without the legacy GL warm-up surface'],
  ['recycles the output image', 'accepts a recycled output without overwriting the owned frame image'],
  ['uses the given paint, recycles the image and returns it', 'uses the given paint, accepts recycled output and returns the owned frame image'],
  ['theFrameIsTheDecoderBufferWithItsCropAndRotation', 'bothModesKeepTheirPixelsCropOrientationAndTimestamp'],
]);
const safetyChanges = new Set(['reuses the surface across exports and rebuilds it when the size changes', "makes Skia's context before preparing, for a player drawn first", 'recycles the output image', 'uses the given paint, recycles the image and returns it', 'theFrameIsTheDecoderBufferWithItsCropAndRotation']);
const candidateDirectory = new URL('../', import.meta.url).pathname;
let hostVerification;
try { hostVerification = JSON.parse(await readFile(join(candidateDirectory, 'benchmark/host-verification.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (hostVerification?.dependencies !== await dependencyFingerprint(candidateDirectory)) hostVerification = null;
let simulatorVerification;
try {
  simulatorVerification = await currentSimulatorVerification(JSON.parse(
    await readFile(join(candidateDirectory, 'benchmark/ios-simulator-verification.json'), 'utf8')),
  candidateDirectory);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
async function correspondence(entry) {
  let source;
  const candidateFile = entry.kind === 'ios-device' ? 'ios/tests/LegacyParityTests.mm' : entry.file;
  try { source = await readFile(join(candidateDirectory, candidateFile), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { status: 'native-assertion-port-pending', executionStatus: 'pending-device-run', candidateAssertion: null };
  }
  const targetName = aliases.get(entry.name) ?? entry.name;
  const candidates = entry.kind === 'jest'
    ? [...source.matchAll(/\bit\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map((match) => ({ name: match[2], index: match.index }))
    : entry.kind === 'cpp-host'
      ? [...source.matchAll(/expect\(\s*"([^"]+)"/g)].map((match) => ({ name: match[1], index: match.index }))
      : entry.kind === 'ios-device'
        ? [...source.matchAll(/-\s*\(void\)\s*(test\w+)/g)].map((match) => {
          const owner = [...source.matchAll(/@implementation\s+(\w+)/g)].filter((item) => item.index < match.index).at(-1)?.[1];
          return { name: `${owner}.${match[1]}`, index: match.index };
        })
        : [...source.matchAll(/@Test(?:\([^)]*\))?\s+public\s+void\s+(\w+)/g)].map((match) => ({ name: match[1], index: match.index }));
  const found = candidates.find((candidate) => candidate.name === targetName);
  if (!found) return { status: 'assertion-mapping-pending', executionStatus: entry.kind.endsWith('-device') ? 'pending-device-run' : 'pending-host-run', candidateAssertion: null };
  const digest = createHash('sha256').update(source).digest('hex');
  const verified = hostVerification?.files?.[candidateFile] === digest && hostVerification?.passedAssertions?.includes(`${candidateFile}:${targetName}`);
  const simulatorVerified = entry.kind === 'ios-device' && simulatorVerification?.files?.[candidateFile] === digest &&
    simulatorVerification?.passedAssertions?.includes(`${candidateFile}:${targetName}`);
  const changedLeaseAssertion = ['ItemDecoderExportTests.testReleaseFreesTheDecoder', 'ItemDecoderExportTests.testDirectFramesAreRetiredOneByOneInExport', 'ItemDecoderPreviewTests.testDirectFramesAreRetiredAfterFourInPreview'].includes(entry.name);
  const safetyChange = safetyChanges.has(entry.name) || changedLeaseAssertion;
  return { status: safetyChange ? 'intentional-safety-change' : 'assertion-reproduced', executionStatus: simulatorVerified ? 'passed-ios-simulator' : entry.kind.endsWith('-device') ? 'pending-device-run' : verified ? 'passed-host-run' : 'pending-host-run', candidateAssertion: { file: candidateFile, name: targetName, line: lineAt(source, found.index), sha256: digest }, ...(simulatorVerified ? { executionEvidence: 'benchmark/ios-simulator-verification.json', hardwareQualification: 'pending-physical-ios-run' } : {}), ...(safetyChange ? { compatibilityNote: 'The old texture/cache mechanism is deliberately replaced; compare API behavior, bounded ownership and pixel correctness instead of the old allocation heuristic' } : {}) };
}
const mappedCases = [];
for (const entry of cases) mappedCases.push({ ...entry, sourceSha256: sourceFiles.get(entry.file), ...workloadFamily(entry), ...await correspondence(entry) });
let sourceCommit;
try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDirectory, encoding: 'utf8' }).trim(); } catch { sourceCommit = 'unavailable'; }
const inventory = { schema: 3, sourceRepository: 'https://github.com/AzzappApp/react-native-skia-video', sourceCommit, license: 'MIT, Copyright (c) 2024 Azzapp; see repository LICENSE', counts: Object.fromEntries([...new Set(cases.map((entry) => entry.kind))].map((kind) => [kind, cases.filter((entry) => entry.kind === kind).length])), coverage: Object.fromEntries([...new Set(mappedCases.map((entry) => entry.executionStatus))].map((status) => [status, mappedCases.filter((entry) => entry.executionStatus === status).length])), cases: mappedCases, sharedWorkloads: scenarios.map((scenario) => ({ id: scenario.id, operations: scenario.operations })), additionalNativeEvidence: ['test/native/RuntimeLifetimeTest.cpp', 'test/native/MemoryBudgetTest.cpp', 'ios/tests/BufferOwnershipTest.mm', 'ios/tests/EncoderReferenceTest.mm'], caveat: 'Named source cases are counted before native parameter expansion and may contain many assertions. Workload-family links do not prove assertion equivalence. All 50 iOS cases are ported to native-buffer/pixel descriptors; lease-retirement assertions intentionally require consumer completion. A passed-ios-simulator label requires every named XCTest case in a successful current-source run, and does not qualify physical iOS hardware. Android instrumentation still requires execution on a device. Additional macOS ownership/encoder tests and shared workloads do not replace those assertions or provide an A/B performance result.' };
await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(JSON.stringify({ sourceCommit, counts: inventory.counts, coverage: inventory.coverage, workloads: scenarios.length, output }));

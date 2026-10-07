#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Legacy baseline iOS Simulator (Release, no signing or Metro)
  node scripts/test-ios-baseline-simulator.mjs --simulator <UDID> --launch [--profile smoke|full|soak] [--case <ID>] [--repetitions 1]
  node scripts/test-ios-baseline-simulator.mjs --simulator <UDID> --build-only

--build-only compiles the historical library without running measurements (default).
--launch installs the app and runs the requested test scenarios.
The script does not start or install anything on a physical iPhone.
`;
const options = { simulator: '', mode: 'build-only', profile: '', caseIds: [], repetitions: 3 };
let selectedMode = false;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0); }
  if (['--simulator', '--profile', '--case', '--repetitions'].includes(arg)) {
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--case') options.caseIds.push(value);
    else if (arg === '--repetitions') options.repetitions = Number(value);
    else options[arg.slice(2)] = value;
  } else if (['--launch', '--build-only'].includes(arg)) {
    if (selectedMode) throw new Error('Choose one run mode');
    options.mode = arg.slice(2);
    selectedMode = true;
  } else throw new Error(`Unknown argument: ${arg}\n${usage}`);
}
if (process.platform !== 'darwin') throw new Error('iOS Simulator requires macOS and Xcode');
if (!/^[0-9A-Fa-f-]{36}$/.test(options.simulator)) throw new Error(`Provide --simulator <UDID>\n${usage}`);
if (options.profile && (options.mode !== 'launch' || !['smoke', 'full', 'soak'].includes(options.profile))) {
  throw new Error('--profile smoke|full|soak requires --launch');
}
if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 10) {
  throw new Error('--repetitions must be an integer between 1 and 10');
}
if (options.caseIds.length && (options.mode !== 'launch' || !options.profile ||
    options.caseIds.some((id) => !/^[a-zA-Z0-9_.-]+$/.test(id)))) {
  throw new Error('--case requires --launch --profile and a valid scenario ID');
}
const workspace = path.join(root, 'example-baseline/ios/ReactNativeSkiaVideoBaseline.xcworkspace');
await access(workspace);
await access(path.join(root, 'example-baseline/ios/Pods/Manifest.lock'));
await access(path.join(root, 'example-baseline/fixtures/manifest.json'));
const directory = path.join(os.tmpdir(), `skia-baseline-simulator-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(directory, { recursive: true });
const derivedData = '/private/tmp/rnskv-baseline-simulator-build';
console.log(`Simulator: ${options.simulator} · Release · ${options.mode}`);
console.log(`Evidence: ${directory}`);

async function run(program, args, logName, environment = {}) {
  const logPath = path.join(directory, logName);
  const log = createWriteStream(logPath, { flags: 'wx' });
  let tail = '';
  const child = spawn(program, args, { cwd: path.join(root, 'example-baseline/ios'),
    env: { ...process.env, ...environment }, stdio: ['inherit', 'pipe', 'pipe'] });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  function record(chunk) { log.write(chunk); tail = (tail + chunk.toString()).slice(-32768); }
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  }).finally(() => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    log.end();
  });
  if (code !== 0) {
    const errors = tail.split('\n').filter((line) => /error:|Error:|failed|FAILED/.test(line));
    console.error(errors.slice(-15).join('\n') || tail.slice(-4000));
    console.error(`Full log: ${logPath}`);
    process.exitCode = code;
    throw new Error(`${program} exited with ${code}`);
  }
  console.log(`${logName}: succeeded`);
}

await run('xcrun', ['simctl', 'bootstatus', options.simulator, '-b'], 'boot.log');
const buildArguments = ['build',
  '-workspace', workspace, '-scheme', 'ReactNativeSkiaVideoBaseline',
  '-configuration', 'Release', '-destination', `platform=iOS Simulator,id=${options.simulator}`,
  '-derivedDataPath', derivedData, '-parallel-testing-enabled', 'NO',
  'CODE_SIGNING_ALLOWED=NO', 'ONLY_ACTIVE_ARCH=YES'];
await run('xcodebuild', buildArguments, 'xcodebuild.log', {
  SOURCEMAP_FILE: path.join(directory, 'main.jsbundle.map'),
});
if (options.mode === 'launch') {
  const app = path.join(derivedData, 'Build/Products/Release-iphonesimulator/ReactNativeSkiaVideoBaseline.app');
  await run('xcrun', ['simctl', 'install', options.simulator, app], 'install.log');
  const environment = options.profile ? {
    SIMCTL_CHILD_RNSKV_BENCHMARK_PROFILE: options.profile,
    SIMCTL_CHILD_RNSKV_BENCHMARK_REPETITIONS: String(options.repetitions),
    ...(options.caseIds.length ? { SIMCTL_CHILD_RNSKV_BENCHMARK_CASE_IDS: JSON.stringify(options.caseIds) } : {}),
  } : {};
  await run('xcrun', ['simctl', 'launch', '--terminate-running-process', options.simulator,
    'com.seb.skiavideo.baseline.test'], 'launch.log', environment);
  console.log(options.profile ? `Test profile ${options.profile} started.` : 'Test menu opened.');
  console.log('Results: app data container / Documents / benchmark-results.');
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `iPhone tests (Release, isolated com.seb.skiawebgpuvideo.test app)
  node scripts/test-ios-device.mjs --device <UDID> [--team <TEAM>] --native
  node scripts/test-ios-device.mjs --device <UDID> [--team <TEAM>] --launch
  node scripts/test-ios-device.mjs --device <UDID> [--team <TEAM>] --build-only
  node scripts/test-ios-device.mjs --unsigned

--native runs the 50 native XCTest cases (default).
--launch builds, installs and opens the benchmark screen; select a profile there.
--profile smoke|full|soak with --launch starts that benchmark profile automatically.
--unsigned only verifies compilation; it cannot install or execute device tests.
An Apple account in Xcode and a development profile are required for signed runs.
Logs and XCTest results are saved in the temporary directory printed below.
`;

const options = { mode: 'native', unsigned: false, device: '', team: '', profile: '' };
let selectedMode = false;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0); }
  if (arg === '--device' || arg === '--team' || arg === '--profile') {
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2)] = value;
  } else if (['--native', '--launch', '--build-only'].includes(arg)) {
    if (selectedMode) throw new Error('Choose only one run mode');
    options.mode = arg.slice(2);
    selectedMode = true;
  } else if (arg === '--unsigned') options.unsigned = true;
  else throw new Error(`Unknown argument: ${arg}\n${usage}`);
}
if (process.platform !== 'darwin') throw new Error('Device tests require macOS and Xcode');
if (options.team && !/^[A-Z0-9]{10}$/.test(options.team)) throw new Error('Invalid Apple team ID');
if (options.unsigned && selectedMode && options.mode !== 'build-only') {
  throw new Error('--unsigned can only be used with --build-only');
}
if (options.unsigned) options.mode = 'build-only';
if (options.profile && (options.mode !== 'launch' || !['smoke', 'full', 'soak'].includes(options.profile))) {
  throw new Error('--profile smoke|full|soak requires --launch');
}

const localDevicePath = path.join(root, 'example/device.local.json');
let localDevice = {};
try { localDevice = JSON.parse(await readFile(localDevicePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
options.device ||= localDevice.deviceId ?? '';
if (!options.unsigned && !options.device) throw new Error(`Provide --device <UDID>\n${usage}`);
if (options.device && !/^[A-Za-z0-9-]+$/.test(options.device)) {
  throw new Error('Use the device UDID from Xcode, not its display name');
}
if (options.device) {
  await writeFile(localDevicePath, JSON.stringify({ ...localDevice, deviceId: options.device }, null, 2) + '\n');
} else {
  // Make the standalone application bundleable even before choosing a phone.
  await writeFile(localDevicePath, JSON.stringify({ deviceId: null }, null, 2) + '\n');
}
await access(path.join(root, 'example/ios/Pods/Manifest.lock'));
await access(path.join(root, 'example/fixtures/manifest.json'));
const workspace = path.join(root, 'example/ios/ReactNativeSkiaWebGPUVideoExample.xcworkspace');
await access(workspace);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.join(os.tmpdir(), `skia-webgpu-device-${timestamp}`);
await mkdir(directory, { recursive: true });
// Reuse compilation products without reusing a different application's identity.
const derivedData = path.join(os.tmpdir(), 'rnskv-webgpu-device-build');
const resultBundle = path.join(directory, 'NativeTests.xcresult');
console.log(`Device: ${options.device || 'compile only'} · Release · ${options.mode}`);
console.log(`Evidence: ${directory}`);

async function run(program, args, logName) {
  const logPath = path.join(directory, logName);
  const log = createWriteStream(logPath, { flags: 'wx' });
  let tail = '';
  const child = spawn(program, args, { cwd: path.join(root, 'example/ios'), stdio: ['inherit', 'pipe', 'pipe'] });
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  function record(chunk) {
    log.write(chunk);
    tail = (tail + chunk.toString()).slice(-32768);
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve(status ?? (signal ? 130 : 1)));
  }).finally(() => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    log.end();
  });
  if (code !== 0) {
    const errors = tail.split('\n').filter((line) => /error:|Error:|No Accounts|No profiles|failed|FAILED/.test(line));
    console.error(errors.slice(-15).join('\n') || tail.slice(-4000));
    console.error(`Full log: ${logPath}`);
    process.exitCode = code;
    throw new Error(`${program} exited with ${code}`);
  }
  console.log(`${logName}: succeeded`);
}

const buildAction = options.mode === 'native' ? 'test' : options.mode === 'launch' ? 'build' : 'build-for-testing';
const buildArguments = [buildAction, '-workspace', workspace,
  '-scheme', 'ReactNativeSkiaWebGPUVideoExample', '-configuration', 'Release',
  '-destination', options.unsigned ? 'generic/platform=iOS' : `platform=iOS,id=${options.device}`,
  '-derivedDataPath', derivedData, '-parallel-testing-enabled', 'NO'];
if (options.mode === 'native') buildArguments.push('-resultBundlePath', resultBundle,
  '-collect-test-diagnostics', 'never', '-test-timeouts-enabled', 'YES',
  '-default-test-execution-time-allowance', '60');
if (options.unsigned) buildArguments.push('CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO');
else {
  buildArguments.push('-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration');
  if (options.team) buildArguments.push(`DEVELOPMENT_TEAM=${options.team}`);
}
await run('xcodebuild', buildArguments, 'xcodebuild.log');
if (options.mode === 'native') console.log(`Native test result: ${resultBundle}`);
if (options.mode === 'launch') {
  const app = path.join(derivedData, 'Build/Products/Release-iphoneos/ReactNativeSkiaWebGPUVideoExample.app');
  await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', options.device, app,
    '--json-output', path.join(directory, 'install.json')], 'install.log');
  const launchArguments = ['devicectl', 'device', 'process', 'launch', '--device', options.device,
    '--terminate-existing', '--json-output', path.join(directory, 'launch.json'),
    ...(options.profile ? ['--environment-variables', JSON.stringify({ RNSKV_BENCHMARK_PROFILE: options.profile })] : []),
    'com.seb.skiawebgpuvideo.test'];
  await run('xcrun', launchArguments, 'launch.log');
  console.log(options.profile ? `Benchmark ${options.profile} started.` : 'Choose Test rapide on the iPhone.');
  console.log('Comparison JSON files stay in Documents/benchmark-results.');
}

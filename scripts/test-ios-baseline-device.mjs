#!/usr/bin/env node
// Build the historical library in its isolated iPhone app. This command never
// launches a benchmark; use the shared device runner after both builds settle.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Historical baseline iPhone build (Release)
  node scripts/test-ios-baseline-device.mjs --device <UDID> [--team <TEAM>] [--install]

Builds the isolated com.seb.skiavideo.baseline.test app. --install installs it
without launching measurements. The original library source remains unchanged.
`;
const options = { device: '', team: '', install: false };
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0); }
  if (arg === '--install') { options.install = true; continue; }
  if (!['--device', '--team'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  const value = process.argv[++index];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
  options[arg.slice(2)] = value;
}
if (process.platform !== 'darwin') throw new Error('An iPhone build requires macOS and Xcode');
if (!/^[A-Za-z0-9-]+$/.test(options.device)) throw new Error('Provide --device with the iPhone UDID');
if (options.team && !/^[A-Z0-9]{10}$/.test(options.team)) throw new Error('Invalid Apple team ID');
const example = path.join(root, 'example-baseline');
const metadataPath = path.join(example, 'device.local.json');
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
if (metadata.deviceId !== options.device) {
  throw new Error('The requested iPhone must match example-baseline/device.local.json before bundling');
}
const workspace = path.join(example, 'ios/ReactNativeSkiaVideoBaseline.xcworkspace');
await access(workspace);
await access(path.join(example, 'ios/Pods/Manifest.lock'));
await access(path.join(example, 'fixtures/manifest.json'));
const directory = path.join(os.tmpdir(), `skia-baseline-device-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(directory, { recursive: true });
const derivedData = '/private/tmp/rnskv-baseline-device-build';
console.log(`Release baseline: ${options.device}\nEvidence: ${directory}`);

async function run(command, args, name) {
  const logPath = path.join(directory, name);
  const log = createWriteStream(logPath, { flags: 'wx' });
  let tail = '';
  const child = spawn(command, args, { cwd: path.join(example, 'ios'),
    env: { ...process.env, SOURCEMAP_FILE: path.join(directory, 'main.jsbundle.map') },
    stdio: ['inherit', 'pipe', 'pipe'] });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const record = bytes => { log.write(bytes); tail = (tail + bytes.toString()).slice(-12000); };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', status => resolve(status ?? 1));
  }).finally(() => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    log.end();
  });
  if (code !== 0) {
    console.error(tail);
    process.exitCode = code;
    throw new Error(`${command} failed; log: ${logPath}`);
  }
  console.log(`${name}: succeeded`);
}
const args = ['build', '-workspace', workspace, '-scheme', 'ReactNativeSkiaVideoBaseline',
  '-configuration', 'Release', '-destination', `platform=iOS,id=${options.device}`,
  '-derivedDataPath', derivedData, '-parallel-testing-enabled', 'NO',
  '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'ONLY_ACTIVE_ARCH=YES'];
if (options.team) args.push(`DEVELOPMENT_TEAM=${options.team}`);
await run('xcodebuild', args, 'xcodebuild.log');
const app = path.join(derivedData, 'Build/Products/Release-iphoneos/ReactNativeSkiaVideoBaseline.app');
if (options.install) {
  await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', options.device,
    '--json-output', path.join(directory, 'install.json'), app], 'install.log');
}
await writeFile(path.join(directory, 'build.json'), JSON.stringify({ app, device: options.device,
  configuration: 'Release', installed: options.install, launched: false }, null, 2) + '\n');
console.log(`App: ${app}\nNo benchmark was launched.`);

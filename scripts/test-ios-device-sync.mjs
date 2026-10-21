#!/usr/bin/env node
// Install a Release build of the example on an iPhone, run the frame-sync
// profile and copy its report to benchmark/results. No previous result is
// overwritten. The phone must stay unlocked; the app keeps its screen on.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { formatFrameSyncReport } from '../benchmark/frame-sync.mjs';
import { launchWhenUnlocked, OWNED_APPS, resultFiles } from './test-ios-device-ab-run.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'node scripts/test-ios-device-sync.mjs --device UDID --app /path/Release-iphoneos/App.app --label NAME [--case ID ...] [--frame-pixel-format auto|yuv|rgba] [--timeout-minutes 10]';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const options = { timeoutMinutes: 10, cases: [] };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--help' || flag === '-h') { console.log(usage); process.exit(0); }
  const value = process.argv[++i];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}\n${usage}`);
  if (flag === '--device') options.device = value;
  else if (flag === '--app') options.app = path.resolve(value);
  else if (flag === '--label') options.label = value;
  else if (flag === '--case') options.cases.push(value);
  else if (flag === '--frame-pixel-format') options.framePixelFormat = value;
  else if (flag === '--timeout-minutes') options.timeoutMinutes = Number(value);
  else throw new Error(`Unknown argument: ${flag}\n${usage}`);
}
if (!/^[a-zA-Z0-9-]{20,50}$/.test(options.device ?? '') || !options.app || !/^[a-z0-9-]+$/.test(options.label ?? '') ||
    !(options.timeoutMinutes > 0) || !['auto', 'yuv', 'rgba', undefined].includes(options.framePixelFormat) ||
    options.cases.some((id) => !/^[a-zA-Z0-9_.-]+$/.test(id))) throw new Error(`Invalid arguments\n${usage}`);
await access(options.app);
const output = path.join(root, 'benchmark/results', `${options.label}.local.json`);
try { await access(output); throw new Error(`${output} already exists; choose a new label`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const { bundle } = OWNED_APPS.candidate;
const scratch = await mkdtemp(path.join(tmpdir(), 'rnskv-sync-'));
const devicectl = async (args) => {
  const json = path.join(scratch, `${randomUUID()}.json`);
  await exec('xcrun', ['devicectl', ...args.slice(0, 3), '--device', options.device, '--timeout', '30',
    '--json-output', json, ...args.slice(3)], { maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
  const result = JSON.parse(await readFile(json, 'utf8'));
  if (result.info?.outcome !== 'success') throw new Error(`Device command failed: ${args.join(' ')}`);
  return result.result;
};
const results = async () => resultFiles((await devicectl(['device', 'info', 'files', '--domain-type', 'appDataContainer',
  '--domain-identifier', bundle, '--subdirectory', 'Documents', '--recurse'])).files, 'candidate')
  .map((file) => file.relativePath);

try {
  await devicectl(['device', 'install', 'app', options.app]);
  const before = new Set(await results());
  await launchWhenUnlocked(() => devicectl(['device', 'process', 'launch', '--terminate-existing', '--activate',
    '--environment-variables', JSON.stringify({ RNSKV_BENCHMARK_PROFILE: 'sync', RNSKV_BENCHMARK_RUN_ID: randomUUID(),
      ...(options.cases.length ? { RNSKV_BENCHMARK_CASE_IDS: JSON.stringify(options.cases) } : {}),
      ...(options.framePixelFormat ? { RNSKV_FRAME_PIXEL_FORMAT: options.framePixelFormat } : {}) }), bundle]),
  { onLocked: async () => console.log(`${options.label}: iPhone locked; unlock it to start`) });
  console.log(`${options.label}: frame-sync profile started on ${options.device}`);
  const started = Date.now();
  let created;
  for (;;) {
    if (Date.now() - started > options.timeoutMinutes * 60000) throw new Error('Frame-sync deadline exceeded');
    await sleep(10000);
    created = (await results()).find((name) => !before.has(name));
    if (created) break;
    console.log(`${options.label}: running ${Math.round((Date.now() - started) / 1000)}s`);
  }
  await devicectl(['device', 'copy', 'from', '--domain-type', 'appDataContainer', '--domain-identifier', bundle,
    '--source', `Documents/${created}`, '--destination', output]);
  const report = JSON.parse(await readFile(output, 'utf8'));
  for (const line of formatFrameSyncReport(report)) console.log(line);
  console.log(`${options.label}: ${output}`);
  if (report.status !== 'passed') process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}

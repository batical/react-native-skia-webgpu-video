#!/usr/bin/env node
// Install one signed Android build of the example, run selected benchmark
// cases, and copy the new result JSON to benchmark/results. No previous result
// is overwritten. The phone must stay unlocked; the app keeps its screen on.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = 'com.skiawebgpuvideo.tests';
const remote = `/sdcard/Android/data/${pkg}/files/benchmark-results`;
const usage = `node scripts/test-android-device-run.mjs --serial SERIAL --apk app.apk --label NAME [--case ID ...] [--profile full|smoke|soak|interop] [--repetitions 3] [--timeout-minutes 30]`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const options = { cases: [], profile: 'full', repetitions: 3, timeoutMinutes: 30 };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--help' || flag === '-h') { console.log(usage); process.exit(0); }
  const value = process.argv[++i];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}\n${usage}`);
  if (flag === '--case') options.cases.push(value);
  else if (flag === '--serial') options.serial = value;
  else if (flag === '--apk') options.apk = path.resolve(value);
  else if (flag === '--label') options.label = value;
  else if (flag === '--profile') options.profile = value;
  else if (flag === '--repetitions') options.repetitions = Number(value);
  else if (flag === '--timeout-minutes') options.timeoutMinutes = Number(value);
  else throw new Error(`Unknown argument: ${flag}\n${usage}`);
}
if (!/^[\w.:-]+$/.test(options.serial ?? '') || !options.apk || !/^[a-z0-9-]+$/.test(options.label ?? '') ||
    !['full', 'smoke', 'soak', 'interop'].includes(options.profile) ||
    !Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 10 ||
    !(options.timeoutMinutes > 0) || options.cases.some((id) => !/^[a-zA-Z0-9_.-]+$/.test(id))) {
  throw new Error(`Invalid arguments\n${usage}`);
}
await access(options.apk);
const output = path.join(root, 'benchmark/results', `${options.label}.local.json`);
try { await access(output); throw new Error(`${output} already exists; choose a new label`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const adb = async (...args) =>
  (await exec('adb', ['-s', options.serial, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 })).stdout;
const results = async () => (await adb('shell', `ls ${remote} 2>/dev/null || true`))
  .split(/\s+/).filter((name) => /^candidate-[\w.-]+\.json$/.test(name) && !name.endsWith('-idle.json'));

if ((await adb('get-state')).trim() !== 'device') throw new Error('The selected Android device is not ready');
try {
  await adb('install', '-r', options.apk);
} catch (error) {
  // A build signed with another key: start from a clean install.
  if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(error.stderr ?? error.stdout ?? error.message))) throw error;
  console.log(`${options.label}: replacing an app signed with another key`);
  await adb('uninstall', pkg);
  await adb('install', options.apk);
}
const before = new Set(await results());
await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
const extras = ['--es', 'RNSKV_BENCHMARK_PROFILE', options.profile,
  '--ei', 'RNSKV_BENCHMARK_REPETITIONS', String(options.repetitions),
  '--es', 'RNSKV_BENCHMARK_RUN_ID', randomUUID()];
// The device shell re-parses this argument: quote the JSON list once.
if (options.cases.length) extras.push('--es', 'RNSKV_BENCHMARK_CASE_IDS', `'${JSON.stringify(options.cases)}'`);
// The harness reads its profile once, at a cold start: an intent delivered to
// an already open activity (e.g. reopened from the launcher) is ignored.
for (let attempt = 1; ; attempt++) {
  const launch = await adb('shell', 'am', 'start', '-S', '-W', '-n', `${pkg}/.MainActivity`, ...extras);
  if (/LaunchState: COLD/.test(launch) && /Status: ok/.test(launch)) break;
  if (attempt === 3) throw new Error(`The app did not cold start:\n${launch}`);
  await sleep(2000);
}
console.log(`${options.label}: ${options.cases.length || 'all'} cases × ${options.repetitions} started on ${options.serial}`);

const started = Date.now();
for (;;) {
  if (Date.now() - started > options.timeoutMinutes * 60000) throw new Error('Benchmark deadline exceeded');
  await sleep(15000);
  const created = (await results()).filter((name) => !before.has(name));
  if (!created.length) { console.log(`${options.label}: running ${Math.round((Date.now() - started) / 1000)}s`); continue; }
  await adb('pull', `${remote}/${created[0]}`, output);
  break;
}
const result = JSON.parse(await readFile(output, 'utf8'));
if (!result.cases) {
  // The interop profile writes its pixel diagnostics instead of cases.
  console.log(`${options.label}: ${result.kind} ${result.status}${result.failure ? ` · ${result.failure}` : ''} · ${output}`);
  if (result.exportPixels) console.log(`  export pixels ${result.exportPixels.status} · ${JSON.stringify(result.exportPixels.checks)}`);
  process.exit(0);
}
console.log(`${options.label}: ${result.backend?.skiaVersion} · ${result.environment?.deviceModel} · ${output}`);
for (const entry of result.cases) {
  const exported = entry.operations?.find((operation) => operation.operation === 'export');
  const profile = exported?.exportProfile;
  const stages = profile ? Object.entries(profile).filter(([key]) => key.endsWith('Ms') && key !== 'totalMs')
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, value]) => `${key.slice(0, -2)} ${(value / profile.frames).toFixed(2)}`).join(' ') : '';
  console.log(`  ${entry.id} rep${entry.repetition} ${entry.status}${exported ? ` export ${Math.round(exported.encodeMs)} ms` : ''}${stages ? ` · ms/frame: ${stages}` : ''}${entry.reason ? ` · ${entry.reason}` : ''}`);
}

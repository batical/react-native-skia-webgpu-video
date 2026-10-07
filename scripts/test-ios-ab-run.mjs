#!/usr/bin/env node
// Run one already-built Release app. Building and measuring stay separate so
// compiler load cannot contaminate the measurements.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundles = { baseline: 'com.seb.skiavideo.baseline.test', candidate: 'com.seb.skiawebgpuvideo.test' };
const options = { profile: 'full', repetitions: 3, cases: [], timeoutMinutes: 25, idleSeconds: 0 };
const flags = { '--simulator': 'simulator', '--backend': 'backend', '--label': 'label',
  '--profile': 'profile', '--repetitions': 'repetitions', '--timeout-minutes': 'timeoutMinutes', '--idle-seconds': 'idleSeconds' };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--help') {
    console.log('node scripts/test-ios-ab-run.mjs --simulator UDID --backend baseline|candidate --label NAME [--case ID ...] [--profile full|soak|smoke] [--repetitions 3] [--idle-seconds 180]');
    process.exit(0);
  }
  if (flag !== '--case' && !flags[flag]) throw new Error('Unknown argument: ' + flag);
  const value = process.argv[++index];
  if (!value || value.startsWith('--')) throw new Error('Missing value: ' + flag);
  if (flag === '--case') options.cases.push(value);
  else options[flags[flag]] = ['repetitions', 'timeoutMinutes', 'idleSeconds'].includes(flags[flag]) ? Number(value) : value;
}
if (process.platform !== 'darwin' || !/^[0-9a-f-]{36}$/i.test(options.simulator ?? '') ||
    !bundles[options.backend] || !/^[a-z0-9-]+$/.test(options.label ?? '') ||
    !['full', 'soak', 'smoke'].includes(options.profile) || !Number.isInteger(options.repetitions) ||
    options.repetitions < 1 || options.repetitions > 10 || !Number.isFinite(options.timeoutMinutes) ||
    options.timeoutMinutes <= 0 || options.timeoutMinutes > 120 || !Number.isInteger(options.idleSeconds) ||
    options.idleSeconds < 0 || options.idleSeconds > 600 || options.cases.some(id => !/^[a-zA-Z0-9_.-]+$/.test(id))) {
  throw new Error('Invalid arguments; use --help');
}
const directory = path.join(root, 'benchmark/results');
await mkdir(directory, { recursive: true });
const output = path.join(directory, options.label + '.local.json');
const evidencePath = path.join(directory, options.label + '-execution.local.json');
// Exclusive reservation avoids overwriting a previous experiment.
await writeFile(evidencePath, JSON.stringify({ status: 'preparing', options }), { flag: 'wx' });
const evidence = { schema: 1, options, invokedAt: new Date().toISOString(), bundleId: bundles[options.backend],
  status: 'preparing', idleObservations: [] };
const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
const simctl = async (args, env = process.env) => (await exec('xcrun', ['simctl', ...args], { env, maxBuffer: 1024 * 1024 })).stdout.trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let pid;
try {
  const devices = JSON.parse(await simctl(['list', 'devices', 'booted', '--json']));
  const device = Object.values(devices.devices).flat().find(item => item.udid === options.simulator && item.state === 'Booted');
  if (!device) throw new Error('Requested simulator is not booted');
  evidence.simulator = device;
  evidence.terminatedApps = [];
  for (const bundle of Object.values(bundles)) {
    try { await simctl(['terminate', options.simulator, bundle]); evidence.terminatedApps.push(bundle); }
    catch (error) {
      if (!/not running|found nothing to terminate|No such process/i.test(error.stderr ?? error.message)) throw error;
    }
  }
  const app = await simctl(['get_app_container', options.simulator, evidence.bundleId, 'app']);
  const data = await simctl(['get_app_container', options.simulator, evidence.bundleId, 'data']);
  evidence.appPath = app;
  evidence.dataPath = data;
  const plist = JSON.parse((await exec('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')])).stdout);
  evidence.executableSha256 = sha256(await readFile(path.join(app, plist.CFBundleExecutable)));
  evidence.bundleSha256 = sha256(await readFile(path.join(app, 'main.jsbundle')));
  const fixtureNames = await readdir(path.join(app, 'fixtures'));
  evidence.fixtures = [];
  for (const name of fixtureNames.sort()) {
    const bytes = await readFile(path.join(app, 'fixtures', name));
    evidence.fixtures.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const resultsDirectory = path.join(data, 'Documents/benchmark-results');
  const before = new Set(await readdir(resultsDirectory).catch(error => { if (error.code === 'ENOENT') return []; throw error; }));
  evidence.launchedAt = new Date().toISOString();
  const launched = await simctl(['launch', '--terminate-running-process', options.simulator, evidence.bundleId], {
    ...process.env,
    SIMCTL_CHILD_RNSKV_BENCHMARK_PROFILE: options.profile,
    SIMCTL_CHILD_RNSKV_BENCHMARK_REPETITIONS: String(options.repetitions),
    SIMCTL_CHILD_RNSKV_BENCHMARK_CASE_IDS: JSON.stringify(options.cases),
  });
  pid = Number(launched.match(/: (\d+)$/)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Cannot identify app process: ' + launched);
  evidence.pid = pid;
  evidence.status = 'running';
  await save();
  console.log(`${options.label}: ${evidence.bundleId} pid ${pid}; ${options.profile}, ${options.repetitions} repetitions`);
  const started = Date.now();
  let heartbeat = started;
  for (;;) {
    if (Date.now() - started > options.timeoutMinutes * 60000) throw new Error('Benchmark exceeded timeout; no result accepted');
    const names = await readdir(resultsDirectory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const newFiles = names.filter(name => !before.has(name) && name.startsWith(options.backend + '-') && name.endsWith('.json'));
    if (newFiles.length > 1) throw new Error('More than one new result; attribution is ambiguous');
    if (newFiles.length === 1) {
      const bytes = await readFile(path.join(resultsDirectory, newFiles[0]));
      const result = JSON.parse(bytes);
      const runStart = Date.parse(result.startedAt);
      const runEnd = Date.parse(result.finishedAt);
      if (!Number.isFinite(runStart) || !Number.isFinite(runEnd) || runEnd < runStart ||
          runStart < Date.parse(evidence.launchedAt) - 1000 || runEnd > Date.now() + 1000 ||
          result.profile !== options.profile || result.repetitions !== options.repetitions ||
          result.environment?.deviceId !== options.simulator || result.environment?.buildMode !== 'release' ||
          result.environment?.executionTarget !== 'simulator' || result.backend?.name !==
            (options.backend === 'baseline' ? '@azzapp/react-native-skia-video' : 'react-native-skia-webgpu-video') ||
          options.cases.length && (result.caseCatalog.length !== options.cases.length ||
            result.caseCatalog.some(item => !options.cases.includes(item.id)))) {
        throw new Error('Result does not match the requested experiment');
      }
      await writeFile(output, bytes, { flag: 'wx' });
      evidence.result = { path: output, sha256: sha256(bytes), startedAt: result.startedAt, finishedAt: result.finishedAt,
        statuses: result.cases.reduce((counts, entry) => ({ ...counts, [entry.status]: (counts[entry.status] ?? 0) + 1 }), {}) };
      console.log(JSON.stringify(evidence.result));
      break;
    }
    try { process.kill(pid, 0); } catch { throw new Error('App exited before producing a result'); }
    if (Date.now() - heartbeat >= 30000) { console.log(`${options.label}: running ${Math.round((Date.now() - started) / 1000)}s`); heartbeat = Date.now(); }
    await sleep(2000);
  }
  const idleStart = Date.now();
  while (options.idleSeconds && Date.now() - idleStart <= options.idleSeconds * 1000 + 500) {
    const sampledAt = new Date().toISOString();
    const measurement = (await exec('ps', ['-p', String(pid), '-o', 'pid=,rss=,etime='])).stdout.trim().split(/\s+/);
    if (Number(measurement[0]) !== pid || !Number.isFinite(Number(measurement[1]))) throw new Error('Idle process no longer available');
    const sample = { sampledAt, idleSeconds: (Date.now() - idleStart) / 1000, pid, rssBytes: Number(measurement[1]) * 1024,
      processElapsed: measurement[2], source: 'macOS ps RSS for simulator app PID; not physical footprint or GPU allocation' };
    evidence.idleObservations.push(sample);
    console.log(`idle ${Math.round(sample.idleSeconds)}s: ${(sample.rssBytes / 1048576).toFixed(2)} MiB`);
    await save();
    const remaining = options.idleSeconds * 1000 - (Date.now() - idleStart);
    if (remaining <= 0) break;
    await sleep(Math.min(30000, remaining));
  }
  evidence.status = 'completed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error.message;
  if (pid) {
    try {
      await simctl(['terminate', options.simulator, evidence.bundleId]);
      evidence.stoppedAfterFailure = true;
    } catch (stopError) {
      evidence.stopAfterFailure = String(stopError.stderr ?? stopError.message).trim();
    }
  }
  process.exitCode = 1;
  console.error(error.message);
} finally {
  evidence.completedAt = new Date().toISOString();
  await save();
}

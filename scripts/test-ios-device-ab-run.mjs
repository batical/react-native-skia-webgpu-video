#!/usr/bin/env node
// Run one physical-iPhone comparison from an already-built, signed Release app.
// Installation and hashing finish before timing. Only the two benchmark apps
// may be terminated; remote PIDs are never interpreted as host process IDs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKLOAD_VERSION, buildCases } from '../benchmark/cases.mjs';
import { validateResult } from '../benchmark/compare.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OWNED_APPS = {
  baseline: { bundle: 'com.seb.skiavideo.baseline.test', executable: 'ReactNativeSkiaVideoBaseline', package: '@azzapp/react-native-skia-video' },
  candidate: { bundle: 'com.seb.skiawebgpuvideo.test', executable: 'ReactNativeSkiaWebGPUVideoExample', package: 'react-native-skia-webgpu-video' },
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = `node scripts/test-ios-device-ab-run.mjs --device UDID --backend baseline|candidate --label NAME --app /path/Release-iphoneos/Example.app [--case ID ...] [--profile full|soak|smoke] [--repetitions 3] [--idle-seconds 180] [--poll-seconds 30] [--unlock-wait-seconds 120]
Installs the supplied signed app, launches a fresh process, and copies original result JSON.
Idle RSS/footprint must come from the app's native collector, never host ps.
Outputs use exclusive names under benchmark/results; no previous run is overwritten.`;
export function parseOptions(argv) {
  const options = { profile: 'full', repetitions: 3, cases: [], timeoutMinutes: 25, idleSeconds: 0, pollSeconds: 30, unlockWaitSeconds: 120 };
  const flags = { '--device': 'device', '--backend': 'backend', '--label': 'label', '--app': 'app',
    '--profile': 'profile', '--repetitions': 'repetitions', '--timeout-minutes': 'timeoutMinutes',
    '--idle-seconds': 'idleSeconds', '--poll-seconds': 'pollSeconds', '--unlock-wait-seconds': 'unlockWaitSeconds' };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    assert(flag === '--case' || flags[flag], `Unknown argument: ${flag}`);
    const value = argv[++index]; assert(value && !value.startsWith('--'), `Missing value: ${flag}`);
    if (flag === '--case') options.cases.push(value);
    else options[flags[flag]] = ['repetitions', 'timeoutMinutes', 'idleSeconds', 'pollSeconds', 'unlockWaitSeconds'].includes(flags[flag]) ? Number(value) : value;
  }
  assert(/^[a-zA-Z0-9-]{20,50}$/.test(options.device ?? '') && OWNED_APPS[options.backend] &&
    /^[a-z0-9-]+$/.test(options.label ?? '') && options.app &&
    ['full', 'soak', 'smoke'].includes(options.profile) && Number.isInteger(options.repetitions) && options.repetitions >= 1 && options.repetitions <= 10 &&
    Number.isFinite(options.timeoutMinutes) && options.timeoutMinutes > 0 && options.timeoutMinutes <= 120 &&
    Number.isInteger(options.idleSeconds) && options.idleSeconds >= 0 && options.idleSeconds <= 600 && options.idleSeconds % 30 === 0 &&
    Number.isInteger(options.pollSeconds) && options.pollSeconds >= 15 && options.pollSeconds <= 60 &&
    Number.isInteger(options.unlockWaitSeconds) && options.unlockWaitSeconds >= 0 && options.unlockWaitSeconds <= 600 &&
    options.cases.every((id) => /^[a-zA-Z0-9_.-]+$/.test(id)) && new Set(options.cases).size === options.cases.length,
    'Invalid arguments; use --help');
  const catalog = buildCases({ profile: options.profile });
  assert(options.cases.every((id) => catalog.some((scenario) => scenario.id === id)), 'Unknown case ID for the selected workload/profile');
  options.app = path.resolve(options.app);
  assert(path.basename(path.dirname(options.app)) === 'Release-iphoneos' && options.app.endsWith('.app'), 'Provide the actual Release-iphoneos build product');
  return options;
}

/** Retry only an explicit lock rejection. No app process has started in this
 * case, so waiting does not warm up the measured workload or reuse a run. */
export async function launchWhenUnlocked(launch, { waitMs = 120000, now = Date.now,
  pause = sleep, onLocked = async () => {} } = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    try { return await launch(); }
    catch (error) {
      if (!/BSErrorCodeDescription\s*=\s*Locked\b/.test(String(error.stderr ?? error.message)) || now() >= deadline) throw error;
      await onLocked();
      await pause(Math.min(1500, Math.max(0, deadline - now())));
      if (now() >= deadline) throw error;
    }
  }
}

function devicePath(url) {
  try { const parsed = new URL(url); if (parsed.protocol !== 'file:' || parsed.host) return null;
    return decodeURIComponent(parsed.pathname).replace(/^\/var\//, '/private/var/').replace(/\/$/, '');
  } catch { return null; }
}
/** Match the exact installed owned bundle executable, never a name substring or a stale PID. */
export function ownedProcesses(apps, processes) {
  return processes.filter((process) => Number.isSafeInteger(process.processIdentifier) && process.processIdentifier > 0 &&
    apps.some((app) => {
      const owned = Object.values(OWNED_APPS).find((entry) => entry.bundle === app.bundleIdentifier);
      const directory = devicePath(app.url);
      return owned && directory?.endsWith(`/${owned.executable}.app`) &&
        devicePath(process.executable) === `${directory}/${owned.executable}`;
    }));
}
export function resultFiles(files, backend) {
  return files.filter((file) => file.resources?.isDirectory === false && file.resources?.isSymbolicLink !== true &&
    file.resources?.isReadable === true && typeof file.relativePath === 'string' &&
    /^benchmark-results\/[a-zA-Z0-9.-]+\.json$/.test(file.relativePath) &&
    path.posix.basename(file.relativePath).startsWith(`${backend}-`) && !file.relativePath.endsWith('-idle.json'));
}
export function validateDeviceResult(result, { options, runId, pid, deviceModel, osVersion }) {
  validateResult(result);
  assert(result.workloadVersion === WORKLOAD_VERSION && result.profile === options.profile && result.repetitions === options.repetitions &&
    result.environment?.deviceId === options.device && result.environment.executionTarget === 'device' &&
    result.environment.platform === 'ios' && result.environment.buildMode === 'release' && result.environment.measurementClock === 'performance.now' &&
    result.environment.benchmarkRunId === runId && result.environment.processIdentifier === pid &&
    result.environment.deviceModel === deviceModel && result.environment.osVersion === osVersion &&
    result.backend?.name === OWNED_APPS[options.backend].package, 'Result identity does not match the physical experiment');
  assert(Number.isFinite(Date.parse(result.startedAt)) && Date.parse(result.finishedAt) > Date.parse(result.startedAt), 'Invalid device run timestamps');
  const expected = buildCases({ profile: options.profile, seed: result.seed }).filter((scenario) => !options.cases.length || options.cases.includes(scenario.id));
  assert(JSON.stringify(expected) === JSON.stringify(result.caseCatalog), 'Result catalog differs from the exact requested workload');
  assert(result.cases.filter((entry) => entry.status !== 'skipped').every((entry) => entry.collection.periodMs === 100), 'Comparison requires the shared 100 ms collector');
}
export function validateIdleResult(result, { filename, pid, seconds, runId }) {
  assert(typeof runId === 'string' && runId.length > 0 && result.benchmarkRunId === runId &&
    result.schema === 1 && result.benchmarkFilename === filename && result.processIdentifier === pid &&
    result.requestedSeconds === seconds && result.intervalSeconds === 30 &&
    Number.isFinite(Date.parse(result.startedAt)) && Date.parse(result.finishedAt) >= Date.parse(result.startedAt) &&
    Array.isArray(result.samples) && result.samples.length === seconds / 30 + 1, 'Idle result identity or sampling count does not match this run');
  let previous = -1;
  for (const [index, sample] of result.samples.entries()) {
    const rss = sample.memory?.rssBytes;
    assert(Number.isFinite(sample.elapsedSeconds) && sample.elapsedSeconds >= index * 30 - 1 && sample.elapsedSeconds > previous &&
      Number.isFinite(rss?.value) && rss.value > 0 && rss.source === 'iOS mach task_info resident_size' &&
      typeof sample.operatingConditions?.source === 'string' && sample.operatingConditions.source &&
      ['nominal', 'fair', 'serious', 'critical'].includes(sample.operatingConditions.thermalState) &&
      ['normal', 'low-power'].includes(sample.operatingConditions.powerMode), 'Idle reading is missing native RSS, timing, or operating conditions');
    previous = sample.elapsedSeconds;
  }
  assert(result.samples[0].elapsedSeconds < 2 && previous >= seconds - 1, 'Idle timeline does not span the requested duration');
  const footprintSource = 'iOS task_vm_info phys_footprint';
  const unavailable = result.samples.flatMap((sample, index) => {
    const reading = sample.memory?.physicalFootprintBytes;
    if (Number.isFinite(reading?.value) && reading.value > 0 && reading.source === footprintSource) return [];
    return [{ sampleIndex: index, reason: typeof reading?.reason === 'string' && reading.reason
      ? reading.reason : reading?.source && reading.source !== footprintSource
        ? 'Physical footprint collector source differs from the native iPhone contract'
        : 'Native iPhone physical footprint reading is unavailable' }];
  });
  const measured = result.samples.length - unavailable.length;
  // Preserve valid RSS and the original nullable footprint readings. Missing
  // footprint is incomplete metric coverage, not permission to invent zero or
  // discard an otherwise attributable native idle experiment.
  return { status: unavailable.length ? 'incomplete' : 'complete',
    rssBytes: { status: 'measured', samples: result.samples.length, source: 'iOS mach task_info resident_size' },
    physicalFootprintBytes: { status: measured === result.samples.length ? 'measured' : measured ? 'partial' : 'unavailable',
      samples: measured, expectedSamples: result.samples.length,
      source: measured ? footprintSource : null, unavailable } };
}

export async function main(argv) {
  const options = parseOptions(argv); if (options.help) { console.log(usage); return; }
  assert(process.platform === 'darwin', 'Physical device tests require macOS and Xcode');
  const owned = OWNED_APPS[options.backend];
  const directory = path.join(root, 'benchmark/results'); await mkdir(directory, { recursive: true });
  const evidencePath = path.join(directory, `${options.label}-execution.local.json`);
  const output = path.join(directory, `${options.label}.local.json`);
  const idleOutput = path.join(directory, `${options.label}-idle.local.json`);
  await writeFile(evidencePath, JSON.stringify({ status: 'preparing', options }) + '\n', { flag: 'wx' });
  const commandDirectory = await mkdtemp(path.join(os.tmpdir(), `${options.label}-device-`));
  const evidence = { schema: 1, executionTarget: 'device', options, bundleId: owned.bundle,
    invokedAt: new Date().toISOString(), runId: randomUUID(), commandDirectory, status: 'preparing', commands: [], readFailures: [] };
  const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  let commandNumber = 0; let pid; let installed;
  const deviceCommand = async (args) => {
    const jsonPath = path.join(commandDirectory, `${String(++commandNumber).padStart(3, '0')}-${args.slice(0, 3).join('-')}.json`);
    await writeFile(jsonPath, '', { flag: 'wx' });
    const command = { args, startedAt: new Date().toISOString(), jsonPath };
    evidence.commands.push(command);
    try {
      await exec('xcrun', ['devicectl', ...args.slice(0, 3), '--device', options.device, '--timeout', '30', '--json-output', jsonPath, ...args.slice(3)],
        { maxBuffer: 2 * 1024 * 1024, timeout: 45000 });
      const result = JSON.parse(await readFile(jsonPath, 'utf8'));
      assert(result.info?.outcome === 'success', `Device command failed: ${args.join(' ')}`);
      command.finishedAt = new Date().toISOString(); command.status = 'success';
      return result.result;
    } catch (error) {
      command.finishedAt = new Date().toISOString(); command.status = 'failed';
      command.error = String(error.stderr ?? error.message).slice(-4000);
      throw error;
    }
  };
  const appInfo = async (bundle) => (await deviceCommand(['device', 'info', 'apps', '--bundle-id', bundle, '--include-container-paths'])).apps;
  const processes = async () => (await deviceCommand(['device', 'info', 'processes', '--search', 'ReactNativeSkia'])).runningProcesses;
  const listFiles = async () => (await deviceCommand(['device', 'info', 'files', '--domain-type', 'appDataContainer',
    '--domain-identifier', owned.bundle, '--subdirectory', 'Documents', '--recurse'])).files;
  const copyFile = async (relativePath, localName) => {
    assert(/^benchmark-results\/[a-zA-Z0-9.-]+\.json$/.test(relativePath), 'Unsafe result path');
    const destination = path.join(commandDirectory, `${randomUUID()}-${localName}`);
    await deviceCommand(['device', 'copy', 'from', '--domain-type', 'appDataContainer', '--domain-identifier', owned.bundle,
      '--source', `Documents/${relativePath}`, '--destination', destination]);
    return readFile(destination);
  };
  const recordReadFailure = async (error) => {
    evidence.readFailures.push({ at: new Date().toISOString(), message: String(error.stderr ?? error.message).slice(-2000) });
    console.log(`${options.label}: device read interrupted; preserving the run and retrying in ${options.pollSeconds}s`);
    await save();
  };
  try {
    const info = JSON.parse((await exec('plutil', ['-convert', 'json', '-o', '-', path.join(options.app, 'Info.plist')])).stdout);
    assert(info.CFBundleIdentifier === owned.bundle && info.CFBundleExecutable === owned.executable &&
      info.DTPlatformName === 'iphoneos' && info.CFBundleSupportedPlatforms?.includes('iPhoneOS'), 'App is not the expected physical iOS build');
    const executable = await readFile(path.join(options.app, owned.executable));
    const bundle = await readFile(path.join(options.app, 'main.jsbundle'));
    assert(executable.length && bundle.length, 'Native executable and offline JavaScript bundle are required');
    evidence.localApp = { path: options.app, executableSha256: sha256(executable), bundleSha256: sha256(bundle),
      bundleVersion: info.CFBundleVersion, version: info.CFBundleShortVersionString, fixtures: [] };
    const fixtureDirectory = path.join(options.app, 'fixtures');
    for (const name of (await readdir(fixtureDirectory)).sort()) {
      assert(/^[a-zA-Z0-9_.-]+$/.test(name), 'Unexpected bundled fixture path');
      const bytes = await readFile(path.join(fixtureDirectory, name));
      evidence.localApp.fixtures.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const manifest = JSON.parse(await readFile(path.join(fixtureDirectory, 'manifest.json'), 'utf8'));
    assert(manifest.files?.length > 0 && manifest.files.every((fixture) => evidence.localApp.fixtures.some((file) =>
      file.name === fixture.file && file.sha256 === fixture.sha256 && file.bytes === fixture.bytes)), 'Bundled fixtures do not match their manifest');
    const details = await deviceCommand(['device', 'info', 'details']);
    const hardware = details.properties?.hardware ?? details.hardwareProperties;
    const software = details.properties?.software ?? details.deviceProperties;
    const connection = details.properties?.connection ?? details.connectionProperties;
    assert(hardware?.udid === options.device && hardware.reality === 'physical' && hardware.platform === 'iOS' &&
      (connection?.state ?? connection?.tunnelState) === 'connected', 'Requested physical iPhone is not connected');
    const osVersion = software.osVersionNumber?.stringValue ?? software.osVersionNumber;
    assert(typeof hardware.productType === 'string' && typeof osVersion === 'string', 'Missing actual device model or OS');
    evidence.device = { identifier: details.identifier, udid: hardware.udid, model: hardware.productType, osVersion,
      transportType: connection.transportType, developerMode: details.deviceProperties?.developerModeStatus ?? details.properties?.state?.developerModeStatus };
    const previousApps = [];
    for (const app of Object.values(OWNED_APPS)) previousApps.push(...await appInfo(app.bundle));
    evidence.terminatedProcesses = [];
    for (const process of ownedProcesses(previousApps, await processes())) {
      await deviceCommand(['device', 'process', 'terminate', '--pid', String(process.processIdentifier)]);
      evidence.terminatedProcesses.push(process);
    }
    evidence.installation = await deviceCommand(['device', 'install', 'app', options.app]);
    // Attribute the installed app to the exact bytes supplied during installation.
    assert(sha256(await readFile(path.join(options.app, owned.executable))) === evidence.localApp.executableSha256 &&
      sha256(await readFile(path.join(options.app, 'main.jsbundle'))) === evidence.localApp.bundleSha256,
      'Build product changed during installation');
    installed = (await appInfo(owned.bundle)).find((app) => app.bundleIdentifier === owned.bundle);
    assert(installed?.containerAccessible && installed.builtByDeveloper &&
      installed.bundleVersion === String(info.CFBundleVersion) && installed.version === info.CFBundleShortVersionString,
      'Installed developer app identity does not match the supplied build');
    evidence.installedApp = installed;
    const before = new Set(resultFiles(await listFiles(), options.backend).map((file) => file.relativePath));
    const launch = await launchWhenUnlocked(() => {
      evidence.launchedAtHost = new Date().toISOString();
      return deviceCommand(['device', 'process', 'launch', '--terminate-existing', '--activate',
      '--environment-variables', JSON.stringify({ RNSKV_BENCHMARK_PROFILE: options.profile,
        RNSKV_BENCHMARK_REPETITIONS: String(options.repetitions), RNSKV_BENCHMARK_CASE_IDS: JSON.stringify(options.cases),
        RNSKV_BENCHMARK_RUN_ID: evidence.runId, RNSKV_BENCHMARK_IDLE_SECONDS: String(options.idleSeconds) }), owned.bundle]);
    }, { waitMs: options.unlockWaitSeconds * 1000, onLocked: async () => {
      evidence.status = 'waiting-for-device-unlock';
      await save();
      console.log(`${options.label}: iPhone locked; waiting for manual unlock before measurement`);
    } });
    evidence.launch = launch;
    const live = ownedProcesses([installed], await processes());
    assert(live.length === 1, 'The launched benchmark has no unique live owned process');
    pid = live[0].processIdentifier; evidence.pid = pid; evidence.status = 'running'; await save();
    console.log(`${options.label}: physical ${options.device}, ${owned.bundle} pid ${pid}; ${options.cases.length || 'all'} cases × ${options.repetitions}`);
    const started = Date.now(); let filename;
    for (;;) {
      assert(Date.now() - started <= options.timeoutMinutes * 60000, 'Benchmark deadline exceeded; preserving evidence without accepting an incomplete result');
      let files;
      try { files = resultFiles(await listFiles(), options.backend); }
      catch (error) { await recordReadFailure(error); await sleep(options.pollSeconds * 1000); continue; }
      const created = files.filter((file) => !before.has(file.relativePath));
      assert(created.length <= 1, 'Multiple new main result files make attribution ambiguous');
      if (created.length) {
        filename = path.posix.basename(created[0].relativePath);
        let bytes;
        try { bytes = await copyFile(created[0].relativePath, 'main-result.json'); }
        catch (error) { await recordReadFailure(error); await sleep(options.pollSeconds * 1000); continue; }
        const result = JSON.parse(bytes);
        validateDeviceResult(result, { options, runId: evidence.runId, pid, deviceModel: hardware.productType, osVersion });
        await writeFile(output, bytes, { flag: 'wx' });
        evidence.result = { path: output, deviceFilename: filename, sha256: sha256(bytes), startedAt: result.startedAt, finishedAt: result.finishedAt,
          statuses: result.cases.reduce((counts, entry) => ({ ...counts, [entry.status]: (counts[entry.status] ?? 0) + 1 }), {}) };
        await save(); console.log(JSON.stringify(evidence.result)); break;
      }
      let live;
      try { live = ownedProcesses([installed], await processes()); }
      catch (error) { await recordReadFailure(error); await sleep(options.pollSeconds * 1000); continue; }
      assert(live.some((process) => process.processIdentifier === pid), 'Owned app exited before producing its result');
      console.log(`${options.label}: running ${Math.round((Date.now() - started) / 1000)}s`);
      await sleep(options.pollSeconds * 1000);
    }
    if (options.idleSeconds) {
      const idleName = filename.replace(/\.json$/, '-idle.json');
      const idleDeadline = Date.now() + (options.idleSeconds + 120) * 1000;
      evidence.status = 'collecting-native-idle'; await save();
      for (;;) {
        assert(Date.now() <= idleDeadline, 'Native idle collector did not finish before its deadline');
        let files;
        try { files = await listFiles(); }
        catch (error) { await recordReadFailure(error); await sleep(options.pollSeconds * 1000); continue; }
        const target = files.find((file) => file.relativePath === `benchmark-results/${idleName}` && file.resources?.isReadable && !file.resources.isDirectory && !file.resources.isSymbolicLink);
        if (target) {
          let bytes;
          try { bytes = await copyFile(target.relativePath, 'idle-result.json'); }
          catch (error) { await recordReadFailure(error); await sleep(options.pollSeconds * 1000); continue; }
          const result = JSON.parse(bytes);
          const qualification = validateIdleResult(result, { filename, pid, seconds: options.idleSeconds, runId: evidence.runId });
          await writeFile(idleOutput, bytes, { flag: 'wx' });
          evidence.idleResult = { path: idleOutput, sha256: sha256(bytes), samples: result.samples.length, qualification,
            source: 'Native iPhone mach task_info collector in the same benchmark process' };
          console.log(JSON.stringify(evidence.idleResult)); break;
        }
        let live;
        try { live = ownedProcesses([installed], await processes()); }
        catch (error) { await recordReadFailure(error); await sleep(options.pollSeconds * 1000); continue; }
        assert(live.some((process) => process.processIdentifier === pid), 'Owned app exited before the idle collector completed');
        console.log(`${options.label}: waiting for native ${options.idleSeconds}s idle measurement`);
        await sleep(options.pollSeconds * 1000);
      }
    }
    evidence.status = 'completed';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error.stderr ?? error.message).slice(-4000);
    // Recheck exact executable and current PID before attempting cleanup. If
    // disconnected, preserve evidence; do not guess which process to terminate.
    if (pid && installed) try {
      const current = ownedProcesses([installed], await processes()).find((process) => process.processIdentifier === pid);
      if (current) { await deviceCommand(['device', 'process', 'terminate', '--pid', String(pid)]); evidence.stoppedAfterFailure = true; }
    } catch (stopError) { evidence.stopAfterFailure = String(stopError.stderr ?? stopError.message).slice(-2000); }
    process.exitCode = 1; console.error(evidence.error);
  } finally { evidence.completedAt = new Date().toISOString(); await save(); }
  return evidence;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

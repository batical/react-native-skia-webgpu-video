import { buildCases, DEFAULT_SEED, materializeComposition, WORKLOAD_VERSION, expectedFrameCount } from './cases.mjs';
import { validateFixtureManifest } from './fixtures.mjs';
import { normalizeMemory, summarizeDurations } from './metrics.mjs';
import { summarizeSeekValidation } from './playing-seek.mjs';

export const RESULT_SCHEMA = 1;
const requiredEnvironment = ['deviceId', 'deviceModel', 'platform', 'osVersion', 'reactNativeVersion', 'buildMode', 'displayRefreshRate'];
const errorText = (error) => String(error?.message ?? error);

const diagnosticField = (error, key) => {
  try { return error?.[key]; } catch { return undefined; }
};
const diagnosticText = (value, maxLength) => {
  if (value == null) return null;
  try { return String(value).slice(0, maxLength); } catch { return 'Unprintable failure'; }
};

/** JSON-only diagnostics: never retain an Error, native object or unlimited
 * cause chain in device telemetry. Stack capture happens outside draw timing. */
export function failureDiagnostic(error, context = {}, depth = 0) {
  const stage = diagnosticField(error, 'benchmarkStage') ?? context.stage;
  const diagnostic = {
    name: diagnosticText(diagnosticField(error, 'name'), 80),
    message: diagnosticText(diagnosticField(error, 'message') ?? error, 1024),
    stack: diagnosticText(diagnosticField(error, 'stack'), 4096),
    stage: diagnosticText(stage, 128),
    runnerStage: diagnosticText(context.stage, 128),
    operation: diagnosticText(context.operation, 128),
  };
  const preview = diagnosticField(error, 'benchmarkPreview');
  if (preview && stage !== 'preview:seek-settle') diagnostic.preview = {
    ready: preview.ready === true, attached: preview.attached === true,
    hasPlayer: preview.hasPlayer === true, hasCounters: preview.hasCounters === true,
    errorCount: Number.isFinite(preview.errorCount) ? preview.errorCount : null,
  };
  if (preview && stage === 'preview:seek-settle') {
    const finite = (key) => {
      const value = diagnosticField(preview, key);
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    const ids = (key) => {
      const value = diagnosticField(preview, key);
      return Array.isArray(value) ? value.slice(0, 16)
        .filter((id) => typeof id === 'string').map((id) => id.slice(0, 96)) : [];
    };
    const identities = (key) => {
      const value = diagnosticField(preview, key);
      return Array.isArray(value) ? value.slice(0, 16).map((entry) => {
        const itemId = diagnosticField(entry, 'itemId');
        const frameId = diagnosticField(entry, 'frameId');
        const producerId = diagnosticField(entry, 'producerId');
        return { itemId: typeof itemId === 'string' ? itemId.slice(0, 96) : null,
          frameId: Number.isSafeInteger(frameId) ? frameId : null,
          producerId: Number.isSafeInteger(producerId) ? producerId : null };
      }) : [];
    };
    const sequence = finite('renderSequence');
    const beforeSequence = finite('beforeRenderSequence');
    diagnostic.preview = {
      requestedTime: finite('requestedTime'), elapsedMs: finite('elapsedMs'),
      playerTime: finite('playerTime'), drawnTime: finite('drawnTime'),
      isPlaying: typeof diagnosticField(preview, 'isPlaying') === 'boolean' ? diagnosticField(preview, 'isPlaying') : null,
      preservePlaying: diagnosticField(preview, 'preservePlaying') === true,
      expectedFrameIds: ids('expectedFrameIds'), drawnFrameIds: ids('drawnFrameIds'),
      frameMapIds: ids('frameMapIds'), frameIdentities: identities('frameIdentities'),
      beforeFrameIdentities: identities('beforeFrameIdentities'),
      beforeRenderSequence: beforeSequence, renderSequence: sequence,
      renderedSinceSeek: sequence !== null && beforeSequence !== null ? sequence > beforeSequence : null,
      lastDrawAtMs: finite('lastDrawAtMs'), nativeFramePTS: null,
      nativeFramePTSReason: diagnosticText(diagnosticField(preview, 'nativeFramePTSReason'), 160),
    };
  }
  const cause = diagnosticField(error, 'cause');
  if (depth < 1 && cause != null && cause !== error)
    diagnostic.cause = failureDiagnostic(cause, {}, depth + 1);
  return diagnostic;
}

export function annotateFailureStage(error, stage, preview) {
  try {
    if (error && typeof error === 'object') {
      error.benchmarkStage = stage;
      if (preview) error.benchmarkPreview = preview;
      return error;
    }
  } catch { /* Frozen or non-object failures need a diagnostic wrapper. */ }
  const wrapped = new Error(errorText(error));
  wrapped.name = diagnosticField(error, 'name') ?? wrapped.name;
  wrapped.cause = error;
  wrapped.unsafeToContinue = diagnosticField(error, 'unsafeToContinue') === true;
  wrapped.benchmarkStage = stage;
  if (preview) wrapped.benchmarkPreview = preview;
  return wrapped;
}

function assertEnvironment(environment) {
  for (const field of requiredEnvironment) if (environment?.[field] == null) throw new Error(`Missing environment.${field}`);
  if (environment.buildMode !== 'release') throw new Error('Performance comparisons require a release build');
}

/** Adapter owns native/GPU resources. This runner retains summaries, never frames. */
export async function runBenchmarks(adapter, options) {
  assertEnvironment(options.environment);
  if (typeof adapter.now !== 'function' || typeof adapter.sleep !== 'function') throw new Error('Adapter needs monotonic now() and sleep(ms)');
  const seed = options.seed ?? DEFAULT_SEED;
  const profile = options.profile ?? 'full';
  const catalog = buildCases({ seed, profile }).filter((scenario) => !options.caseIds || options.caseIds.includes(scenario.id));
  if (!catalog.length) throw new Error('No workloads match the requested case IDs');
  const repetitions = options.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('Repetitions must be a positive integer');
  const maxBytes = options.memoryBudgetBytes ?? null;
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) throw new Error('memoryBudgetBytes must be a positive safe integer');
  const memoryBudget = maxBytes === null
    ? { requestedMaxBytes: null, applied: false, reason: 'No explicit memory budget requested' }
    : typeof adapter.configureMemoryBudget === 'function'
      ? await adapter.configureMemoryBudget(maxBytes)
      : { requestedMaxBytes: maxBytes, applied: false, reportedMaxBytes: null, reason: 'Memory budget adapter is unavailable' };
  const result = { schema: RESULT_SCHEMA, workloadVersion: WORKLOAD_VERSION, seed, profile, repetitions, memoryBudget, fixtureManifest: options.fixtureManifest, environment: options.environment, backend: options.backend, caseCatalog: catalog, startedAt: options.startedAt ?? new Date().toISOString(), cases: [] };
  let terminalFailure = false;
  for (const scenario of catalog) {
    const required = scenario.composition.items.map((item) => item.fixture);
    try { validateFixtureManifest(options.fixtureManifest, required); }
    catch (error) {
      if (error.code !== 'MISSING_FIXTURE') throw error;
      result.cases.push({ id: scenario.id, repetition: null, status: 'skipped', reason: errorText(error) });
      continue;
    }
    if (scenario.extension && !adapter.extensions?.includes(scenario.extension)) {
      result.cases.push({ id: scenario.id, repetition: null, status: 'skipped', reason: `Renderer extension ${scenario.extension} is not installed` });
      continue;
    }
    const missingPreviewCapability = scenario.previewCapabilities?.find((name) => typeof adapter[name] !== 'function');
    if (missingPreviewCapability) {
      result.cases.push({ id: scenario.id, repetition: null, status: 'skipped', reason: `Preview capability ${missingPreviewCapability} is not attached` });
      continue;
    }
    if (terminalFailure) {
      result.cases.push({ id: scenario.id, repetition: null, status: 'skipped', reason: 'A previous operation did not terminate; restart the process before continuing' });
      continue;
    }
    for (let repetition = 0; repetition < repetitions; repetition++) {
      options.onEvent?.({ type: 'case-begin', id: scenario.id, repetition });
      const entry = await runCase(adapter, scenario, { ...options, repetition });
      result.cases.push(entry);
      options.onEvent?.({ type: 'case-end', result: entry });
      if (entry.unsafeToContinue) { terminalFailure = true; break; }
    }
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

export async function runCase(adapter, scenario, options) {
  const started = adapter.now();
  const memorySamplePeriodMs = options.memorySamplePeriodMs ?? 1000;
  const maxMemorySamples = options.maxMemorySamples ?? 2048;
  if (!Number.isFinite(memorySamplePeriodMs) || memorySamplePeriodMs <= 0 ||
      !Number.isSafeInteger(maxMemorySamples) || maxMemorySamples < 4)
    throw new Error('Memory sample period and sample limit must be positive');
  const entry = { id: scenario.id, repetition: options.repetition ?? 0, status: 'passed', startedAt: new Date().toISOString(), operations: [], memorySamples: [], validations: [], actualPaths: adapter.paths ?? {}, collection: { periodMs: memorySamplePeriodMs, maxMemorySamples, memorySamplesDropped: 0, phaseEvents: [{ elapsedMs: 0, phase: 'running' }], frameTiming: 'draw callback CPU time / callback spacing; GPU completion is separate', preview: adapter.previewMetadata ?? null } };
  const composition = materializeComposition(scenario.composition, options.fixtureDirectory);
  if (scenario.errorFixturePath) composition.items[0].path = `${options.fixtureDirectory}/${scenario.errorFixturePath}`;
  // This metadata belongs to the harness; native items must not receive it.
  for (const item of composition.items) delete item.noFramesExpected;
  let sampling = false;
  let samplingTask = null;
  let session = null;
  let pendingOperation = null;
  let phase = 'running';
  let cycle;
  let initialMemory;
  let operation = scenario.operations[0] ?? null;
  let stage = 'initial-memory';
  const setPhase = (nextPhase) => {
    phase = nextPhase;
    entry.collection.phaseEvents.push({ elapsedMs: adapter.now() - started, phase,
      ...(cycle == null ? {} : { cycle }) });
  };
  const recordSample = (point) => {
    if (entry.memorySamples.length < maxMemorySamples) entry.memorySamples.push(point);
    else { entry.collection.memorySamplesDropped++; }
  };
  const sample = async () => {
    // Preserve the phase which requested the reading. An asynchronous native
    // collector can return after cleanup; that running sample is not settled.
    const context = { id: scenario.id, phase, cycle };
    const elapsedMs = adapter.now() - started;
    try {
      const [memoryReading, conditionsReading] = await Promise.allSettled([
        adapter.sampleMemory?.(context), adapter.sampleOperatingConditions?.(context),
      ]);
      const memory = normalizeMemory(memoryReading.status === 'fulfilled' ? memoryReading.value :
        Object.fromEntries(['rssBytes', 'nativeHeapBytes', 'gpuBytes', 'ownedBytes'].map((field) =>
          [field, { value: null, reason: errorText(memoryReading.reason) }])));
      const conditions = conditionsReading.status === 'fulfilled' ? conditionsReading.value : null;
      const operatingConditions = conditions && typeof conditions.thermalState === 'string' && typeof conditions.powerMode === 'string'
        ? { thermalState: conditions.thermalState, powerMode: conditions.powerMode,
          ...(typeof conditions.applicationState === 'string' ? { applicationState: conditions.applicationState } : {}),
          source: conditions.source ?? 'Injected native operating condition collector' }
        : { thermalState: null, powerMode: null, source: null,
          reason: conditionsReading.status === 'rejected' ? errorText(conditionsReading.reason) : 'No native operating condition collector attached' };
      recordSample({ elapsedMs, collectedAtElapsedMs: adapter.now() - started,
        phase: context.phase, ...(context.cycle == null ? {} : { cycle: context.cycle }), memory, operatingConditions });
      return memory;
    } catch (error) {
      recordSample({ elapsedMs, collectedAtElapsedMs: adapter.now() - started,
        phase: context.phase, ...(context.cycle == null ? {} : { cycle: context.cycle }),
        operatingConditions: { thermalState: null, powerMode: null, source: null, reason: errorText(error) },
        memory: normalizeMemory(Object.fromEntries(['rssBytes', 'nativeHeapBytes', 'gpuBytes', 'ownedBytes'].map((field) => [field, { value: null, reason: errorText(error) }]))) });
    }
  };
  const mount = async (seekBeforeReady) => {
    stage = 'mount';
    session = await adapter.mount({ scenario, composition, preview: scenario.preview, seekBeforeReady });
    entry.collection.preview = { ...adapter.previewMetadata,
      requestedPixelWidth: scenario.preview.width, requestedPixelHeight: scenario.preview.height,
      logicalWidth: session?.dimensions?.logicalWidth ?? null,
      logicalHeight: session?.dimensions?.logicalHeight ?? null,
      actualPixelWidth: session?.actualDrawnPixels?.width ?? null,
      actualPixelHeight: session?.actualDrawnPixels?.height ?? null };
    stage = 'operation:' + operation;
  };
  const unmount = async () => {
    if (session) { stage = 'unmount'; const current = session; session = null; await adapter.unmount(current); }
  };
  const settle = async () => {
    stage = 'settle:unmount';
    await unmount();
    stage = 'settle:drain';
    if (adapter.drain) await adapter.drain();
    else entry.collection.drain = 'unavailable; settled wait is a measurement interval, not a GPU fence';
    stage = 'settle:wait';
    await adapter.sleep(options.settleMs ?? 2000);
    stage = 'settle:memory';
    setPhase('settled');
    const memory = await sample();
    setPhase('running');
    return memory;
  };
  const exportOnce = async (output, signal, onProgress) => {
    stage = 'export:output-path';
    const outputPath = await adapter.outputPath(scenario.id, options.repetition ?? 0, cycle ?? 0);
    try {
      stage = 'export:encode-and-probe';
      return await adapter.export({ scenario, composition, output, outputPath, signal, onProgress });
    } catch (error) {
      throw annotateFailureStage(error, stage);
    } finally {
      // Wait for export completion/rejection before deleting a file the codec may still write.
      stage = 'export:remove-output';
      await adapter.removeOutput?.(outputPath);
    }
  };
  const boundedExport = async (output, controller = new AbortController(), onProgress, deadlineMs = options.exportDeadlineMs ?? 180000) => {
    const exporting = exportOnce(output, controller.signal, onProgress);
    pendingOperation = exporting;
    let timeout;
    const deadline = new Promise((_, reject) => { timeout = setTimeout(() => {
      controller.abort();
      entry.unsafeToContinue = true;
      reject(new Error('Export deadline exceeded; backend must finish cancellation'));
    }, deadlineMs); });
    try {
      const result = await Promise.race([exporting, deadline]);
      pendingOperation = null;
      return result;
    } catch (error) {
      if (!entry.unsafeToContinue) pendingOperation = null;
      throw error;
    } finally { clearTimeout(timeout); }
  };
  initialMemory = await sample();
  // Native/host collection continues independently when JS export runs a synchronous worklet.
  const timer = options.enableIntervalSampling === false ? null : setInterval(() => {
    if (sampling) return;
    sampling = true;
    samplingTask = sample().finally(() => { sampling = false; });
  }, entry.collection.periodMs);
  try {
    const opensOnlyForFailure = scenario.operations.includes('open-error');
    if (!opensOnlyForFailure && !scenario.operations.includes('seek-before-ready') && scenario.operations.some((operation) => !['export', 'export-allow-clean-error', 'cancel-before', 'cancel-export', 'mixed-exports'].includes(operation))) await mount();
    for (const nextOperation of scenario.operations) {
      operation = nextOperation;
      stage = 'operation:' + operation;
      const opStarted = adapter.now();
      let data = {};
      if (operation === 'play') {
        if (!session) await mount();
        data = await adapter.playToEnd(session, { deadlineMs: composition.duration * 1000 + 15000 });
      } else if (operation === 'perf') {
        if (!session) await mount();
        if (scenario.seekBeforePerf !== false) await adapter.seek(session, 0, { settle: true });
        data = await adapter.measurePlayback(session, Math.min(composition.duration - 0.2, 8) * 1000);
      } else if (operation === 'seek' || operation === 'scrub' || operation === 'seek-playing' || operation === 'scrub-playing') {
        if (!session) await mount();
        const whilePlaying = operation.endsWith('-playing');
        const scrubbing = operation.startsWith('scrub');
        if (whilePlaying) await adapter.play(session);
        const durations = [];
        const seekObservations = [];
        if (scrubbing) for (const time of scenario.scrubTimes) { await adapter.seek(session, time, { settle: false, preservePlaying: whilePlaying }); await adapter.sleep(16); }
        for (const time of !scrubbing ? scenario.seeks : [composition.duration * 0.6 + 0.013]) {
          const seekStarted = adapter.now();
          const observation = await adapter.seek(session, time, { settle: true, preservePlaying: whilePlaying, deadlineMs: 4000 });
          if (observation?.correct === false) throw new Error(`Incorrect settled frame at ${time}s`);
          durations.push(adapter.now() - seekStarted);
          if (seekObservations.length < 10) seekObservations.push(summarizeSeekValidation(observation, time));
        }
        if (whilePlaying) await adapter.pause(session);
        data = { latencies: summarizeDurations(durations), seekCount: !scrubbing ? durations.length : scenario.scrubTimes.length + 1,
          whilePlaying, seekObservations, seekObservationLimit: 10,
          seekObservationsDropped: durations.length - seekObservations.length };
      } else if (operation === 'pause-resume') {
        if (!session) await mount();
        await adapter.seek(session, 0.5, { settle: true });
        await adapter.pause(session);
        const paused = await adapter.observe(session);
        await adapter.sleep(250);
        const stillPaused = await adapter.observe(session);
        if (!Number.isFinite(paused.currentTime) || Math.abs(stillPaused.currentTime - paused.currentTime) > 0.05) throw new Error('Paused composition clock advanced');
        await adapter.play(session);
        await adapter.sleep(400);
        const resumed = await adapter.observe(session);
        await adapter.pause(session);
        if (!(resumed.currentTime > stillPaused.currentTime + 0.1)) throw new Error('Composition clock did not resume');
        data = { pausedDelta: stillPaused.currentTime - paused.currentTime, resumedDelta: resumed.currentTime - stillPaused.currentTime };
      } else if (operation === 'frame-map-pruning') {
        if (!session) await mount();
        await adapter.seek(session, 0.5, { settle: true });
        await adapter.seek(session, composition.duration - 0.5, { settle: true });
        const endedIds = composition.items.filter((item) => item.kind !== 'audio' && item.compositionStartTime + item.duration < composition.duration - 1).map((item) => item.id);
        let observation = await adapter.observe(session);
        const closeDeadline = adapter.now() + 4000;
        while (Array.isArray(observation.frameIds) && endedIds.some((id) => observation.frameIds.includes(id)) && adapter.now() < closeDeadline) {
          await adapter.sleep(16);
          observation = await adapter.observe(session);
        }
        if (!Array.isArray(observation.frameIds)) throw new Error('Frame map observation is unavailable');
        if (endedIds.some((id) => observation.frameIds.includes(id))) throw new Error('Closed item remains in the decoded frame map');
        data = { removedIds: endedIds, remainingIds: observation.frameIds };
      } else if (operation === 'export-allow-clean-error') {
        await settle();
        const controller = new AbortController();
        try { data = { completed: true, ...await boundedExport(scenario.output, controller, undefined, options.exportDeadlineMs ?? 60000) }; }
        catch (error) {
          if (entry.unsafeToContinue || error?.unsafeToContinue || adapter.isResourceExhaustion?.(error) ||
              !(adapter.isExpectedMissingAudioError?.(error) ?? /^No audio track\b/.test(errorText(error)))) throw error;
          data = { completed: false, cleanFailure: true, reason: errorText(error) };
        }
      } else if (operation === 'loop') {
        if (!session) await mount();
        data = await adapter.loop(session, { seek: Math.max(0, composition.duration - 1), deadlineMs: 8000 });
      } else if (operation === 'hold') {
        if (!session) await mount();
        await adapter.seek(session, Math.min(1, composition.duration / 2) + 0.013, { settle: true });
        await adapter.sleep(2500);
        await sample();
      } else if (operation === 'seek-past-end') {
        if (!session) await mount();
        await adapter.seek(session, composition.duration + 3, { settle: false });
        data = await adapter.seek(session, Math.min(0.5, composition.duration / 2), { settle: true, deadlineMs: 4000 });
      } else if (operation === 'seek-before-ready') {
        await unmount();
        await mount(composition.duration * 0.75);
        data = await adapter.seek(session, composition.duration * 0.75, { settle: true, deadlineMs: 4000 });
      } else if (operation === 'open-error') {
        let error;
        try { await mount(); } catch (caught) { error = caught; }
        if (!error) throw new Error('Missing media did not produce an error');
        if (error.unsafeToContinue || !(adapter.isExpectedMissingMediaError?.(error) ??
            /No video track|No such file|ENOENT|FileNotFound|missing file/i.test(errorText(error)))) throw error;
        data = { expectedError: errorText(error) };
      } else if (operation === 'export' || operation === 'cancel-before' || operation === 'cancel-export') {
        await settle();
        const controller = new AbortController();
        const total = expectedFrameCount(composition.duration, scenario.output.frameRate);
        let lastProgress = 0;
        let events = 0;
        let progressError;
        if (operation === 'cancel-before') controller.abort();
        const exportStarted = adapter.now();
        const onProgress = (progress) => {
          if (!Number.isInteger(progress.framesCompleted) || progress.framesCompleted < lastProgress || progress.nbFrames !== total || progress.framesCompleted > total) { progressError = new Error('Invalid export progress'); controller.abort(); return; }
          lastProgress = progress.framesCompleted;
          events++;
          if (operation === 'cancel-export' && lastProgress >= Math.min(10, total - 1)) controller.abort();
        };
        let outcome;
        try { outcome = await boundedExport(scenario.output, controller, onProgress); }
        catch (error) {
          if (entry.unsafeToContinue) throw error;
          if (operation === 'export' || error?.name !== 'AbortError') throw error;
          outcome = { cancelled: true };
        }
        if (progressError) throw progressError;
        if (operation !== 'export' && !outcome?.cancelled) throw new Error('Cancelled export did not reject with AbortError');
        if (operation === 'export' && lastProgress !== total) throw new Error(`Export stopped at ${lastProgress}/${total}`);
        data = { ...outcome, exportMs: adapter.now() - exportStarted, framesCompleted: lastProgress, expectedFrames: total, progressEvents: events, requestedOutput: scenario.output };
      } else if (operation === 'mixed-exports') {
        await settle();
        data = { exports: [] };
        for (cycle = 0; cycle < scenario.exportCycles; cycle++) {
          const size = [{ width: 640, height: 360 }, { width: 1920, height: 1080 }, { width: 720, height: 1280 }][cycle % 3];
          const output = { ...scenario.output, ...size };
          const begin = adapter.now();
          const outcome = await boundedExport(output);
          data.exports.push({ durationMs: adapter.now() - begin, output, ...outcome });
          if (cycle % 5 === 0 || cycle === scenario.exportCycles - 1) await settle();
        }
      } else if (operation === 'leak' || operation === 'churn') {
        await unmount();
        const cycles = operation === 'leak' ? scenario.mountCycles : scenario.churnTimings.length;
        for (cycle = 0; cycle <= cycles; cycle++) {
          if (cycle % 10 === 0 || cycle === cycles) await settle();
          if (cycle === cycles) break;
          const timing = operation === 'churn' ? scenario.churnTimings[cycle] : { beforeMs: 100, playMs: 400, seek: composition.duration * 0.7 };
          await adapter.sleep(timing.beforeMs);
          await mount();
          await adapter.play(session);
          await adapter.sleep(timing.playMs);
          await adapter.seek(session, timing.seek, { settle: operation === 'leak', deadlineMs: 4000 });
          await unmount();
        }
        data = { cycles };
        cycle = undefined;
      } else throw new Error(`Unsupported benchmark operation: ${operation}`);
      entry.operations.push({ operation, elapsedMs: adapter.now() - opStarted, ...data });
      await sample();
    }
    for (const check of scenario.validation ?? []) {
      stage = 'validation:' + check;
      if (adapter.validate) entry.validations.push(await adapter.validate({ check, scenario, composition }));
      else entry.validations.push({ check, status: 'unavailable', reason: 'No pixel/audio/timestamp validator attached; performance is not a correctness proof' });
    }
    if (entry.validations.some((validation) => validation.status === 'failed')) throw new Error('Media correctness validation failed');
  } catch (error) {
    if (error?.unsafeToContinue) entry.unsafeToContinue = true;
    entry.status = scenario.resourceExhaustionAllowed && adapter.isResourceExhaustion?.(error) ? 'resource-limit' : 'failed';
    entry.reason = errorText(error);
    entry.diagnostic = failureDiagnostic(error, { stage, operation });
  } finally {
    if (timer) clearInterval(timer);
    if (samplingTask) await samplingTask;
    // A timed-out native job might still own resources: do not claim cleanup or run another case.
    if (pendingOperation && entry.unsafeToContinue) {
      pendingOperation.catch(() => {});
      entry.collection.cleanup = 'unverified: operation still pending; restart app';
      try { await unmount(); } catch (error) {
        entry.cleanupError = errorText(error);
        entry.cleanupDiagnostic = failureDiagnostic(error, { stage, operation });
      }
    } else {
      try {
        const finalMemory = await settle();
        if (adapter.verifyOwnedCleanup) {
          for (const field of ['ownedBytes', 'ownedResources']) {
            const before = initialMemory?.[field];
            const after = finalMemory?.[field];
            if (before?.value == null || after?.value == null || before.source !== after.source) continue;
            (entry.collection.ownedCleanup ??= {})[field] = { before: before.value, after: after.value };
            if (after.value > before.value) {
              entry.status = 'failed';
              entry.unsafeToContinue = true;
              entry.cleanupError = 'Library-owned reservations did not return to baseline after teardown';
              entry.cleanupDiagnostic = failureDiagnostic(entry.cleanupError,
                { stage: 'cleanup:owned-reservations', operation });
            }
          }
        }
      }
      catch (error) {
        entry.status = 'failed'; entry.unsafeToContinue = true; entry.cleanupError = errorText(error);
        entry.cleanupDiagnostic = failureDiagnostic(error, { stage, operation });
      }
    }
    entry.elapsedMs = adapter.now() - started;
  }
  return entry;
}

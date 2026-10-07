import { createPublicApiAdapter } from './public-api-adapter.mjs';
import { waitForBenchmarkForeground } from './foreground-ready.mjs';
import { createHistogram, recordHistogram } from './metrics.mjs';
import { annotateFailureStage, failureDiagnostic, runBenchmarks } from './runner.mjs';
import { detachPreviewSession, previewDimensions } from './preview-lifecycle.mjs';
import { assessPlayingSeek, observePlayingSeekClock, shouldResumeAfterNaturalEnd } from './playing-seek.mjs';

/** Copy only small scalar metadata. SharedValue.modify mutates its object, so
 * keeping counters.value would lose the state captured immediately before seek. */
export function snapshotPreviewSeekState({ counters, player }) {
  const read = (object, key) => { try { return object?.[key]; } catch { return null; } };
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const ids = (value) => Array.isArray(value) ? value.slice(0, 16)
    .filter((id) => typeof id === 'string').map((id) => id.slice(0, 96)) : [];
  const captured = read(counters, 'value');
  const drawnIds = read(captured, 'drawnIds');
  const identities = read(captured, 'frameIdentities');
  const isPlaying = read(player, 'isPlaying');
  return {
    playerTime: finite(read(player, 'currentTime')),
    drawnTime: finite(read(captured, 'currentTime')),
    isPlaying: typeof isPlaying === 'boolean' ? isPlaying : null,
    drawnFrameIds: ids(typeof drawnIds === 'string' ? drawnIds.split('|').filter(Boolean) : []),
    frameMapIds: ids(read(captured, 'frameIds')),
    frameIdentities: Array.isArray(identities) ? identities.slice(0, 16).map((entry) => {
      const itemId = read(entry, 'itemId');
      const frameId = read(entry, 'frameId');
      const producerId = read(entry, 'producerId');
      return { itemId: typeof itemId === 'string' ? itemId.slice(0, 96) : null,
        frameId: Number.isSafeInteger(frameId) ? frameId : null,
        producerId: Number.isSafeInteger(producerId) ? producerId : null };
    }) : [],
    renderSequence: finite(read(captured, 'renderSequence')),
    lastDrawAtMs: finite(read(captured, 'lastDrawAtMs')),
  };
}

/** Inject one installed backend. PreviewSession actually unmounts between
 * cycles, including its Canvas and hook surfaces; no hidden offscreen viewer. */
export function createBenchmarkScreen({ React, native, skia, reanimated, video, files, memory, validation, extensions = {} }) {
  const { useCallback, useEffect, useRef, useState } = React;
  const { View, Text, Button, PixelRatio } = native;
  const { Canvas, Image } = skia;
  const { useSharedValue, runOnUI, runOnJS } = reanimated;
  const { useVideoCompositionPlayer, drawVideoFrame } = video;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = () => performance.now();
  const pixelRatio = PixelRatio.get();
  if (!(Number.isFinite(pixelRatio) && pixelRatio > 0)) throw new Error('Invalid device pixel ratio');
  function emptyCounters() {
    return { draw: createHistogram(), gaps: createHistogram(), lastMs: 0, draws: 0,
      missing: 0, currentTime: -1, drawnIds: '', frameIds: [], frameIdentities: [],
      renderSequence: 0, lastDrawAtMs: null, width: 0, height: 0, measure: false };
  }
  const flushUiQueue = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Preview UI cleanup acknowledgement timed out')), 10000);
    const acknowledged = () => { clearTimeout(timeout); resolve(); };
    try { runOnUI(() => { 'worklet'; runOnJS(acknowledged)(); })(); }
    catch (error) { clearTimeout(timeout); reject(error); }
  });
  const drawComposition = (args) => {
    'worklet';
    const { canvas, videoComposition, currentTime, frames, width, height } = args;
    const visible = videoComposition.items.filter((item) => item.kind !== 'audio' &&
      item.compositionStartTime <= currentTime && currentTime < item.compositionStartTime + item.duration);
    const tile = height / Math.max(visible.length, 1);
    for (let index = 0; index < visible.length; index++) {
      const frame = frames[visible[index].id];
      if (frame?.texture != null) drawVideoFrame(canvas, frame,
        { x: 0, y: index * tile, width, height: tile }, { fit: 'contain' });
    }
  };
  function PreviewSession({ session }) {
    const [looping, setLooping] = useState(false);
    const counters = useSharedValue(emptyCounters());
    const renderer = session.scenario.extension ? extensions[session.scenario.extension]?.drawFrame : null;
    const noFrameIds = session.scenario.composition.items.filter((item) => item.noFramesExpected)
      .map((item) => '|' + item.id + '|').join('');
    const drawFrame = useCallback((args) => {
      'worklet';
      const start = performance.now();
      if (renderer) renderer(args); else drawComposition(args);
      const { videoComposition, currentTime, frames, width, height } = args;
      const visible = videoComposition.items.filter((item) => item.kind !== 'audio' &&
        item.compositionStartTime <= currentTime && currentTime < item.compositionStartTime + item.duration);
      let ids = '';
      let missing = false;
      for (const item of visible) {
        if (frames[item.id]?.texture != null) {
          ids += '|' + item.id + '|';
        }
        else if (currentTime - item.compositionStartTime > 0.3 && !noFrameIds.includes('|' + item.id + '|')) missing = true;
      }
      const frameIds = Object.keys(frames);
      // Include prefetched frames too: a newly visible item can otherwise reuse
      // an old cached native token which was absent from the visible ID list.
      const frameIdentities = frameIds.slice(0, 16).map((itemId) => ({
        itemId: String(itemId).slice(0, 96),
        frameId: Number.isSafeInteger(frames[itemId]?.id) ? frames[itemId].id : null,
        producerId: Number.isSafeInteger(frames[itemId]?.producerId) ? frames[itemId].producerId : null,
      }));
      const duration = performance.now() - start;
      counters.modify((value) => {
        'worklet';
        value.currentTime = currentTime;
        value.drawnIds = ids;
        value.frameIds = frameIds;
        value.frameIdentities = frameIdentities;
        value.renderSequence++;
        value.lastDrawAtMs = start;
        value.width = width;
        value.height = height;
        if (value.measure) {
          recordHistogram(value.draw, duration);
          if (value.lastMs) recordHistogram(value.gaps, start - value.lastMs);
          value.lastMs = start;
          value.draws++;
          if (missing) value.missing++;
        }
        return value;
      });
    }, [counters, renderer, noFrameIds]);
    const { currentFrame, player } = useVideoCompositionPlayer({ composition: session.composition,
      width: session.dimensions.logicalWidth, height: session.dimensions.logicalHeight,
      drawFrame, isLooping: looping,
      onReadyToPlay: () => { session.ready = true; },
      onComplete: () => { session.complete++; },
      onError: (error) => { session.error ??= error; session.errorCount++; } });
    useEffect(() => {
      session.player = player;
      session.counters = counters;
      session.setLooping = setLooping;
      return () => { session.player = null; };
    }, [session, player, counters]);
    useEffect(() => () => { session.player = null; session.detached = true; }, [session]);
    return React.createElement(Canvas, { style: { width: session.dimensions.logicalWidth,
      height: session.dimensions.logicalHeight } }, React.createElement(Image,
      { image: currentFrame, x: 0, y: 0, width: session.dimensions.logicalWidth,
        height: session.dimensions.logicalHeight }));
  }
  return function BenchmarkScreen({ options, onResult }) {
    const [active, setActive] = useState(null);
    const [status, setStatus] = useState('Ready');
    const [running, setRunning] = useState(false);
    const runningRef = useRef(false);
    const sessionRef = useRef(null);
    const generation = useRef(0);
    const current = () => {
      const session = sessionRef.current;
      if (!session?.player || session.detached) throw new Error('Preview session is not mounted');
      if (session.error) throw session.error;
      return session;
    };
    const waitFor = async (predicate, deadlineMs, checkErrors = true, session = sessionRef.current) => {
      const deadline = now() + deadlineMs;
      while (!predicate()) {
        if (checkErrors && session?.error) throw session.error;
        if (now() >= deadline) throw new Error('Preview operation timed out');
        await sleep(16);
      }
      if (checkErrors && session?.error) throw session.error;
    };
    const detach = async (session = sessionRef.current) => {
      await detachPreviewSession(session, { deactivate: () => setActive(null), waitFor, flushUiQueue });
      if (sessionRef.current === session) sessionRef.current = null;
    };
    const preview = {
      pixelRatio,
      cleanupSemantics: 'React child/Canvas unmounted; hook UI cleanup queue acknowledged; driver allocations measured separately',
      mount: async (config) => {
        if (sessionRef.current) throw new Error('Previous preview session is still attached');
        const session = { ...config, key: ++generation.current,
          dimensions: previewDimensions(config.preview, pixelRatio), ready: false,
          complete: 0, error: null, errorCount: 0, player: null, counters: null, detached: false };
        sessionRef.current = session;
        setActive(session);
        let mountStage = 'mount:attach-react-child';
        try {
          if (config.seekBeforeReady != null) {
            mountStage = 'mount:wait-player-for-early-seek';
            await waitFor(() => !!session.player, 10000, true, session);
            mountStage = 'mount:seek-before-ready';
            session.player.seekTo(config.seekBeforeReady);
          }
          mountStage = 'mount:wait-ready-and-first-frame';
          await waitFor(() => session.ready && !!session.player && !!session.counters &&
            session.counters.value.width > 0, 15000, true, session);
          const captured = session.counters.value;
          mountStage = 'mount:verify-physical-dimensions';
          if (captured.width !== session.dimensions.pixelWidth || captured.height !== session.dimensions.pixelHeight)
            throw new Error('Actual preview pixels differ from the workload request');
          session.actualDrawnPixels = { width: captured.width, height: captured.height };
          return session;
        } catch (error) {
          const annotated = annotateFailureStage(error, mountStage, {
            ready: session.ready, attached: !session.detached, hasPlayer: !!session.player,
            hasCounters: !!session.counters, errorCount: session.errorCount,
          });
          try { await detach(session); }
          catch (cleanupError) {
            const annotatedCleanup = annotateFailureStage(cleanupError, 'mount:detach-after-failure');
            annotatedCleanup.cause = annotated;
            throw annotatedCleanup;
          }
          throw annotated;
        }
      },
      unmount: detach,
      play: async () => { current().player.play(); },
      pause: async () => { current().player.pause(); },
      observe: async () => { const session = current(); return {
        currentTime: session.player.currentTime, frameIds: [...session.counters.value.frameIds] }; },
      seek: async (session, time, config = {}) => {
        current();
        const before = snapshotPreviewSeekState(session);
        if (!config.preservePlaying) session.player.pause();
        const seekStarted = now();
        session.player.seekTo(time);
        if (config.preservePlaying && shouldResumeAfterNaturalEnd({ before,
          requestedTime: time, duration: session.composition.duration })) session.player.play();
        let seekAssessment = { settlementKind: 'paused-clock-and-item-ids',
          frameValidation: 'clock-and-visible-item-ids', nativeIdentityValidation: 'unavailable' };
        let seekObservation = null;
        if (config.settle) {
          const expected = session.scenario.composition.items.filter((item) => item.kind !== 'audio' &&
            !item.noFramesExpected && item.compositionStartTime <= time && time < item.compositionStartTime + item.duration).map((item) => item.id);
          try {
            if (config.preservePlaying) {
              // Observe the requested running clock before a potentially slow UI
              // snapshot. A terminal blank render alone cannot prove this seek.
              const initialClock = snapshotPreviewSeekState({ player: session.player });
              let sawMovingClock = observePlayingSeekClock({ duration: session.composition.duration,
                requestedTime: time, elapsedMs: now() - seekStarted,
                playerTime: initialClock.playerTime, isPlaying: initialClock.isPlaying }).sawMovingClock;
              await waitFor(() => {
                const observation = snapshotPreviewSeekState(session);
                const assessment = assessPlayingSeek({ composition: session.composition,
                  requestedTime: time, elapsedMs: now() - seekStarted, before, observation, sawMovingClock });
                sawMovingClock = assessment.sawMovingClock;
                seekAssessment = assessment;
                seekObservation = observation;
                return assessment.settled;
              }, config.deadlineMs ?? 4000, true, session);
            } else {
              await waitFor(() => Math.abs(session.counters.value.currentTime - time) < 0.05 &&
                expected.every((id) => session.counters.value.drawnIds.includes('|' + id + '|')), config.deadlineMs ?? 4000, true, session);
            }
          } catch (error) {
            const observation = {
              ...snapshotPreviewSeekState(session),
              requestedTime: time, elapsedMs: now() - seekStarted,
              preservePlaying: config.preservePlaying === true,
              expectedFrameIds: expected,
              beforeFrameIdentities: before.frameIdentities,
              beforeRenderSequence: before.renderSequence,
              nativeFramePTS: null,
              nativeFramePTSReason: 'VideoFrame API does not expose presentation timestamps',
            };
            throw annotateFailureStage(error, 'preview:seek-settle', observation);
          }
        }
        return { correct: true, seekValidation: { settlementKind: seekAssessment.settlementKind,
          frameValidation: seekAssessment.frameValidation, nativeIdentityValidation: seekAssessment.nativeIdentityValidation,
          elapsedMs: now() - seekStarted, observation: seekObservation },
          timestampValidation: 'composition clock; native frame presentation timestamps unavailable' };
      },
      playToEnd: async (session, config) => {
        current();
        await preview.seek(session, 0, { settle: true });
        session.counters.value = { ...emptyCounters(), measure: true };
        const completed = session.complete;
        session.player.play();
        await waitFor(() => session.complete > completed, config.deadlineMs, true, session);
        const captured = session.counters.value;
        session.counters.value = { ...captured, measure: false };
        if (!captured.draws || captured.missing / captured.draws >= 0.05) throw new Error('Too many missing settled frames during playback');
        return { draws: captured.draws, missingFrames: captured.missing, droppedFrames: null,
          droppedFramesReason: 'No backend drop counter attached' };
      },
      measurePlayback: async (session, durationMs) => {
        current();
        session.counters.value = { ...emptyCounters(), measure: true };
        const begin = now();
        session.player.play();
        await sleep(durationMs);
        if (session.error) throw session.error;
        session.player.pause();
        const captured = session.counters.value;
        session.counters.value = { ...captured, measure: false };
        if (!captured.draws || captured.missing / captured.draws >= 0.05) throw new Error('Playback measurement has no valid settled frames');
        return { durationMs: now() - begin, drawHistogram: captured.draw,
          callbackGapHistogram: captured.gaps, draws: captured.draws, missingFrames: captured.missing,
          droppedFrames: null, gpuTimeMs: null,
          gpuTimeReason: 'Draw callback duration measures CPU submission, not GPU execution' };
      },
      loop: async (session, config) => {
        current();
        session.setLooping(true);
        await sleep(100);
        session.player.seekTo(config.seek);
        session.player.play();
        let sawEnd = false;
        await waitFor(() => {
          const time = session.player.currentTime;
          if (time > session.composition.duration - 0.6) sawEnd = true;
          return sawEnd && time > 0.3 && time < Math.min(1.5, session.composition.duration / 2);
        }, config.deadlineMs, true, session);
        session.player.pause();
        session.setLooping(false);
        return { wrapped: true };
      },
    };
    const run = async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      try {
        let foregroundReadiness = null;
        if (options.environment?.platform === 'ios' && typeof memory?.operatingConditions === 'function') {
          setStatus('Attente de l’application active…');
          try {
            foregroundReadiness = await waitForBenchmarkForeground({
              readOperatingConditions: () => memory.operatingConditions(), now, sleep });
          } catch (error) { throw annotateFailureStage(error, 'screen:foreground-readiness'); }
        }
        const attachedExtensions = Object.keys(extensions).filter((name) => typeof extensions[name]?.drawFrame === 'function');
        const adapter = createPublicApiAdapter({ video, preview, files, memory, validate: validation,
          clock: { now, sleep }, extensions: attachedExtensions, paths: options.backend.paths,
          drawFrame: (extension) => extension ? extensions[extension].drawFrame : drawComposition });
        const result = await runBenchmarks(adapter, { ...options,
          environment: { ...options.environment, pixelRatio },
          onEvent: (event) => {
            if (event.type === 'case-begin') setStatus(event.id + ' · ' + (event.repetition + 1));
            if (event.type === 'case-end' && event.result.status === 'failed')
              console.error('Benchmark failure', JSON.stringify({ id: event.result.id,
                repetition: event.result.repetition, diagnostic: event.result.diagnostic,
                cleanupDiagnostic: event.result.cleanupDiagnostic }));
            options.onEvent?.(event);
          } });
        if (foregroundReadiness) result.preflight = { foregroundReadiness };
        await files.writeResult?.(result);
        onResult?.(result);
        setStatus('Tests terminés');
      } catch (error) {
        console.error('Benchmark setup failure', JSON.stringify(failureDiagnostic(error, { stage: 'screen:run' })));
        setStatus(String(error?.message ?? error));
      }
      finally { runningRef.current = false; setRunning(false); }
    };
    useEffect(() => { if (options.autorun) run(); }, []);
    return React.createElement(View, { style: { flex: 1, alignItems: 'center' } },
      active ? React.createElement(PreviewSession, { key: active.key, session: active }) : null,
      React.createElement(Text, null, status), React.createElement(Button,
        { title: 'Lancer les tests', disabled: running, onPress: run }));
  };
}

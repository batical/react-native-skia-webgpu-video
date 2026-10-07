import { FIXTURES, fixtureById } from './fixtures.mjs';

export const WORKLOAD_VERSION = '2026-10-07.1';
export const DEFAULT_SEED = 0x534b5633;

export function randomSource(seed = DEFAULT_SEED) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

export function expectedFrameCount(duration, fps) {
  // Same tolerance as the legacy export, so summed durations do not add a frame.
  return Math.ceil(duration * fps - 1e-6);
}

export function activeItems(composition, time) {
  return composition.items.filter((item) => item.kind !== 'audio' && item.compositionStartTime <= time && time < item.compositionStartTime + item.duration);
}

export function makeSequence(clips, options = {}) {
  let time = 0;
  const items = clips.map((clip, index) => {
    const item = { id: `clip-${index}`, fixture: clip.fixture, compositionStartTime: time, startTime: clip.start ?? 0, duration: clip.duration ?? 2, ...clip.extra };
    if (options.maxLongSide) item.maxLongSide = options.maxLongSide;
    if (options.resolution) item.resolution = options.resolution;
    if (options.textureMode) item.textureMode = options.textureMode;
    time += item.duration - (options.overlap ?? 0);
    return item;
  });
  if (!items.length) throw new Error('A sequence needs at least one item');
  const last = items.at(-1);
  return { duration: last.compositionStartTime + last.duration, lazyDecoders: options.lazy ?? true, items };
}

export function materializeComposition(composition, directory) {
  return { ...composition, items: composition.items.map(({ fixture, ...item }) => ({ ...item, path: `${directory.replace(/\/$/, '')}/${fixtureById(fixture).file}` })) };
}

/** Every legacy stress composition is always present; missing media is a skip. */
export function buildCases({ seed = DEFAULT_SEED, profile = 'full' } = {}) {
  if (!['smoke', 'full', 'soak'].includes(profile)) throw new Error(`Unknown profile: ${profile}`);
  const random = randomSource(seed);
  const scenarios = [];
  const all = ['play', 'seek', 'scrub', 'loop', 'export'];
  const measured = [...all, 'churn', 'perf'];
  const add = (id, composition, operations, extra = {}) => {
    const seeks = [composition.duration * 0.8 + 0.013, 0.2, ...composition.items.filter((item) => item.kind !== 'audio').slice(0, 6).map((item) => item.compositionStartTime + item.duration / 2), Math.max(0, composition.duration - 0.1), composition.duration * 0.33 + 0.013];
    scenarios.push({ id, composition, operations, output: { width: 1080, height: 1080, frameRate: 30, bitRate: 8_000_000, codec: 'h264', encoderMode: 'copy' }, preview: { width: 720, height: 720, resolutionUnit: 'physical-pixels', pacing: 'device-vsync', fit: 'contain' }, seeks, scrubTimes: Array.from({ length: profile === 'soak' ? 2000 : 80 }, () => random() * composition.duration), mountCycles: profile === 'soak' ? 100 : 40, churnTimings: Array.from({ length: 25 }, () => ({ beforeMs: 20 + Math.floor(random() * 100), playMs: 50 + Math.floor(random() * 350), seek: random() * composition.duration })), ...extra });
  };
  const media = FIXTURES.slice(0, 10).filter((fixture) => fixture.seconds >= 2);
  for (const lazy of [false, true]) {
    add(`montage-all-crossfade-${lazy ? 'lazy' : 'eager'}`, makeSequence(media.map((m, i) => ({ fixture: m.id, start: i * 0.7 % (m.seconds - 2), duration: 2 })), { lazy, overlap: 0.5 }), lazy ? measured : [...all, 'leak'], { resourceExhaustionAllowed: !lazy });
  }
  add('montage-all-crossfade-lazy-direct', makeSequence(media.map((m, i) => ({ fixture: m.id, start: i * 0.7 % (m.seconds - 2), duration: 2 })), { lazy: true, overlap: 0.5, textureMode: 'direct' }), measured);
  const uhd = Array.from({ length: 8 }, (_, i) => ({ fixture: i % 2 ? 'hevc-4k30' : 'h264-4k30', start: i * 0.9 % 6, duration: 1.5 }));
  add('4k-x8-lazy', makeSequence(uhd), [...measured, 'leak']);
  add('4k-x8-lazy-maxLongSide1280', makeSequence(uhd, { maxLongSide: 1280 }), all);
  add('4k-x8-lazy-direct', makeSequence(uhd, { textureMode: 'direct' }), [...measured, 'leak']);
  add('4k-x8-eager', makeSequence(uhd, { lazy: false }), ['play', 'seek', 'export'], { resourceExhaustionAllowed: true });
  add('4k-x3-simultaneous', { duration: 5, lazyDecoders: true, items: [0, 1, 2].map((i) => ({ id: `pip-${i}`, fixture: i % 2 ? 'hevc-4k30' : 'h264-4k30', compositionStartTime: i * 0.5, startTime: i, duration: 4 })) }, all, { resourceExhaustionAllowed: true });
  add('shorts-x20-lazy', makeSequence(Array.from({ length: 20 }, (_, i) => ({ fixture: i % 2 ? 'h264-720p60' : 'h264-638x358', start: i * 0.37 % 5, duration: 0.6 }))), all);
  for (const fixture of FIXTURES.slice(0, 10)) {
    for (const mode of ['copy', 'direct']) {
      add(`single-${fixture.file}${mode === 'direct' ? '-direct' : ''}`, makeSequence([{ fixture: fixture.id, duration: Math.min(fixture.seconds, 4) }], { textureMode: mode, lazy: false }), fixture.seconds < 2 ? ['play'] : ['play', 'seek', 'loop', 'hold', ...(['h264-1080p30-audio', 'h264-4k30', 'hevc-4k30'].includes(fixture.id) ? ['perf'] : [])]);
    }
  }
  const audio = makeSequence([{ fixture: 'h264-1080p30-audio', start: 1, duration: 3, extra: { audio: true } }, { fixture: 'h264-1080p-rot90', duration: 3 }, { fixture: 'hevc-4k30-audio', start: 2, duration: 3, extra: { audio: { volume: 0.5 } } }], { maxLongSide: 1280 });
  audio.items.push({ id: 'music', fixture: 'tone', kind: 'audio', compositionStartTime: 0, startTime: 0, duration: audio.duration, volume: 0.2 });
  add('audio-lazy', audio, [...all, 'leak'], { validation: ['audio-timeline', 'audio-volume'] });
  add('start-past-file-end', makeSequence([{ fixture: 'h264-638x358' }, { fixture: 'h264-720p-short', start: 3, extra: { noFramesExpected: true } }, { fixture: 'h264-638x358', start: 2 }]), ['play', 'seek', 'export']);
  // Native cases absent from the old example, plus lifecycle regression workloads.
  for (const fixture of ['h264-720p-rot180', 'hevc-1080p-rot270', 'h264-slow-motion']) {
    add(`native-${fixture}`, makeSequence([{ fixture, duration: Math.min(fixtureById(fixture).seconds, 6) }]), ['play', 'seek', 'export'], { validation: ['pixels', 'orientation', 'presentation-timestamps'] });
  }
  for (const encoderMode of ['copy', 'direct']) {
    for (const codec of ['h264', 'hevc', 'unknown-fallback']) {
      add(`encode-${codec}-${encoderMode}`, makeSequence([{ fixture: 'h264-638x358', duration: 2 }]), ['export'], { output: { width: 640, height: 360, frameRate: 30, bitRate: 2_000_000, codec, encoderMode }, validation: ['pixels', 'presentation-timestamps', 'actual-codec'] });
    }
  }
  add('cancel-before-export', makeSequence([{ fixture: 'h264-638x358' }]), ['cancel-before']);
  add('cancel-mid-export', makeSequence(uhd), ['cancel-export', 'leak']);
  add('repeated-mixed-size-exports', makeSequence([{ fixture: 'h264-638x358', duration: 0.6 }]), ['mixed-exports'], { exportCycles: profile === 'soak' ? 100 : 20 });
  add('seek-past-end-resume', makeSequence([{ fixture: 'h264-638x358' }]), ['seek-past-end', 'play']);
  add('seek-before-ready', makeSequence(uhd), ['seek-before-ready']);
  add('paused-clock-and-resume', makeSequence([{ fixture: 'h264-638x358', duration: 4 }]), ['pause-resume'], { previewCapabilities: ['pause', 'observe'] });
  add('seek-while-playing', makeSequence(uhd), ['seek-playing'], { previewCapabilities: ['pause'], validation: ['pixels', 'presentation-timestamps'] });
  add('scrub-while-playing', makeSequence(uhd), ['scrub-playing'], { previewCapabilities: ['pause'], validation: ['pixels'] });
  add('closed-item-leaves-frame-map', makeSequence(Array.from({ length: 3 }, () => ({ fixture: 'h264-638x358', duration: 3 }))), ['frame-map-pruning'], { previewCapabilities: ['observe'] });
  add('held-image-survives-seek', makeSequence([{ fixture: 'h264-638x358', duration: 4 }]), ['hold', 'seek'], { validation: ['held-image-immutable-after-seek'] });
  add('audio-track-absent-does-not-hang', makeSequence([{ fixture: 'h264-638x358', duration: 2, extra: { audio: true } }]), ['export-allow-clean-error'], { validation: ['audio-absent-bounded-completion'] });
  add('forward-scrub-threshold', makeSequence([{ fixture: 'h264-638x358' }]), ['seek'], { seeks: [0.1, 0.2, 0.45, 0.7, 1.5, 0.3] });
  add('missing-file', makeSequence([{ fixture: 'h264-638x358' }]), ['open-error'], { errorFixturePath: 'intentionally-missing.mp4' });
  add('explicit-resolution-wins', makeSequence([{ fixture: 'h264-4k30' }], { maxLongSide: 1280, resolution: { width: 480, height: 270 } }), ['seek', 'export'], { validation: ['decoded-dimensions', 'pixels'] });
  add('long-montage-120-clips', makeSequence(Array.from({ length: 120 }, (_, i) => ({ fixture: i % 2 ? 'h264-638x358' : 'h264-720p60', duration: 0.6, start: i * 0.37 % 5 }))), ['play', 'scrub', 'export', 'leak']);
  // Extension cases require an installed renderer adapter; absent support is an explicit skip.
  for (const extension of ['lut', 'compute', 'three', 'coreml']) {
    add(`extension-${extension}`, makeSequence([{ fixture: 'h264-1080p30-audio', duration: 4 }]), ['perf', 'export', 'leak'], { extension, validation: ['pixels', 'deterministic-time'] });
  }
  // Separate steady playback from seek/lifecycle stress. The original single-*
  // cases remain unchanged and still reproduce legacy reader seek failures.
  // Append after generating legacy random sequences, then put these readings
  // first so export caches do not precondition a fresh-process playback run.
  for (const fixture of ['h264-1080p30-audio', 'h264-4k30', 'hevc-4k30']) {
    add(`steady-playback-${fixture}`, makeSequence([{ fixture, duration: 4 }],
      { textureMode: 'copy', lazy: false }), ['perf'], { seekBeforePerf: false });
  }
  const steadyCopies = scenarios.splice(-3);
  // Reuse each copy workload's timings rather than drawing new random values.
  // This preserves the existing catalogue and changes only the requested mode
  // and ID. Actual transport/copies are recorded by the backend separately.
  const steadyDirect = steadyCopies.map((scenario) => ({
    ...scenario,
    id: `${scenario.id}-direct`,
    composition: { ...scenario.composition,
      items: scenario.composition.items.map((item) => ({ ...item, textureMode: 'direct' })) },
  }));
  scenarios.unshift(...steadyCopies, ...steadyDirect);
  const smokeIds = new Set(['single-h264-638x358.mp4', '4k-x8-lazy-maxLongSide1280', 'encode-h264-copy', 'cancel-before-export', 'seek-past-end-resume']);
  return profile === 'smoke' ? scenarios.filter((scenario) => smokeIds.has(scenario.id)) : scenarios;
}

import { activeItems } from './cases.mjs';

const skew = 0.2; // Existing tolerance for seeks performed during playback.
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nativeIdentity = (entry) => Number.isSafeInteger(entry?.frameId) && Number.isSafeInteger(entry?.producerId);

/** Clock observation contains no invented frame observation. */
export function observePlayingSeekClock({ duration, requestedTime, elapsedMs, playerTime, isPlaying, sawMovingClock = false }) {
  if (!finite(duration) || duration <= 0 || !finite(requestedTime) || requestedTime < 0 || requestedTime > duration ||
      !finite(elapsedMs) || elapsedMs < 0 || !finite(playerTime))
    return { matches: false, running: false, atEnd: false, sawMovingClock };
  const expectedTime = Math.min(duration, requestedTime + elapsedMs / 1000);
  const matches = Math.abs(playerTime - expectedTime) < skew;
  const running = matches && playerTime < duration &&
    (isPlaying === true || (isPlaying == null && playerTime > requestedTime + skew));
  return { matches, running, atEnd: expectedTime === duration, sawMovingClock: sawMovingClock || running };
}

/** Playback advances while a decoder seeks. Validate the moving clock and its
 * currently visible items, with a new render and new native frames where the
 * backend supplies identities. No native presentation timestamp is inferred. */
export function assessPlayingSeek({ composition, requestedTime, elapsedMs, before, observation, sawMovingClock = false }) {
  const duration = composition?.duration;
  const clock = observePlayingSeekClock({ duration, requestedTime, elapsedMs,
    playerTime: observation?.playerTime, isPlaying: observation?.isPlaying, sawMovingClock });
  const result = { settled: false, sawMovingClock: clock.sawMovingClock,
    nativeIdentityValidation: 'unavailable', frameValidation: 'unavailable', settlementKind: null };
  if (!clock.matches || !finite(observation?.drawnTime) || Math.abs(observation.drawnTime - observation.playerTime) >= skew ||
      !Number.isSafeInteger(before?.renderSequence) || !Number.isSafeInteger(observation.renderSequence) ||
      observation.renderSequence <= before.renderSequence) return result;

  if (clock.atEnd) {
    if (!clock.sawMovingClock || observation.playerTime < duration || observation.drawnTime < duration ||
        observation.isPlaying === true) return result;
  } else if (!clock.running) return result;

  const expectedIds = activeItems(composition, observation.drawnTime)
    .filter((item) => !item.noFramesExpected).map((item) => item.id);
  const drawnIds = observation.drawnFrameIds;
  if (!Array.isArray(drawnIds) || drawnIds.length !== expectedIds.length ||
      new Set(drawnIds).size !== drawnIds.length || !expectedIds.every((id) => drawnIds.includes(id))) return result;
  let identityVerified = expectedIds.length > 0;
  let identitiesAvailable = expectedIds.length > 0;
  for (const id of expectedIds) {
    const current = observation.frameIdentities?.find((entry) => entry.itemId === id);
    if (!current) return result;
    const previous = before.frameIdentities?.find((entry) => entry.itemId === id);
    if (nativeIdentity(previous) && (!nativeIdentity(current) ||
        (current.frameId === previous.frameId && current.producerId === previous.producerId))) return result;
    if (!nativeIdentity(current)) identitiesAvailable = false;
    if (!nativeIdentity(current) || !nativeIdentity(previous)) identityVerified = false;
  }
  return { settled: true, sawMovingClock: clock.sawMovingClock,
    settlementKind: clock.atEnd ? 'terminal-completion-only' : 'frame-and-clock',
    frameValidation: clock.atEnd ? 'unavailable' : 'frame-presence-and-composition-clock',
    nativeIdentityValidation: identityVerified ? 'verified' : identitiesAvailable ? 'uncompared' : 'unavailable' };
}

/** Run after the latency clock is stopped; retain only bounded plain metadata. */
export function summarizeSeekValidation(result, requestedTime) {
  const state = result?.seekValidation;
  const snapshot = state?.observation;
  const scalar = (key) => finite(snapshot?.[key]) ? snapshot[key] : null;
  const ids = (key) => Array.isArray(snapshot?.[key]) ? snapshot[key].slice(0, 16)
    .filter((id) => typeof id === 'string').map((id) => id.slice(0, 96)) : [];
  const identities = (Array.isArray(snapshot?.frameIdentities) ? snapshot.frameIdentities : [])
    .slice(0, 16).map((entry) => ({ itemId: typeof entry?.itemId === 'string' ? entry.itemId.slice(0, 96) : null,
      frameId: Number.isSafeInteger(entry?.frameId) ? entry.frameId : null,
      producerId: Number.isSafeInteger(entry?.producerId) ? entry.producerId : null }));
  return { requestedTime, elapsedMs: finite(state?.elapsedMs) ? state.elapsedMs : null,
    settlementKind: ['frame-and-clock', 'terminal-completion-only', 'paused-clock-and-item-ids'].includes(state?.settlementKind)
      ? state.settlementKind : 'unavailable',
    frameValidation: ['frame-presence-and-composition-clock', 'clock-and-visible-item-ids'].includes(state?.frameValidation)
      ? state.frameValidation : 'unavailable',
    nativeIdentityValidation: ['verified', 'uncompared'].includes(state?.nativeIdentityValidation)
      ? state.nativeIdentityValidation : 'unavailable',
    playerTime: scalar('playerTime'), drawnTime: scalar('drawnTime'),
    isPlaying: typeof snapshot?.isPlaying === 'boolean' ? snapshot.isPlaying : null,
    renderSequence: scalar('renderSequence'), drawnFrameIds: ids('drawnFrameIds'),
    frameMapIds: ids('frameMapIds'), frameIdentities: identities,
    nativeFramePTS: null, nativeFramePTSReason: 'VideoFrame API does not expose presentation timestamps' };
}

/** Seek first, then resume a clock which stopped naturally. Calling play on an
 * already playing legacy backend can reset its clock, so never do that here. */
export function shouldResumeAfterNaturalEnd({ before, requestedTime, duration }) {
  return before?.isPlaying === false && finite(before.playerTime) && finite(duration) && duration > 0 &&
    before.playerTime >= duration && finite(requestedTime) && requestedTime >= 0 && requestedTime < duration;
}

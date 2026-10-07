// Shared media definitions. Generate locally; never substitute random network media.
export const FIXTURE_SCHEMA = 1;
export const FIXTURES = Object.freeze([
  { id: 'h264-1080p30-audio', file: 'h264-1080p30-audio.mp4', width: 1920, height: 1080, fps: 30, seconds: 8, codec: 'h264', audio: true },
  { id: 'h264-4k30', file: 'h264-4k30.mp4', width: 3840, height: 2160, fps: 30, seconds: 8, codec: 'h264' },
  { id: 'hevc-4k30', file: 'hevc-4k30.mp4', width: 3840, height: 2160, fps: 30, seconds: 8, codec: 'hevc' },
  { id: 'hevc-1080p-hlg10', file: 'hevc-1080p-hlg10.mov', width: 1920, height: 1080, fps: 30, seconds: 6, codec: 'hevc', color: 'bt2020-hlg', bitDepth: 10 },
  { id: 'h264-720p60', file: 'h264-720p60.mp4', width: 1280, height: 720, fps: 60, seconds: 6, codec: 'h264' },
  { id: 'h264-1080p-rot90', file: 'h264-1080p-rot90.mp4', width: 1920, height: 1080, fps: 30, seconds: 6, codec: 'h264', rotation: 90 },
  { id: 'h264-1080x1920', file: 'h264-1080x1920.mp4', width: 1080, height: 1920, fps: 30, seconds: 6, codec: 'h264' },
  { id: 'h264-638x358', file: 'h264-638x358.mp4', width: 638, height: 358, fps: 30, seconds: 6, codec: 'h264' },
  { id: 'h264-720p-short', file: 'h264-720p-short.mp4', width: 1280, height: 720, fps: 30, seconds: 0.5, codec: 'h264' },
  { id: 'hevc-4k30-audio', file: 'hevc-4k30-audio.mp4', width: 3840, height: 2160, fps: 30, seconds: 8, codec: 'hevc', audio: true },
  { id: 'tone', file: 'tone.m4a', seconds: 30, codec: 'aac', audioOnly: true },
  // Additional orientation / presentation-timeline cases from native suites.
  { id: 'h264-720p-rot180', file: 'h264-720p-rot180.mp4', width: 1280, height: 720, fps: 30, seconds: 6, codec: 'h264', rotation: 180 },
  { id: 'hevc-1080p-rot270', file: 'hevc-1080p-rot270.mp4', width: 1920, height: 1080, fps: 30, seconds: 6, codec: 'hevc', rotation: 270 },
  { id: 'h264-slow-motion', file: 'h264-slow-motion.mov', width: 320, height: 240, fps: 30, seconds: 9, codec: 'h264', presentationTimeline: 'native-edit-list', decodedFrames: 180,
    slowMotion: { startSeconds: 1, sourceSeconds: 1, presentationSeconds: 4 } },
]);

export function fixtureById(id) {
  const fixture = FIXTURES.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`Unknown fixture: ${id}`);
  return fixture;
}

/** Read the entire content manifest once on the host, not while timing a draw. */
export function validateFixtureManifest(manifest, requiredIds) {
  if (manifest?.schema !== FIXTURE_SCHEMA || !Array.isArray(manifest.files)) throw new Error('Unsupported fixture manifest');
  const identities = manifest.files.map((entry) => entry.id);
  if (new Set(identities).size !== identities.length) throw new Error('Duplicate fixture identity in manifest');
  for (const id of new Set(requiredIds)) {
    const entry = manifest.files?.find((file) => file.id === id);
    if (!entry) {
      const error = new Error(`Missing verified fixture: ${id}`);
      error.code = 'MISSING_FIXTURE';
      throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0)
      throw new Error(`Invalid verified fixture: ${id}`);
  }
}

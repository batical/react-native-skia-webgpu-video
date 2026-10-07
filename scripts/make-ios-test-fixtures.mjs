import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// The simulator can decode odd JPEG movies but cannot encode them. Generate
// its deterministic test-only asset locally using the actual XCTest writer.
// This does not download media or alter the 14 benchmark fixture definitions.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'ios/tests/LegacyParityTests.mm'), 'utf8');
const start = source.indexOf('namespace {', source.indexOf('#pragma mark - Test videos'));
const end = source.indexOf('#pragma mark - Compositions', start);
if (start < 0 || end < 0) throw new Error('Cannot locate the actual indexed-frame XCTest writer');
const writer = source.slice(start, end);
const directory = join(root, 'ios/tests/fixtures');
mkdirSync(directory, { recursive: true });
const output = join(directory, 'legacy-odd1279x719.mov');
const temporary = mkdtempSync(join(tmpdir(), 'rnskv-test-fixtures-'));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed: ${result.status}`);
  return result.stdout;
}
try {
  const program = `#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#include <algorithm>
#include <vector>
#include <cmath>
#include <cstring>
#include <unistd.h>
#include <iostream>
${writer}
} // namespace
int main(int argc, char** argv) { @autoreleasepool {
  if (argc != 2) return 2;
  VideoSpec spec; spec.width = 1279; spec.height = 719;
  spec.seconds = 1; spec.codec = AVVideoCodecTypeJPEG;
  NSString* error = nil;
  NSString* path = testVideo(spec, &error);
  if (!path) { std::cerr << error.UTF8String << std::endl; return 1; }
  NSString* destination = [NSString stringWithUTF8String:argv[1]];
  [[NSFileManager defaultManager] removeItemAtPath:destination error:nil];
  if (![[NSFileManager defaultManager] copyItemAtPath:path toPath:destination error:nil]) return 1;
  AVURLAsset* asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:destination] options:nil];
  AVAssetTrack* track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
  CMVideoDimensions coded = CMVideoFormatDescriptionGetDimensions((__bridge CMVideoFormatDescriptionRef)track.formatDescriptions.firstObject);
  if (coded.width != 1279 || coded.height != 719) return 1;
  AVAssetReader* reader = [AVAssetReader assetReaderWithAsset:asset error:nil];
  AVAssetReaderTrackOutput* out = [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA)}];
  [reader addOutput:out]; if (![reader startReading]) return 1;
  int frames = 0;
  while (CMSampleBufferRef sample = [out copyNextSampleBuffer]) {
    CVPixelBufferRef pixel = CMSampleBufferGetImageBuffer(sample);
    bool valid = CVPixelBufferGetWidth(pixel) == 1279 && CVPixelBufferGetHeight(pixel) == 719;
    valid = valid && std::abs(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) - frames/30.0) < 0.001;
    if (CVPixelBufferLockBaseAddress(pixel,kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return 1;
    valid = valid && readPattern((const uint8_t*)CVPixelBufferGetBaseAddress(pixel),CVPixelBufferGetBytesPerRow(pixel),1279,719) == frames;
    CVPixelBufferUnlockBaseAddress(pixel,kCVPixelBufferLock_ReadOnly);
    CFRelease(sample); if (!valid) return 1; ++frames;
  }
  if (frames != 30 || reader.status != AVAssetReaderStatusCompleted) return 1;
  std::cout << "{\\"width\\":1279,\\"height\\":719,\\"frames\\":30,\\"fps\\":30,\\"frameIndicesExact\\":true,\\"timestampsExact\\":true}" << std::endl;
  return 0;
}}
`;
  const input = join(temporary, 'fixture.mm');
  const binary = join(temporary, 'fixture');
  writeFileSync(input, program);
  run('clang++', ['-std=c++20', '-fobjc-arc', '-Wno-deprecated-declarations', input,
    '-framework', 'Foundation', '-framework', 'AVFoundation', '-framework', 'CoreVideo',
    '-framework', 'CoreMedia', '-framework', 'CoreGraphics', '-o', binary]);
  const metadata = JSON.parse(run(binary, [output]).trim());
  const bytes = readFileSync(output);
  const proof = { schema: 1, ...metadata, codec: 'jpeg', file: 'legacy-odd1279x719.mov',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    writerSourceSha256: createHash('sha256').update(writer).digest('hex'),
    generatedLocally: true, execution: 'macOS AVFoundation pixel/frame-index/PTS validation' };
  writeFileSync(join(directory, 'legacy-odd1279x719.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

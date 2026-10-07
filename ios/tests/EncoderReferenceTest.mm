#import "VideoEncoderHostObject.h"
#import "NativeResourceStats.h"
#import "VideoCompositionItemDecoder.h"
#include "RNSVMemoryBudget.h"
#import <Foundation/Foundation.h>
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>
#include <thread>
#include <chrono>

namespace RNSkiaVideo {
class NativeEncoderTestDriver {
public:
  static void prepare(VideoEncoderHostObject& encoder) { encoder.prepare(); }
  static void append(VideoEncoderHostObject& encoder, const uint8_t* pixels,
                      int frame, bool rgba) {
    encoder.encodePixels(pixels, 32 * 4, CMTimeMake(frame, 30), rgba);
  }
  static void finish(VideoEncoderHostObject& encoder) { encoder.finish(); }
  static void release(VideoEncoderHostObject& encoder) { encoder.release(); }
};
class NativeFrameTestDriver {
public:
  static bool isRed(VideoFrame& frame) {
    auto buffer = frame.pixelBuffer;
    assert(buffer);
    assert(CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess);
    auto pixels = static_cast<uint8_t*>(CVPixelBufferGetBaseAddress(buffer));
    auto center = pixels + 16 * CVPixelBufferGetBytesPerRow(buffer) + 16 * 4;
    bool red = center[2] > center[0] + 120;
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    return red;
  }
};
}
using namespace RNSkiaVideo;

int main() {
  @autoreleasepool {
    NSString* path = [NSString stringWithFormat:@"/private/tmp/rnskv-encoder-%d.mp4", getpid()];
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    auto baseline = MemoryBudget::instance().snapshot().currentBytes;
    try {
      {
        VideoEncoderHostObject encoder(path.UTF8String, 32, 32, 30, 1000000,
                                        "h264", 128000, 44100, 2, nullptr, false);
        NativeEncoderTestDriver::prepare(encoder);
        std::vector<uint8_t> pixels(32 * 32 * 4);
        for (int frame = 0; frame < 120; ++frame) {
          for (size_t offset = 0; offset < pixels.size(); offset += 4) {
            pixels[offset] = frame % 2 ? 230 : 10; // BGRA: alternating blue/red
            pixels[offset + 1] = 20;
            pixels[offset + 2] = frame % 2 ? 10 : 230;
            pixels[offset + 3] = 255;
          }
          bool rgba = frame % 3 == 2;
          if (rgba) {
            for (size_t offset = 0; offset < pixels.size(); offset += 4)
              std::swap(pixels[offset], pixels[offset + 2]);
          }
          NativeEncoderTestDriver::append(encoder, pixels.data(), frame, rgba);
        }
        NativeEncoderTestDriver::finish(encoder);
        NativeEncoderTestDriver::release(encoder);
        NativeEncoderTestDriver::release(encoder);
      }
    } catch (NSError* error) {
      std::cerr << error.localizedDescription.UTF8String << "\n";
      return 1;
    } catch (const std::exception& error) {
      std::cerr << error.what() << "\n";
      return 1;
    }
    assert(MemoryBudget::instance().snapshot().currentBytes == baseline);
    assert(NativeResourceStats::encoders.current.load() == 0);
    assert(NativeResourceStats::encoderSubmittingBuffers.current.load() == 0);
    AVURLAsset* asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
    AVAssetTrack* track = [[asset tracksWithMediaType:AVMediaTypeVideo] firstObject];
    assert(track);
    NSError* error = nil;
    AVAssetReader* reader = [AVAssetReader assetReaderWithAsset:asset error:&error];
    assert(reader && !error);
    AVAssetReaderTrackOutput* output = [[AVAssetReaderTrackOutput alloc]
        initWithTrack:track outputSettings:@{
          (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA)}];
    [reader addOutput:output];
    assert([reader startReading]);
    int decoded = 0;
    while (CMSampleBufferRef sample = [output copyNextSampleBuffer]) {
      double time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
      assert(fabs(time - decoded / 30.0) < 0.001);
      auto buffer = CMSampleBufferGetImageBuffer(sample);
      assert(CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess);
      auto pixels = static_cast<uint8_t*>(CVPixelBufferGetBaseAddress(buffer));
      auto center = pixels + 16 * CVPixelBufferGetBytesPerRow(buffer) + 16 * 4;
      assert(decoded % 2 ? center[0] > center[2] + 120 : center[2] > center[0] + 120);
      CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
      CFRelease(sample);
      ++decoded;
    }
    assert(reader.status == AVAssetReaderStatusCompleted && decoded == 120);
    auto item = std::make_shared<VideoCompositionItem>();
    item->id = "reference";
    item->path = path.UTF8String;
    item->compositionStartTime = 0;
    item->startTime = 0;
    item->duration = 4;
    item->resolution = CGSizeMake(32, 32);
    item->maxLongSide = 0;
    item->isVideo = true;
    item->directTexture = false;
    {
      // A tenth-second scrub lands inside samples already prefetched for
      // preview. Keeping the reader but clearing those samples loses frame3.
      VideoCompositionItemDecoder decoder(item, true);
      decoder.advanceDecoder(kCMTimeZero);
      auto initial = decoder.acquireFrameForTime(kCMTimeZero, true);
      assert(initial && NativeFrameTestDriver::isRed(*initial));
      initial->releaseBuffer();
      for (int step = 1; step < 10; ++step) {
        CMTime time = CMTimeMake(step, 10);
        decoder.seekTo(time);
        decoder.advanceDecoder(time);
        auto frame = decoder.acquireFrameForTime(time, false);
        assert(frame && NativeFrameTestDriver::isRed(*frame) == (step % 2 == 0));
        frame->releaseBuffer();
      }
      decoder.release();
    }
    {
      VideoCompositionItemDecoder decoder(item, false);
      for (int iteration = 0; iteration < 100; ++iteration) {
        int frameIndex = (iteration * 37) % 110;
        CMTime time = CMTimeMake(frameIndex, 30);
        decoder.seekTo(time);
        decoder.advanceDecoder(time);
        auto frame = decoder.acquireFrameForTime(time, true);
        assert(frame && NativeFrameTestDriver::isRed(*frame) == (frameIndex % 2 == 0));
        frame->releaseBuffer();
        assert(NativeResourceStats::decoderBuffers.current.load() <= 8);
      }
      decoder.release();
    }
    {
      // Preview crossing end -> start preserves the first frame of the loop,
      // while both queued samples and issued frame lifetimes remain bounded.
      VideoCompositionItemDecoder decoder(item, true);
      CMTime end = CMTimeMake(117, 30);
      decoder.seekTo(end);
      decoder.advanceDecoder(end);
      auto last = decoder.acquireFrameForTime(end, true);
      assert(last && !NativeFrameTestDriver::isRed(*last));
      last->releaseBuffer();
      auto first = decoder.acquireFrameForTime(kCMTimeZero, true);
      assert(first && NativeFrameTestDriver::isRed(*first));
      first->releaseBuffer();
      decoder.release();
    }
    {
      // Teardown while a real reader is copying/scaling a sample. Announcing
      // closure stops the batch; cancelReading waits for its current copy.
      // The AVAssetReader context must outlive that native call.
      auto scaled = std::make_shared<VideoCompositionItem>(*item);
      scaled->resolution = CGSizeMake(1280, 720);
      for (int iteration = 0; iteration < 30; ++iteration) {
        auto decoder = std::make_shared<VideoCompositionItemDecoder>(scaled, false);
        std::atomic<bool> entering{false};
        std::thread reading([&] {
          @autoreleasepool {
            entering.store(true);
            decoder->advanceDecoder(CMTimeMake(90, 30));
          }
        });
        while (!entering.load()) std::this_thread::yield();
        usleep(1000);
        auto before = std::chrono::steady_clock::now();
        decoder->release();
        reading.join();
        assert(std::chrono::steady_clock::now() - before < std::chrono::seconds(2));
        assert(!decoder->acquireFrameForTime(kCMTimeZero, true));
        assert(NativeResourceStats::decoderBuffers.current.load() == 0);
        assert(MemoryBudget::instance().snapshot().currentBytes == baseline);
      }
    }
    assert(NativeResourceStats::decoders.current.load() == 0);
    assert(NativeResourceStats::decoderBuffers.current.load() == 0);
    assert(NativeResourceStats::decoderBytes.current.load() == 0);
    assert(NativeResourceStats::frameBuffers.current.load() == 0);
    assert(MemoryBudget::instance().snapshot().currentBytes == baseline);
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    std::cout << "{\"test\":\"ios-reference-encode\",\"frames\":120,"
              << "\"redDecodedFrames\":60,\"blueDecodedFrames\":60,"
              << "\"timestampsMonotonic\":true,\"nativeSeeks\":100,"
              << "\"prefetchedForwardSeeks\":9,"
              << "\"concurrentDecodeDisposeIterations\":30,"
              << "\"loopFrameParity\":true,\"trackedCurrentBytes\":"
              << MemoryBudget::instance().snapshot().currentBytes << "}\n";
  }
}

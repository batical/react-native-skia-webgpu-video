#import "VideoEncoderHostObject.h"
#import "VideoCompositionFramesExtractorSyncHostObject.h"
#import "NativeResourceStats.h"
#include "RNSVMemoryBudget.h"
#include <JSCRuntime.h>
#include <iostream>
#include <limits>
#include <thread>
#include <atomic>
#include <chrono>
#include <vector>

namespace RNSkiaVideo {
class NativeEncoderTestDriver {
public:
  static void prepare(VideoEncoderHostObject& encoder) { encoder.prepare(); }
  static void append(VideoEncoderHostObject& encoder, const uint8_t* pixels, int frame) {
    encoder.encodePixels(pixels, 32 * 4, CMTimeMake(frame, 30));
  }
  static void finish(VideoEncoderHostObject& encoder) { encoder.finish(); }
  static void release(VideoEncoderHostObject& encoder) { encoder.release(); }
  static bool hasWriter(VideoEncoderHostObject& encoder) { return encoder.assetWriter != nil; }
  static size_t actualPoolBufferBytes(VideoEncoderHostObject& encoder) {
    CVPixelBufferRef buffer = NULL;
    if (CVPixelBufferPoolCreatePixelBuffer(NULL, encoder.pixelBufferPool, &buffer) != kCVReturnSuccess)
      throw std::runtime_error("Test could not acquire pool buffer");
    auto bytes = pixelBufferBytes(buffer);
    CVPixelBufferRelease(buffer);
    return bytes;
  }
};
}
using namespace facebook;
using namespace RNSkiaVideo;

static int failures = 0;
static void check(bool condition, const char* label) {
  if (!condition) { ++failures; std::cerr << "FAILED: " << label << '\n'; }
}
static std::string evaluate(jsi::Runtime& runtime, const std::string& expression) {
  return runtime.evaluateJavaScript(
      std::make_shared<jsi::StringBuffer>(expression), "native-validation")
      .asString(runtime).utf8(runtime);
}
static std::string rejection(jsi::Runtime& runtime, const std::string& call) {
  return evaluate(runtime, "try { " + call + "; 'accepted' } catch (error) { String(error) }");
}

int main() {
  @autoreleasepool {
    auto runtime = jsc::makeJSCRuntime();
    auto baseline = MemoryBudget::instance().snapshot();
    auto encoder = std::make_shared<VideoEncoderHostObject>(
        "/private/tmp/unused-native-validation.mp4", 32, 64, 30, 1000000,
        "h264", 128000, 44100, 2, nullptr, false);
    runtime->global().setProperty(*runtime, "encoder",
        jsi::Object::createFromHostObject(*runtime, encoder));
    // No media allocation is needed to prove the descriptor was rejected
    // before a wrapped rowBytes * height can reach the native pixel copy.
    for (const auto& descriptor : {
         "{kind:'bgra',width:32,height:64,data:new ArrayBuffer(1),bytesPerRow:2**58}",
         "{kind:'rgba-pixels',width:32,height:64,pixels:new Uint8Array(1),rowBytes:2**58}",
         "{kind:'rgba-pixels',width:31,height:64,pixels:new Uint8Array(8192),rowBytes:128}"}) {
      auto result = rejection(*runtime, std::string("encoder.encodeFrame(") + descriptor + ",0)");
      check(result.find("Invalid") != std::string::npos,
            "unsafe pixel descriptor must fail storage/dimension validation");
      if (result.find("Invalid") == std::string::npos) std::cerr << result << '\n';
    }
    for (const auto& invalid : {"NaN", "Infinity", "-1", "1.5", "2**53"}) {
      auto descriptor = std::string("{kind:'rgba-pixels',width:32,height:64,pixels:{buffer:new ArrayBuffer(8192),byteOffset:") +
          invalid + ",byteLength:8192},rowBytes:128}";
      check(rejection(*runtime, "encoder.encodeFrame(" + descriptor + ",0)").find("Invalid") != std::string::npos,
            "invalid typed-array offset rejected safely");
      check(rejection(*runtime,
          std::string("encoder.encodeFrame({kind:'bgra',width:32,height:64,data:new ArrayBuffer(8192),bytesPerRow:") +
          invalid + "},0)").find("Invalid") != std::string::npos,
            "invalid stride rejected safely");
    }
    check(rejection(*runtime,
        "encoder.encodeFrame({kind:'rgba-pixels',width:32,height:64,pixels:new Uint8Array(new ArrayBuffer(16384),128,16384-128),rowBytes:256},0)").find("Invalid") != std::string::npos,
          "padded final row beyond view rejected");
    check(rejection(*runtime,
        "encoder.encodeFrame({kind:'rgba-pixels',width:32,height:64,pixels:new Uint8Array(new ArrayBuffer(16512),128,16384),rowBytes:256},0)").find("Encoder not prepared") != std::string::npos,
          "valid padded offset view passes storage validation");
    auto badTime = rejection(*runtime,
        "encoder.encodeFrame({kind:'bgra',width:32,height:64,data:new ArrayBuffer(8192),bytesPerRow:128},NaN)");
    check(badTime.find("seconds") != std::string::npos, "non-finite timestamp rejected before CoreMedia");
    runtime->global().setProperty(*runtime, "encoder", jsi::Value::undefined());
    encoder.reset();

    NSString* path = [NSString stringWithFormat:@"/private/tmp/rnskv-validation-%d.mp4", getpid()];
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    try {
      {
        VideoEncoderHostObject writer(path.UTF8String, 32, 32, 30, 1000000,
                                       "h264", 128000, 44100, 2, nullptr, false);
        NativeEncoderTestDriver::prepare(writer);
        std::vector<uint8_t> pixels(32 * 32 * 4, 255);
        for (int i = 0; i < 10; ++i) NativeEncoderTestDriver::append(writer, pixels.data(), i);
        NativeEncoderTestDriver::finish(writer);
      }
      auto item = std::make_shared<VideoCompositionItem>();
      item->id = "validation"; item->path = path.UTF8String;
      item->compositionStartTime = 0; item->startTime = 0;
      item->duration = 10.0 / 30; item->resolution = CGSizeMake(32, 32);
      auto composition = std::make_shared<VideoComposition>();
      composition->duration = item->duration; composition->items.push_back(item);
      composition->lazyDecoders = true;
      {
        auto extractor = std::make_shared<VideoCompositionFramesExtractorSyncHostObject>(composition);
        runtime->global().setProperty(*runtime, "extractor",
            jsi::Object::createFromHostObject(*runtime, extractor));
        evaluate(*runtime, "extractor.start(); extractor.dispose(); 'closed'");
        auto closedBytes = MemoryBudget::instance().snapshot().currentBytes;
        auto result = rejection(*runtime, "extractor.decodeCompositionFrames(0)");
        check(result.find("disposed") != std::string::npos, "closed extractor cannot reopen through decode");
        check(MemoryBudget::instance().snapshot().currentBytes == closedBytes,
              "decode after dispose cannot allocate native buffers");
        check(rejection(*runtime, "extractor.start()").find("disposed") != std::string::npos,
              "closed extractor cannot reopen through start");
        evaluate(*runtime, "extractor.dispose(); 'closed'");
        runtime->global().setProperty(*runtime, "extractor", jsi::Value::undefined());
      }
      {
        VideoCompositionItemDecoder decoder(item, false);
        decoder.release();
        decoder.seekTo(kCMTimeZero);
        decoder.advanceDecoder(kCMTimeZero);
        auto frame = decoder.acquireFrameForTime(kCMTimeZero, true);
        check(!frame, "closed decoder cannot reopen through an outstanding seek");
      }
      // A failed prepare must promptly cancel a partial writer and release its
      // reservation. It must not wait for this host object to be collected.
      auto failed = std::make_shared<VideoEncoderHostObject>(
          "/private/tmp/missing-rnskv-parent/export.mp4", 32, 32, 30, 1000000,
          "h264", 128000, 44100, 2, nullptr, false);
      runtime->global().setProperty(*runtime, "failedEncoder",
          jsi::Object::createFromHostObject(*runtime, failed));
      rejection(*runtime, "failedEncoder.prepare()");
      check(MemoryBudget::instance().snapshot().currentBytes == baseline.currentBytes,
            "failed prepare releases every reservation while host remains alive");
      runtime->global().setProperty(*runtime, "failedEncoder", jsi::Value::undefined());
      failed.reset();
      {
        NSString* failedPath = [path stringByAppendingString:@"-budget.mp4"];
        [[NSFileManager defaultManager] removeItemAtPath:failedPath error:nil];
        VideoEncoderHostObject exhausted(failedPath.UTF8String, 32, 32, 30, 1000000,
                                         "h264", 128000, 44100, 2, nullptr, false);
        MemoryBudget::instance().configure(1);
        bool rejected = false;
        try { NativeEncoderTestDriver::prepare(exhausted); }
        catch (const std::exception&) { rejected = true; }
        catch (NSError*) { rejected = true; }
        MemoryBudget::instance().configure(baseline.maxBytes);
        check(rejected && !NativeEncoderTestDriver::hasWriter(exhausted),
              "budget refusal happens before a writer starts");
        check(![[NSFileManager defaultManager] fileExistsAtPath:failedPath],
              "budget refusal leaves no partially started output file");
      }
      for (int iteration = 0; iteration < 30; ++iteration) {
        @autoreleasepool {
          NSString* racePath = [path stringByAppendingFormat:@"-race-%d.mp4", iteration];
          [[NSFileManager defaultManager] removeItemAtPath:racePath error:nil];
          VideoEncoderHostObject racing(racePath.UTF8String, 32, 32, 30, 1000000,
                                       "h264", 128000, 44100, 2, nullptr, false);
          NativeEncoderTestDriver::prepare(racing);
          std::atomic<bool> firstSubmitted{false};
          std::thread submit([&] {
            @autoreleasepool {
              std::vector<uint8_t> pixels(32 * 32 * 4, 255);
              try {
                for (int frame = 0; frame < 100; ++frame) {
                  NativeEncoderTestDriver::append(racing, pixels.data(), frame);
                  firstSubmitted = true;
                }
              } catch (NSError*) {} catch (const std::exception&) {}
              firstSubmitted = true;
            }
          });
          while (!firstSubmitted) std::this_thread::yield();
          auto before = std::chrono::steady_clock::now();
          NativeEncoderTestDriver::release(racing);
          submit.join();
          check(std::chrono::steady_clock::now() - before < std::chrono::seconds(2),
                "concurrent disposal cancels encoder waits promptly");
          check(MemoryBudget::instance().snapshot().currentBytes == baseline.currentBytes,
                "concurrent disposal returns every encoder pool reservation");
          [[NSFileManager defaultManager] removeItemAtPath:racePath error:nil];
        }
      }
      {
        NSString* alignedPath = [path stringByAppendingString:@"-aligned.mp4"];
        [[NSFileManager defaultManager] removeItemAtPath:alignedPath error:nil];
        VideoEncoderHostObject aligned(alignedPath.UTF8String, 34, 34, 30, 1000000,
                                       "h264", 128000, 44100, 2, nullptr, false);
        NativeEncoderTestDriver::prepare(aligned);
        auto actual = NativeEncoderTestDriver::actualPoolBufferBytes(aligned);
        check(MemoryBudget::instance().snapshot().currentBytes == baseline.currentBytes + actual * 3,
              "encoder budget covers actual CoreVideo padded stride and storage");
        NativeEncoderTestDriver::release(aligned);
        [[NSFileManager defaultManager] removeItemAtPath:alignedPath error:nil];
      }
    } catch (NSError* error) {
      ++failures; std::cerr << error.localizedDescription.UTF8String << '\n';
    } catch (const std::exception& error) {
      ++failures; std::cerr << error.what() << '\n';
    }
    runtime.reset();
    check(MemoryBudget::instance().snapshot().currentBytes == baseline.currentBytes,
          "final tracked memory matches baseline");
    check(NativeResourceStats::decoderBuffers.current.load() == 0, "no surviving decoder sample");
    check(NativeResourceStats::decoders.current.load() == 0, "no surviving decoder host");
    check(NativeResourceStats::frameBuffers.current.load() == 0, "no surviving native frame lease");
    check(NativeResourceStats::encoders.current.load() == 0, "no surviving encoder host");
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    std::cout << "{\"test\":\"native-validation\",\"failures\":" << failures << "}\n";
    return failures ? 1 : 0;
  }
}

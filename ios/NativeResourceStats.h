#pragma once
#import <CoreVideo/CoreVideo.h>
#include <atomic>
#include <cstdint>
namespace RNSkiaVideo {
struct ResourceCounter {
  std::atomic<uint64_t> current{0};
  std::atomic<uint64_t> peak{0};
  void add(uint64_t amount) {
    uint64_t value = current.fetch_add(amount) + amount;
    uint64_t previous = peak.load();
    while (value > previous && !peak.compare_exchange_weak(previous, value)) {}
  }
  void remove(uint64_t amount) { current.fetch_sub(amount); }
};
struct NativeResourceStats {
  inline static ResourceCounter frameBuffers;
  inline static ResourceCounter frameBytes;
  inline static ResourceCounter decoderBuffers;
  inline static ResourceCounter decoderBytes;
  inline static ResourceCounter decoders;
  inline static ResourceCounter encoders;
  // Codec-owned references after append require process/Instruments measures.
  inline static ResourceCounter encoderSubmittingBuffers;
  inline static ResourceCounter encoderSubmittingBytes;
};
// Composition preview diagnostics, counted since launch: an acquire refused
// while the frame ring is full, an acquire that found no decoded frame queued
// (the decoder not ahead), the decode ticks run, and those over 16 ms.
struct PreviewStats {
  inline static std::atomic<uint64_t> ringRefusals{0};
  inline static std::atomic<uint64_t> emptyQueues{0};
  inline static std::atomic<uint64_t> decodeTicks{0};
  inline static std::atomic<uint64_t> slowDecodeTicks{0};
};
inline size_t pixelBufferBytes(CVPixelBufferRef buffer) {
  size_t bytes = CVPixelBufferGetDataSize(buffer);
  return bytes ? bytes : CVPixelBufferGetBytesPerRow(buffer) *
                             CVPixelBufferGetHeight(buffer);
}
} // namespace RNSkiaVideo

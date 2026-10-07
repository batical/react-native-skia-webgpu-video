// Based on the MIT-licensed Skia Video implementation by François de Campredon.
#pragma once

#import <CoreVideo/CoreVideo.h>
#import <jsi/jsi.h>
#include <list>
#include <memory>
#include <mutex>

namespace RNSkiaVideo {
using namespace facebook;

/**
 * Scoped immutable decoder buffer. The pointer is a CVPixelBufferRef, never
 * a Metal texture or IOSurfaceRef. Complete sampling (or make an owned image
 * and wait for that copy) before dispose(). No age-based buffer retirement.
 */
class JSI_EXPORT VideoFrame : public jsi::HostObject,
                             public std::enable_shared_from_this<VideoFrame> {
public:
  VideoFrame(CVPixelBufferRef buffer, double width, double height, int rotation,
             uint64_t producerId, uint64_t transferredMemoryToken = 0);
  ~VideoFrame() override;
  void releaseBuffer();
  bool hasBuffer() const;
  size_t bufferBytes() const;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override;
  jsi::Value get(jsi::Runtime&, const jsi::PropNameID& name) override;

private:
#if defined(RNSV_NATIVE_TESTS)
  friend class NativeFrameTestDriver;
#endif
  mutable std::mutex mutex;
  CVPixelBufferRef pixelBuffer = NULL;
  size_t bytes = 0;
  uint64_t memoryToken = 0;
  uint64_t frameId;
  uint64_t producerId;
  double width;
  double height;
  int rotation;
};

/**
 * Compatibility name for the bounded outstanding-frame registry. Weak entries
 * free their slot after disposal/collection. Full means backpressure; a live
 * consumer buffer is never destroyed to admit another frame.
 */
class VideoFrameRing {
public:
  explicit VideoFrameRing(size_t capacity = 2) : capacity(capacity) {}
  bool canAcquire();
  void push(const std::shared_ptr<VideoFrame>& frame);
  // Stop tracking; outstanding consumers retain their own immutable buffer.
  void releaseAll();

private:
  std::mutex mutex;
  size_t capacity;
  std::list<std::weak_ptr<VideoFrame>> frames;
  void removeReleased();
};

uint64_t allocateVideoProducerId();
} // namespace RNSkiaVideo

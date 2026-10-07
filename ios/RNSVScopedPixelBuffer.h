#pragma once
#import <CoreVideo/CoreVideo.h>

namespace RNSkiaVideo {
// Adopts the +1 returned by CoreVideo/AVPlayer copy APIs. The owner always
// releases it, including when reserving a frame lease throws.
class ScopedPixelBuffer {
public:
  explicit ScopedPixelBuffer(CVPixelBufferRef buffer) : buffer(buffer) {}
  ~ScopedPixelBuffer() { if (buffer) CVPixelBufferRelease(buffer); }
  ScopedPixelBuffer(const ScopedPixelBuffer&) = delete;
  ScopedPixelBuffer& operator=(const ScopedPixelBuffer&) = delete;
  CVPixelBufferRef get() const { return buffer; }
private:
  CVPixelBufferRef buffer;
};
}

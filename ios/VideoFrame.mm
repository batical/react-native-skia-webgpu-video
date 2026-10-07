// Based on the MIT-licensed Skia Video implementation by François de Campredon.
#import "VideoFrame.h"
#import "NativeResourceStats.h"
#include "RNSVMemoryBudget.h"
#include <atomic>
#include <stdexcept>

namespace RNSkiaVideo {
static std::atomic<uint64_t> nextFrameId{1};
static std::atomic<uint64_t> nextProducerId{1};
uint64_t allocateVideoProducerId() { return nextProducerId.fetch_add(1); }

VideoFrame::VideoFrame(CVPixelBufferRef buffer, double, double, int rotation,
                       uint64_t producerId, uint64_t transferredMemoryToken)
    : frameId(nextFrameId.fetch_add(1)), producerId(producerId),
      width(CVPixelBufferGetWidth(buffer)), height(CVPixelBufferGetHeight(buffer)),
      rotation(rotation) {
  bytes = pixelBufferBytes(buffer);
  memoryToken = transferredMemoryToken ? transferredMemoryToken :
      MemoryBudget::instance().reserve(bytes, "iOS decoded frame");
  pixelBuffer = CVPixelBufferRetain(buffer);
  NativeResourceStats::frameBuffers.add(1);
  NativeResourceStats::frameBytes.add(bytes);
}
VideoFrame::~VideoFrame() { releaseBuffer(); }
void VideoFrame::releaseBuffer() {
  std::lock_guard<std::mutex> guard(mutex);
  if (pixelBuffer) {
    CVPixelBufferRelease(pixelBuffer);
    pixelBuffer = NULL;
    NativeResourceStats::frameBuffers.remove(1);
    NativeResourceStats::frameBytes.remove(bytes);
    MemoryBudget::instance().release(memoryToken);
    memoryToken = 0;
  }
}
bool VideoFrame::hasBuffer() const {
  std::lock_guard<std::mutex> guard(mutex);
  return pixelBuffer != NULL;
}
size_t VideoFrame::bufferBytes() const { return bytes; }
void VideoFrameRing::removeReleased() {
  for (auto it = frames.begin(); it != frames.end();) {
    auto frame = it->lock();
    if (!frame || !frame->hasBuffer()) it = frames.erase(it);
    else ++it;
  }
}
bool VideoFrameRing::canAcquire() {
  std::lock_guard<std::mutex> guard(mutex);
  removeReleased();
  return frames.size() < capacity;
}
void VideoFrameRing::push(const std::shared_ptr<VideoFrame>& frame) {
  std::lock_guard<std::mutex> guard(mutex);
  removeReleased();
  if (frames.size() >= capacity) {
    throw std::runtime_error("Native video frame capacity reached; dispose "
                             "consumed frames after completing GPU work");
  }
  frames.push_back(frame);
}
void VideoFrameRing::releaseAll() {
  std::lock_guard<std::mutex> guard(mutex);
  // Removing the producer cannot revoke a consumer already sampling this
  // buffer. Its explicit dispose()/final shared owner releases the lease.
  frames.clear();
}
std::vector<jsi::PropNameID> VideoFrame::getPropertyNames(jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> result;
  for (const auto* name : {"id", "producerId", "width", "height", "rotation",
                           "texture", "nativeBuffer", "dispose"}) {
    result.push_back(jsi::PropNameID::forAscii(rt, name));
  }
  return result;
}
jsi::Value VideoFrame::get(jsi::Runtime& runtime,
                          const jsi::PropNameID& propNameId) {
  auto name = propNameId.utf8(runtime);
  if (name == "id") return jsi::Value(static_cast<double>(frameId));
  if (name == "producerId") return jsi::Value(static_cast<double>(producerId));
  if (name == "width") return jsi::Value(width);
  if (name == "height") return jsi::Value(height);
  if (name == "rotation") return jsi::Value(rotation);
  if (name == "dispose") {
    std::weak_ptr<VideoFrame> weak = shared_from_this();
    return jsi::Function::createFromHostFunction(
        runtime, jsi::PropNameID::forAscii(runtime, "dispose"), 0,
        [weak](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
          if (auto frame = weak.lock()) frame->releaseBuffer();
          return jsi::Value::undefined();
        });
  }
  if (name == "texture" || name == "nativeBuffer") {
    std::lock_guard<std::mutex> guard(mutex);
    if (!pixelBuffer) return jsi::Value::undefined();
    auto pointer = jsi::BigInt::fromUint64(
        runtime, reinterpret_cast<uintptr_t>(pixelBuffer));
    if (name == "nativeBuffer") return pointer;
    auto descriptor = jsi::Object(runtime);
    descriptor.setProperty(runtime, "kind",
                           jsi::String::createFromAscii(runtime, "native-buffer"));
    descriptor.setProperty(runtime, "nativeBuffer", pointer);
    return descriptor;
  }
  return jsi::Value::undefined();
}
} // namespace RNSkiaVideo

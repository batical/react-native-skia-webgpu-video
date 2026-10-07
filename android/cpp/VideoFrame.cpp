#include "VideoFrame.h"
#include <limits>

namespace RNSkiaVideo {
namespace {
// Shared Java backing has one budget reservation, regardless of the number
// of Java slices or JS ArrayBuffer aliases. This global root keeps its JNI
// buffer alive; the two-phase Java reaper releases the budget after backing GC.
class OwnedRgbaBuffer final : public jsi::MutableBuffer {
 public:
  OwnedRgbaBuffer(alias_ref<JByteBuffer> pixels, uint8_t* bytes, size_t size)
      : pixels_(make_global(pixels)), bytes_(bytes), size_(size) {}
  ~OwnedRgbaBuffer() override {
    // Hermes may finalize an external ArrayBuffer on a GC worker.
    ThreadScope attached;
    pixels_.reset();
  }
  size_t size() const override { return size_; }
  uint8_t* data() override { return bytes_; }
 private:
  global_ref<JByteBuffer> pixels_;
  uint8_t* const bytes_;
  const size_t size_;
};
}

jint VideoFrame::getWidth() {
  static const auto method = getClass()->getMethod<jint()>("getWidth");
  return method(self());
}
jint VideoFrame::getHeight() {
  static const auto method = getClass()->getMethod<jint()>("getHeight");
  return method(self());
}
jint VideoFrame::getRotation() {
  static const auto method = getClass()->getMethod<jint()>("getRotation");
  return method(self());
}
jint VideoFrame::getBytesPerRow() {
  static const auto method = getClass()->getMethod<jint()>("getBytesPerRow");
  return method(self());
}
jlong VideoFrame::getTimestampNs() {
  static const auto method = getClass()->getMethod<jlong()>("getTimestampNs");
  return method(self());
}
jlong VideoFrame::getId() {
  static const auto method = getClass()->getMethod<jlong()>("getId");
  return method(self());
}
jlong VideoFrame::getProducerId() {
  static const auto method = getClass()->getMethod<jlong()>("getProducerId");
  return method(self());
}
local_ref<JByteBuffer> VideoFrame::getPixelBuffer() {
  static const auto method = getClass()->getMethod<JByteBuffer()>("getPixelBuffer");
  return method(self());
}

jsi::Value VideoFrame::toJS(jsi::Runtime& runtime) {
  const auto width = getWidth();
  const auto height = getHeight();
  const auto stride = getBytesPerRow();
  auto pixels = getPixelBuffer();
  auto* env = Environment::current();
  const auto capacity = env->GetDirectBufferCapacity(pixels.get());
  auto* bytes = static_cast<uint8_t*>(env->GetDirectBufferAddress(pixels.get()));
  const size_t size = static_cast<size_t>(stride) * static_cast<size_t>(height);
  if (width <= 0 || height <= 0 || stride != static_cast<int64_t>(width) * 4 ||
      capacity < 0 || size != static_cast<size_t>(capacity) || !bytes) {
    throw jsi::JSError(runtime, "Invalid owned Android RGBA frame");
  }
  auto owned = std::make_shared<OwnedRgbaBuffer>(pixels, bytes, size);

  auto frame = jsi::Object(runtime);
  frame.setProperty(runtime, "id", static_cast<double>(getId()));
  frame.setProperty(runtime, "producerId", static_cast<double>(getProducerId()));
  frame.setProperty(runtime, "width", width);
  frame.setProperty(runtime, "height", height);
  frame.setProperty(runtime, "rotation", getRotation());
  frame.setProperty(runtime, "timestamp", static_cast<double>(getTimestampNs()) / 1e9);
  auto texture = jsi::Object(runtime);
  texture.setProperty(runtime, "kind", jsi::String::createFromAscii(runtime, "rgba"));
  texture.setProperty(runtime, "width", width);
  texture.setProperty(runtime, "height", height);
  texture.setProperty(runtime, "bytesPerRow", stride);
  auto data = jsi::ArrayBuffer(runtime, std::move(owned));
  data.setExternalMemoryPressure(runtime, size);
  texture.setProperty(runtime, "data", std::move(data));
  frame.setProperty(runtime, "texture", std::move(texture));
  // Drop the frame's ArrayBuffer reference after MakeImage has copied it.
  // Other ArrayBuffer aliases remain valid and keep their accounted storage;
  // this never frees bytes while a JS typed array can still read them.
  frame.setProperty(runtime, "dispose", jsi::Function::createFromHostFunction(runtime,
    jsi::PropNameID::forAscii(runtime, "dispose"), 0,
    [](jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value*, size_t) -> jsi::Value {
      if (thisValue.isObject()) {
        auto value = thisValue.asObject(rt).getProperty(rt, "texture");
        if (value.isObject()) value.asObject(rt).setProperty(rt, "data", jsi::Value::undefined());
      }
      return jsi::Value::undefined();
    }));
  return frame;
}
} // namespace RNSkiaVideo

#include "VideoFrame.h"
#include "RgbaFrameLease.h"
#include "NativeHardwareBuffer.h"
#include <limits>

namespace RNSkiaVideo {
namespace {
// Shared Java backing has one budget reservation, regardless of the number
// of Java slices or JS ArrayBuffer aliases. This global root keeps its JNI
// buffer alive; the two-phase Java reaper releases the budget after backing GC.
class OwnedRgbaBuffer final : public jsi::MutableBuffer, public RgbaFrameStorage {
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

class FramePixelState final {
 public:
  explicit FramePixelState(std::shared_ptr<OwnedRgbaBuffer> pixels)
      : lease_(std::move(pixels)) {}

  jsi::Value data(jsi::Runtime& runtime) {
    auto storage = lease_.storage();
    if (!storage) return jsi::Value::undefined();
    auto pixels = std::static_pointer_cast<OwnedRgbaBuffer>(storage);
    auto data = jsi::ArrayBuffer(runtime, std::move(pixels));
    data.setExternalMemoryPressure(runtime, storage->size());
    return data;
  }

  void copyTo(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count) {
    if (count != 1 || !arguments[0].isObject() ||
        !arguments[0].asObject(runtime).isArrayBuffer(runtime))
      throw jsi::JSError(runtime, "RGBA copyPixelsTo requires one ArrayBuffer destination");
    auto destination = arguments[0].asObject(runtime).getArrayBuffer(runtime);
    try {
      lease_.copyTo(destination.data(runtime), destination.size(runtime));
    } catch (const std::exception& error) {
      throw jsi::JSError(runtime, error.what());
    }
  }

  void dispose() {
    lease_.dispose();
  }

 private:
  RgbaFrameLease lease_;
};

class HardwareFrameState final {
 public:
  explicit HardwareFrameState(std::shared_ptr<HardwareFrameStorage> owner)
      : owner_(std::move(owner)) {}
  jsi::Value pointer(jsi::Runtime& runtime) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!owner_) throw jsi::JSError(runtime, "Hardware video frame is disposed");
    return jsi::BigInt::fromUint64(runtime, reinterpret_cast<uintptr_t>(owner_->buffer));
  }
  void dispose() {
    std::lock_guard<std::mutex> lock(mutex_);
    owner_.reset();
  }
 private:
  std::mutex mutex_;
  std::shared_ptr<HardwareFrameStorage> owner_;
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
jboolean VideoFrame::isHardwareBuffer() {
  static const auto method = getClass()->getMethod<jboolean()>("isHardwareBuffer");
  return method(self());
}
jlong VideoFrame::getNativeHardwareBufferHandle() {
  static const auto method = getClass()->getMethod<jlong()>("getNativeHardwareBufferHandle");
  return method(self());
}
void VideoFrame::close() {
  static const auto method = getClass()->getMethod<void()>("close");
  method(self());
}

jsi::Value VideoFrame::toJS(jsi::Runtime& runtime) {
  try {
    auto result = toJSInternal(runtime);
    close();
    return result;
  } catch (...) { close(); throw; }
}

jsi::Value VideoFrame::toJSInternal(jsi::Runtime& runtime) {
  const auto width = getWidth();
  const auto height = getHeight();
  const auto stride = getBytesPerRow();
  if (isHardwareBuffer()) {
    auto owner = acquireHardwareFrame(getNativeHardwareBufferHandle());
    if (width <= 0 || height <= 0 || owner->description.width != static_cast<uint32_t>(width) ||
        owner->description.height != static_cast<uint32_t>(height) ||
        owner->description.layers != 1 ||
        owner->description.format != AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM)
      throw jsi::JSError(runtime, "Invalid owned Android hardware frame");
    const uint64_t bytes = static_cast<uint64_t>(owner->description.stride) * height * 4;
    auto state = std::make_shared<HardwareFrameState>(std::move(owner));
    auto frame = jsi::Object(runtime);
    frame.setProperty(runtime, "id", static_cast<double>(getId()));
    frame.setProperty(runtime, "producerId", static_cast<double>(getProducerId()));
    frame.setProperty(runtime, "width", width); frame.setProperty(runtime, "height", height);
    frame.setProperty(runtime, "rotation", getRotation());
    frame.setProperty(runtime, "timestamp", static_cast<double>(getTimestampNs()) / 1e9);
    auto holder = jsi::Object(runtime);
    holder.setExternalMemoryPressure(runtime, bytes);
    auto texture = jsi::Object(runtime);
    texture.setProperty(runtime, "kind", jsi::String::createFromAscii(runtime, "native-buffer"));
    auto getter = jsi::Function::createFromHostFunction(runtime,
      jsi::PropNameID::forAscii(runtime, "nativeBuffer"), 0,
      [state](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value {
        return state->pointer(rt);
      });
    auto descriptor = jsi::Object(runtime);
    descriptor.setProperty(runtime, "enumerable", true);
    descriptor.setProperty(runtime, "get", getter.getPropertyAsFunction(runtime, "bind")
        .callWithThis(runtime, getter, holder));
    runtime.global().getPropertyAsObject(runtime, "Object")
        .getPropertyAsFunction(runtime, "defineProperty")
        .call(runtime, texture, jsi::String::createFromAscii(runtime, "nativeBuffer"), descriptor);
    frame.setProperty(runtime, "texture", std::move(texture));
    auto dispose = jsi::Function::createFromHostFunction(runtime,
      jsi::PropNameID::forAscii(runtime, "dispose"), 0,
      [state](jsi::Runtime& rt, const jsi::Value& receiver, const jsi::Value*, size_t) -> jsi::Value {
        try { receiver.asObject(rt).setExternalMemoryPressure(rt, 0); }
        catch (...) { state->dispose(); throw; }
        state->dispose();
        return jsi::Value::undefined();
      });
    frame.setProperty(runtime, "dispose", dispose.getPropertyAsFunction(runtime, "bind")
        .callWithThis(runtime, dispose, holder));
    return frame;
  }
  auto pixels = getPixelBuffer();
  auto* env = Environment::current();
  const auto capacity = env->GetDirectBufferCapacity(pixels.get());
  auto* bytes = static_cast<uint8_t*>(env->GetDirectBufferAddress(pixels.get()));
  const size_t size = static_cast<size_t>(stride) * static_cast<size_t>(height);
  if (width <= 0 || height <= 0 || stride != static_cast<int64_t>(width) * 4 ||
      capacity < 0 || size != static_cast<size_t>(capacity) || !bytes) {
    throw jsi::JSError(runtime, "Invalid owned Android RGBA frame");
  }
  auto state = std::make_shared<FramePixelState>(
      std::make_shared<OwnedRgbaBuffer>(pixels, bytes, size));

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
  auto copyPixelsTo = jsi::Function::createFromHostFunction(runtime,
    jsi::PropNameID::forAscii(runtime, "copyPixelsTo"), 1,
    [state](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
      state->copyTo(rt, args, count);
      return jsi::Value::undefined();
    });
  auto descriptor = jsi::Object(runtime);
  descriptor.setProperty(runtime, "enumerable", true);
  // Cache only in a GC-traced JS object. A C++ strong ArrayBuffer handle would
  // leak a cycle if a consumer attached its frame/texture to that ArrayBuffer.
  auto cache = jsi::Object(runtime);
  cache.setProperty(runtime, "data", jsi::Value::undefined());
  // The normal scoped-copy path still owns native Java storage until dispose.
  // Credit that real ownership even if no external ArrayBuffer is materialized.
  cache.setExternalMemoryPressure(runtime, size);
  texture.setProperty(runtime, "copyPixelsTo",
      copyPixelsTo.getPropertyAsFunction(runtime, "bind")
          .callWithThis(runtime, copyPixelsTo, cache));
  auto getter = jsi::Function::createFromHostFunction(runtime,
    jsi::PropNameID::forAscii(runtime, "data"), 0,
    [state](jsi::Runtime& rt, const jsi::Value& receiver, const jsi::Value*, size_t) -> jsi::Value {
      auto holder = receiver.asObject(rt);
      auto cached = holder.getProperty(rt, "data");
      if (!cached.isUndefined()) return cached;
      auto data = state->data(rt);
      holder.setProperty(rt, "data", data);
      // Materialized data has its own pressure credit and can outlive the frame.
      // Transfer instead of persistently crediting two aliases of one backing.
      holder.setExternalMemoryPressure(rt, 0);
      return data;
    });
  // Bound receivers are JS edges traced by Hermes. Extracted accessors and
  // dispose functions retain the correct holder without C++ -> JS roots.
  auto boundGetter = getter.getPropertyAsFunction(runtime, "bind")
      .callWithThis(runtime, getter, cache);
  descriptor.setProperty(runtime, "get", std::move(boundGetter));
  // A getter materializes the legacy external buffer only when explicitly read.
  // Normal rendering copies into one reusable JS scratch and creates no per-frame
  // external ArrayBuffer root coupling Java's heap to Hermes' GC schedule.
  runtime.global().getPropertyAsObject(runtime, "Object")
      .getPropertyAsFunction(runtime, "defineProperty")
      .call(runtime, texture, jsi::String::createFromAscii(runtime, "data"), descriptor);
  frame.setProperty(runtime, "texture", std::move(texture));
  // Release the frame's JNI root promptly, including an extracted dispose call.
  // Explicit data aliases hold their own shared storage and remain valid.
  auto dispose = jsi::Function::createFromHostFunction(runtime,
    jsi::PropNameID::forAscii(runtime, "dispose"), 0,
    [state](jsi::Runtime& rt, const jsi::Value& receiver, const jsi::Value*, size_t) -> jsi::Value {
      try {
        auto holder = receiver.asObject(rt);
        holder.setProperty(rt, "data", jsi::Value::undefined());
        holder.setExternalMemoryPressure(rt, 0);
      } catch (...) {
        state->dispose();
        throw;
      }
      state->dispose();
      return jsi::Value::undefined();
    });
  frame.setProperty(runtime, "dispose", dispose.getPropertyAsFunction(runtime, "bind")
      .callWithThis(runtime, dispose, cache));
  return frame;
}
} // namespace RNSkiaVideo

#include "RNSVCheckedSizes.h"
#include "VideoEncoderHostObject.h"
#include <android/data_space.h>
#include <android/native_window_jni.h>
#include <dlfcn.h>
#include <fbjni/ByteBuffer.h>
#include <cmath>
#include <limits>

namespace RNSkiaVideo {
using namespace facebook::jni;

namespace {
struct JSurface : JavaClass<JSurface> {
  static constexpr auto kJavaDescriptor = "Landroid/view/Surface;";
};

/**
 * Sets the presentation time of the next buffer queued to a window, as
 * eglPresentationTimeANDROID does: the codec reads it as the frame's time.
 * libnativewindow exports it on Android 10 and later, though the NDK does not
 * declare it (it is in the LL-NDK); null where it is missing.
 */
using SetBuffersTimestamp = int32_t (*)(ANativeWindow*, int64_t);
SetBuffersTimestamp setBuffersTimestamp() {
  static const auto function = []() -> SetBuffersTimestamp {
    void* library = dlopen("libnativewindow.so", RTLD_NOW);
    return library == nullptr ? nullptr
                              : reinterpret_cast<SetBuffersTimestamp>(dlsym(
                                    library, "ANativeWindow_setBuffersTimestamp"));
  }();
  return function;
}
} // namespace

local_ref<VideoEncoder>
VideoEncoder::create(std::string& outPath, int width, int height, int frameRate,
                     int bitRate, std::optional<std::string> encoderName,
                     std::optional<std::string> codec,
                     alias_ref<VideoComposition> composition,
                     int audioSampleRate, int audioChannelCount,
                     int audioBitRate) {
  // Both strings are nullable on the Java side (a null codec means H.264), so
  // they are built as jstring refs rather than handed over as std::string: a
  // ternary mixing std::string and nullptr collapses to std::string, and
  // constructing one from nullptr calls strlen(nullptr).
  auto encoderNameRef = encoderName.has_value()
                            ? make_jstring(encoderName.value())
                            : local_ref<JString>(nullptr);
  auto codecRef = codec.has_value() ? make_jstring(codec.value())
                                    : local_ref<JString>(nullptr);
  return newInstance(outPath, width, height, frameRate, bitRate,
                     encoderNameRef, codecRef, composition, audioSampleRate,
                     audioChannelCount, audioBitRate);
}

bool VideoEncoder::isCodecSupported(const std::string& codec) {
  static const auto method =
      javaClassStatic()->getStaticMethod<jboolean(std::string)>(
          "isCodecSupported");
  return method(javaClassStatic(), codec);
}

void VideoEncoder::prepare() const {
  static const auto prepareMethod = getClass()->getMethod<void()>("prepare");
  prepareMethod(self());
}

void VideoEncoder::encodeFrameRgba(alias_ref<JByteBuffer> pixels, jint width,
                                   jint height, jint bytesPerRow, jdouble time) const {
  static const auto method =
      getClass()->getMethod<void(alias_ref<JByteBuffer>, jint, jint, jint, jdouble)>("encodeFrameRgba");
  method(self(), pixels, width, height, bytesPerRow, time);
}

local_ref<jobject> VideoEncoder::getInputSurface() const {
  static const auto method =
      getClass()->getMethod<JSurface::javaobject()>("getInputSurface");
  auto surface = method(self());
  return make_local(static_cast<jobject>(surface.get()));
}

jlong VideoEncoder::beginWindowFrame(jdouble time) const {
  static const auto method = getClass()->getMethod<jlong(jdouble)>("beginWindowFrame");
  return method(self(), time);
}

void VideoEncoder::endWindowFrame(jlong timeUs) const {
  static const auto method = getClass()->getMethod<void(jlong)>("endWindowFrame");
  method(self(), timeUs);
}

void VideoEncoder::release() const {
  static const auto releaseMethod = getClass()->getMethod<void()>("release");
  releaseMethod(self());
}

void VideoEncoder::finishWriting() const {
  static const auto finishWritingMethod =
      getClass()->getMethod<void()>("finishWriting");
  finishWritingMethod(self());
}

VideoEncoderHostObject::VideoEncoderHostObject(
    std::string& outPath, int width, int height, int frameRate, int bitRate,
    std::optional<std::string> encoderName, std::optional<std::string> codec,
    alias_ref<VideoComposition> composition, int audioSampleRate,
    int audioChannelCount, int audioBitRate) {
  framesExtractor = make_global(VideoEncoder::create(
      outPath, width, height, frameRate, bitRate, encoderName, codec,
      composition, audioSampleRate, audioChannelCount, audioBitRate));
  hints = std::make_unique<ExportHintSession>(frameRate);
}

VideoEncoderHostObject::~VideoEncoderHostObject() {
  this->release();
}

std::vector<jsi::PropNameID>
VideoEncoderHostObject::getPropertyNames(jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> result;
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("prepare")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("encodeFrame")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("acquireInputWindow")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("finishWriting")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("dispose")));
  return result;
}

// The methods are created once per runtime (see RNSVHostObject):
// `encodeFrame` is read for every exported frame.
jsi::Value VideoEncoderHostObject::get(jsi::Runtime& runtime,
                                       const jsi::PropNameID& propNameId) {
  auto propName = propNameId.utf8(runtime);
  if (propName == "encodeFrame") {
    return getFunction(
        runtime, propName, 2,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(encoderMutex);
          if (released.test() || !prepared || finished) {
            throw jsi::JSError(runtime, "Video encoder is not ready to accept frames");
          }
          if (count != 2 || !arguments[0].isObject() || !arguments[1].isNumber()) {
            throw jsi::JSError(runtime, "encodeFrame expects an owned RGBA descriptor and a time");
          }
          auto frame = arguments[0].asObject(runtime);
          const auto kindValue = frame.getProperty(runtime, "kind");
          const auto kind = kindValue.isString() ? kindValue.asString(runtime).utf8(runtime) : "";
          if (kind == "window") {
            // The GPU export rendered the frame into the canvas context of the
            // input window: `present` queues it, with the time set here.
            if (window == nullptr)
              throw jsi::JSError(runtime, "Encoder input window was not acquired");
            auto present = frame.getProperty(runtime, "present");
            if (!present.isObject() || !present.asObject(runtime).isFunction(runtime))
              throw jsi::JSError(runtime, "A window frame needs its present function");
            const auto time = checkedMediaSeconds(arguments[1].asNumber());
            const auto timeUs = framesExtractor->beginWindowFrame(time);
            // The swapchain tags its buffers sRGB, full range, and the codec
            // would encode and label the file so. Unknown, as EGL leaves it,
            // lets the codec use its default: Rec.709, limited range. Set for
            // every frame, as a recreated swapchain tags the window again.
            if (ANativeWindow_setBuffersDataSpace(window, ADATASPACE_UNKNOWN) != 0)
              throw jsi::JSError(runtime, "Cannot set the encoder frame dataspace");
            if (setBuffersTimestamp()(window, static_cast<int64_t>(timeUs) * 1000) != 0)
              throw jsi::JSError(runtime, "Cannot set the encoder frame time");
            present.asObject(runtime).asFunction(runtime).call(runtime);
            framesExtractor->endWindowFrame(timeUs);
            hints->frameDone();
            return jsi::Value::undefined();
          }
          if (kind != "rgba") {
            throw jsi::JSError(runtime, "Android encoder accepts RGBA pixels or a window frame");
          }
          const auto checkedInteger = [&](const char* name) -> int {
            const auto value = frame.getProperty(runtime, name).asNumber();
            if (!std::isfinite(value) || value <= 0 || std::floor(value) != value ||
                value > std::numeric_limits<int>::max()) {
              throw jsi::JSError(runtime, "Invalid encoder RGBA dimensions or stride");
            }
            return static_cast<int>(value);
          };
          const int width = checkedInteger("width");
          const int height = checkedInteger("height");
          const int stride = checkedInteger("bytesPerRow");
          const uint64_t packedStride = static_cast<uint64_t>(width) * 4;
          const uint64_t required = static_cast<uint64_t>(stride) * (height - 1) + packedStride;
          if (static_cast<uint64_t>(stride) < packedStride || required > std::numeric_limits<int>::max()) {
            throw jsi::JSError(runtime, "Invalid encoder RGBA byte layout");
          }
          auto data = frame.getProperty(runtime, "data").asObject(runtime);
          size_t offset = 0;
          size_t length = 0;
          jsi::ArrayBuffer buffer = [&]() {
            if (data.isArrayBuffer(runtime)) {
              auto result = data.getArrayBuffer(runtime);
              length = result.size(runtime);
              return result;
            }
            auto raw = data.getProperty(runtime, "buffer").asObject(runtime).getArrayBuffer(runtime);
            const auto offsetValue = data.getProperty(runtime, "byteOffset").asNumber();
            const auto lengthValue = data.getProperty(runtime, "byteLength").asNumber();
            if (!std::isfinite(offsetValue) || !std::isfinite(lengthValue) || offsetValue < 0 ||
                lengthValue < 0 || std::floor(offsetValue) != offsetValue ||
                std::floor(lengthValue) != lengthValue || offsetValue > raw.size(runtime) ||
                lengthValue > raw.size(runtime) - offsetValue) {
              throw jsi::JSError(runtime, "Invalid encoder RGBA byte view");
            }
            offset = static_cast<size_t>(offsetValue);
            length = static_cast<size_t>(lengthValue);
            return raw;
          }();
          if (length < required) {
            throw jsi::JSError(runtime, "Encoder RGBA data is too short");
          }
          auto javaPixels = JByteBuffer::wrapBytes(buffer.data(runtime) + offset, required);
          framesExtractor->encodeFrameRgba(javaPixels, width, height, stride, checkedMediaSeconds(arguments[1].asNumber()));
          return jsi::Value::undefined();
        });
  } else if (propName == "acquireInputWindow") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(encoderMutex);
          if (released.test() || !prepared || finished) {
            throw jsi::JSError(runtime, "Encoder not prepared");
          }
          // Without it, every frame would carry the time it was queued at.
          if (setBuffersTimestamp() == nullptr) {
            throw jsi::JSError(runtime, "Encoder frame times need Android 10 or later");
          }
          if (window == nullptr) {
            auto surface = framesExtractor->getInputSurface();
            window = ANativeWindow_fromSurface(Environment::current(), surface.get());
            if (window == nullptr)
              throw jsi::JSError(runtime, "Cannot get the encoder input window");
          }
          return jsi::BigInt::fromUint64(runtime, reinterpret_cast<uintptr_t>(window));
        });
  } else if (propName == "prepare") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(encoderMutex);
          if (!released.test() && !prepared) {
            framesExtractor->prepare();
            prepared = true;
          }
          return jsi::Value::undefined();
        });
  } else if (propName == "finishWriting") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(encoderMutex);
          if (!released.test() && prepared && !finished) {
            framesExtractor->finishWriting();
            finished = true;
          }
          return jsi::Value::undefined();
        });
  }
  if (propName == "dispose") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          this->release();
          return jsi::Value::undefined();
        });
  }
  return jsi::Value::undefined();
}

void VideoEncoderHostObject::release() {
  std::lock_guard<std::recursive_mutex> lock(encoderMutex);
  if (!released.test_and_set()) {
    // A canvas context presenting to the window holds its own reference.
    if (window != nullptr) {
      ANativeWindow_release(window);
      window = nullptr;
    }
    hints.reset();
    framesExtractor->release();
    framesExtractor = nullptr;
  }
}

} // namespace RNSkiaVideo

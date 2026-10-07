#include "RNSVCheckedSizes.h"
#include "VideoEncoderHostObject.h"
#include <fbjni/ByteBuffer.h>
#include <cmath>
#include <limits>

namespace RNSkiaVideo {
using namespace facebook::jni;

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

void VideoEncoder::makeGLContextCurrent() const {
  static const auto makeGLContextCurrentMethod =
      getClass()->getMethod<void()>("makeGLContextCurrent");
  makeGLContextCurrentMethod(self());
}

void VideoEncoder::encodeFrameRgba(alias_ref<JByteBuffer> pixels, jint width,
                                   jint height, jint bytesPerRow, jdouble time) const {
  static const auto method =
      getClass()->getMethod<void(alias_ref<JByteBuffer>, jint, jint, jint, jdouble)>("encodeFrameRgba");
  method(self(), pixels, width, height, bytesPerRow, time);
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
}

VideoEncoderHostObject::~VideoEncoderHostObject() {
  this->release();
}

std::vector<jsi::PropNameID>
VideoEncoderHostObject::getPropertyNames(jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> result;
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("prepare")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("encodeFrame")));
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
          if (!frame.getProperty(runtime, "kind").isString() ||
              frame.getProperty(runtime, "kind").asString(runtime).utf8(runtime) != "rgba") {
            throw jsi::JSError(runtime, "Android reference encoder accepts RGBA pixels");
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
    framesExtractor->release();
    framesExtractor = nullptr;
  }
}

} // namespace RNSkiaVideo

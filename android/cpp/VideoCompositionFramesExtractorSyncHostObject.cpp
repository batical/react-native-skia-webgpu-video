#include "VideoCompositionFramesExtractorSyncHostObject.h"
#include <cmath>

namespace RNSkiaVideo {
using namespace facebook::jni;

local_ref<VideoCompositionFramesExtractorSync>
VideoCompositionFramesExtractorSync::create(
    alias_ref<VideoComposition> composition) {
  return newInstance(composition);
}

void VideoCompositionFramesExtractorSync::start() const {
  static const auto startMethod = getClass()->getMethod<void()>("start");
  startMethod(self());
}

local_ref<JMap<JString, VideoFrame>>
VideoCompositionFramesExtractorSync::decodeCompositionFrames(jdouble time) {
  static const auto decodeCompositionFramesMethod =
      getClass()->getMethod<JMap<JString, VideoFrame>(jdouble)>(
          "decodeCompositionFrames");
  return decodeCompositionFramesMethod(self(), time);
}

void VideoCompositionFramesExtractorSync::release() const {
  static const auto releaseMethod = getClass()->getMethod<void()>("release");
  releaseMethod(self());
}

VideoCompositionFramesExtractorSyncHostObject::
    VideoCompositionFramesExtractorSyncHostObject(jsi::Runtime& runtime,
                                                  jsi::Object jsComposition) {
  auto composition = VideoComposition::fromJSIObject(runtime, jsComposition);
  framesExtractor =
      make_global(VideoCompositionFramesExtractorSync::create(composition));
}

VideoCompositionFramesExtractorSyncHostObject::
    ~VideoCompositionFramesExtractorSyncHostObject() {
  this->release();
}

std::vector<jsi::PropNameID>
VideoCompositionFramesExtractorSyncHostObject::getPropertyNames(
    jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> result;
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("start")));
  result.push_back(
      jsi::PropNameID::forUtf8(rt, std::string("decodeCompositionFrames")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("dispose")));
  return result;
}

// The methods are created once per runtime (see RNSVHostObject):
// `decodeCompositionFrames` is read for every exported frame.
jsi::Value VideoCompositionFramesExtractorSyncHostObject::get(
    jsi::Runtime& runtime, const jsi::PropNameID& propNameId) {
  auto propName = propNameId.utf8(runtime);
  if (propName == "decodeCompositionFrames") {
    return getFunction(
        runtime, propName, 1,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          auto result = jsi::Object(runtime);
          global_ref<VideoCompositionFramesExtractorSync> current;
          {
            std::lock_guard<std::mutex> lock(extractorMutex);
            if (released.test()) return result;
            current = make_global(framesExtractor);
          }
          if (count < 1 || !arguments[0].isNumber() || !std::isfinite(arguments[0].asNumber()))
            throw jsi::JSError(runtime, "Expected a finite video decode time");
          auto time = arguments[0].asNumber();
          // Do not hold the C++ mutex while Java waits: dispose must be able
          // to cancel that request on another runtime.
          auto frames = current->decodeCompositionFrames(time);
          for (auto& entry : *frames) {
            auto id = entry.first->toStdString();
            auto frame = entry.second;
            auto cached = getVersionedObject(runtime, "frame:" + id,
              static_cast<double>(frame->getId()), [&](jsi::Object& holder) {
                holder.setProperty(runtime, "value", frame->toJS(runtime));
              });
            result.setProperty(runtime, id.c_str(), cached.asObject(runtime).getProperty(runtime, "value"));
          }
          return result;
        });
  } else if (propName == "start") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          global_ref<VideoCompositionFramesExtractorSync> current;
          {
            std::lock_guard<std::mutex> lock(extractorMutex);
            if (released.test()) return jsi::Value::undefined();
            current = make_global(framesExtractor);
          }
          current->start();
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

void VideoCompositionFramesExtractorSyncHostObject::release() {
  global_ref<VideoCompositionFramesExtractorSync> current;
  {
    std::lock_guard<std::mutex> lock(extractorMutex);
    if (released.test_and_set()) return;
    current = std::move(framesExtractor);
  }
  if (current) current->release();
}

} // namespace RNSkiaVideo

#pragma once

#include "RNSVEventEmitter.h"
#include <fbjni/fbjni.h>
#include <jsi/jsi.h>

namespace RNSkiaVideo {
using namespace facebook;
using namespace jni;

class JEventReceiver {
public:
  virtual ~JEventReceiver() = default;
  virtual void handleEvent(std::string eventName, alias_ref<jobject> data) = 0;
};

struct NativeEventDispatcher : public JavaClass<NativeEventDispatcher> {
  static constexpr auto kJavaDescriptor =
      "Lcom/azzapp/rnskv/NativeEventDispatcher;";

  static jni::local_ref<NativeEventDispatcher>
  create(const std::weak_ptr<JEventReceiver>& receiver);

  static void registerNatives();
  void invalidate() const;

  static void dispatchEvent(alias_ref<JClass>, jlong receiver,
                            std::string eventName, alias_ref<jobject> data);
  static void invalidateReceiver(alias_ref<JClass>, jlong receiver);
};
} // namespace RNSkiaVideo

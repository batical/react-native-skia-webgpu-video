#include "NativeEventDispatcher.h"
#include <atomic>
#include <mutex>
#include <unordered_map>

namespace RNSkiaVideo {
using namespace facebook;
using namespace jni;
namespace {
std::atomic<jlong> nextReceiver{1};
std::mutex receiversMutex;
std::unordered_map<jlong, std::weak_ptr<JEventReceiver>> receivers;
}

jni::local_ref<NativeEventDispatcher>
NativeEventDispatcher::create(const std::weak_ptr<JEventReceiver>& receiver) {
  const auto id = nextReceiver.fetch_add(1);
  {
    std::lock_guard<std::mutex> lock(receiversMutex);
    receivers.emplace(id, receiver);
  }
  try { return newInstance(id); }
  catch (...) {
    std::lock_guard<std::mutex> lock(receiversMutex);
    receivers.erase(id);
    throw;
  }
}

void NativeEventDispatcher::registerNatives() {
  javaClassStatic()->registerNatives({makeNativeMethod(
      "nativeDispatchEvent", NativeEventDispatcher::dispatchEvent),
      makeNativeMethod("nativeInvalidateReceiver", NativeEventDispatcher::invalidateReceiver)});
}

void NativeEventDispatcher::invalidate() const {
  static const auto method = getClass()->getMethod<void()>("invalidate");
  method(self());
}

void NativeEventDispatcher::dispatchEvent(alias_ref<JClass>, jlong receiverPtr,
                                          std::string eventName,
                                          alias_ref<jobject> data) {
  std::shared_ptr<JEventReceiver> receiver;
  {
    std::lock_guard<std::mutex> lock(receiversMutex);
    auto found = receivers.find(receiverPtr);
    if (found != receivers.end()) receiver = found->second.lock();
  }
  // Keep the receiver alive for this callback without a Java/native cycle.
  if (receiver) receiver->handleEvent(std::move(eventName), data);
}

void NativeEventDispatcher::invalidateReceiver(alias_ref<JClass>, jlong id) {
  std::lock_guard<std::mutex> lock(receiversMutex);
  receivers.erase(id);
}

} // namespace RNSkiaVideo

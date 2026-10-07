#include "RNSVRuntimeLifecycleMonitor.h"

#include <algorithm>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>
#include <utility>

namespace RNSkiaVideo {

struct ListenerRegistration {
  RuntimeLifecycleListener* identity;
  std::weak_ptr<RuntimeLifecycleListener> listener;
};
static std::unordered_map<jsi::Runtime*, std::vector<ListenerRegistration>> listeners;
static std::mutex listenersMutex;

struct RuntimeLifecycleMonitorObject : public jsi::HostObject {
  jsi::Runtime* runtime;
  explicit RuntimeLifecycleMonitorObject(jsi::Runtime* runtime)
      : runtime(runtime) {}
  ~RuntimeLifecycleMonitorObject() override {
    std::vector<ListenerRegistration> registrations;
    {
      std::lock_guard<std::mutex> lock(listenersMutex);
      auto entry = listeners.find(runtime);
      if (entry != listeners.end()) {
        registrations = std::move(entry->second);
        listeners.erase(entry);
      }
    }
    // A listener's final reference can unregister it. Release the registry
    // mutex before locking or destroying those references.
    for (const auto& registration : registrations) {
      if (auto listener = registration.listener.lock()) {
        listener->onRuntimeDestroyed(runtime);
      }
    }
  }
};

void RuntimeLifecycleMonitor::addListener(jsi::Runtime& runtime,
    const std::shared_ptr<RuntimeLifecycleListener>& listener) {
  bool installMonitor = false;
  {
    std::lock_guard<std::mutex> lock(listenersMutex);
    auto entry = listeners.find(&runtime);
    if (entry == listeners.end()) {
      listeners.emplace(&runtime, std::vector<ListenerRegistration>{
                                      {listener.get(), listener}});
      installMonitor = true;
    } else {
      const auto identity = listener.get();
      auto& entries = entry->second;
      entries.erase(std::remove_if(entries.begin(), entries.end(),
                                   [](const auto& item) {
                                     return item.listener.expired();
                                   }), entries.end());
      bool registered = false;
      for (const auto& item : entries) registered |= item.identity == identity;
      if (!registered) entries.push_back({identity, listener});
    }
  }
  if (installMonitor) {
    // The global object owns the monitor: when the runtime is torn down the
    // monitor is destroyed with it and notifies the listeners.
    runtime.global().setProperty(
        runtime, "__rnskv_rt_lifecycle_monitor",
        jsi::Object::createFromHostObject(
            runtime, std::make_shared<RuntimeLifecycleMonitorObject>(&runtime)));
  }
}

void RuntimeLifecycleMonitor::removeListener(
    jsi::Runtime& runtime, RuntimeLifecycleListener* listener) {
  std::lock_guard<std::mutex> lock(listenersMutex);
  auto entry = listeners.find(&runtime);
  if (entry != listeners.end()) {
    auto& entries = entry->second;
    entries.erase(std::remove_if(entries.begin(), entries.end(),
                                 [listener](const auto& item) {
                                   return item.identity == listener;
                                 }), entries.end());
  }
}

} // namespace RNSkiaVideo

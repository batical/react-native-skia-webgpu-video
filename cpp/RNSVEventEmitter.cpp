#include "RNSVEventEmitter.h"
#include "RNSVRuntimeLifecycleMonitor.h"

#include <map>
#include <mutex>
#include <stdexcept>
#include <utility>
#include <vector>

namespace RNSkiaVideo {

// Native producers and queued callbacks hold no HostObject pointer. JS handles
// live in this state until they can be released on the owning JS thread.
struct EventEmitter::State : RuntimeLifecycleListener {
  using ListenerMap = std::map<std::string,
      std::map<uint64_t, std::shared_ptr<jsi::Function>>>;
  std::mutex mutex;
  jsi::Runtime* runtime;
  bool closed = false;
  uint64_t nextId = 1;
  uint64_t generation = 0;
  ListenerMap listeners;
  std::vector<ListenerMap> retiredListeners;
  std::map<uint64_t, jsi::Value> payloads;

  explicit State(jsi::Runtime& runtime) : runtime(&runtime) {}

  void onRuntimeDestroyed(jsi::Runtime* destroyedRuntime) override {
    ListenerMap releasedListeners;
    std::vector<ListenerMap> releasedRetired;
    std::map<uint64_t, jsi::Value> releasedPayloads;
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (runtime != destroyedRuntime) return;
      closed = true;
      ++generation;
      releasedListeners = std::move(listeners);
      releasedRetired = std::move(retiredListeners);
      releasedPayloads = std::move(payloads);
      runtime = nullptr;
    }
    // Releasing a JS handle can destroy a native HostObject which calls back
    // into this state. Release handles outside its mutex to allow reentry.
  }
};

EventEmitter::EventEmitter(jsi::Runtime& runtime,
                           std::shared_ptr<react::CallInvoker> callInvoker)
    : state(std::make_shared<State>(runtime)), callInvoker(std::move(callInvoker)) {
  RuntimeLifecycleMonitor::addListener(runtime, state);
}

EventEmitter::~EventEmitter() {
  retireListeners(true);
}

jsi::Function EventEmitter::on(std::string eventName, jsi::Function listener) {
  std::lock_guard<std::mutex> lock(state->mutex);
  if (!state->runtime || state->closed) {
    throw std::runtime_error("Video event source is no longer alive");
  }
  const auto id = state->nextId++;
  state->listeners[eventName].emplace(
      id, std::make_shared<jsi::Function>(std::move(listener)));
  std::weak_ptr<State> weakState = state;
  return jsi::Function::createFromHostFunction(
      *state->runtime, jsi::PropNameID::forAscii(*state->runtime, "dispose"), 0,
      [weakState, eventName = std::move(eventName), id](
          jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
        if (auto retained = weakState.lock()) {
          std::shared_ptr<jsi::Function> released;
          {
            std::lock_guard<std::mutex> lock(retained->mutex);
            auto entry = retained->listeners.find(eventName);
            if (entry != retained->listeners.end()) {
              auto found = entry->second.find(id);
              if (found != entry->second.end()) {
                released = std::move(found->second);
                entry->second.erase(found);
              }
              if (entry->second.empty()) retained->listeners.erase(entry);
            }
          }
        }
        return jsi::Value::undefined();
      });
}

void EventEmitter::emit(std::string eventName) {
  emit(std::move(eventName), [](jsi::Runtime&) {
    return jsi::Value::undefined();
  });
}

void EventEmitter::emit(std::string eventName, jsi::Value data) {
  uint64_t id;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    if (state->closed || !state->runtime) return;
    id = state->nextId++;
    state->payloads.emplace(id, std::move(data));
  }
  enqueue(std::move(eventName), {}, id);
}

void EventEmitter::emit(std::string eventName,
                        std::function<jsi::Value(jsi::Runtime&)> dataFactory) {
  enqueue(std::move(eventName), std::move(dataFactory));
}

void EventEmitter::enqueue(
    std::string eventName,
    std::function<jsi::Value(jsi::Runtime&)> dataFactory, uint64_t payloadId) {
  uint64_t generation;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    if (state->closed || !state->runtime) return;
    generation = state->generation;
  }
  std::weak_ptr<State> weakState = state;
  callInvoker->invokeAsync([weakState, eventName = std::move(eventName),
                            dataFactory = std::move(dataFactory), payloadId,
                            generation]() {
    auto retained = weakState.lock();
    if (!retained) return;
    jsi::Runtime* runtime;
    std::vector<std::shared_ptr<jsi::Function>> listeners;
    std::vector<State::ListenerMap> retiredListeners;
    std::map<uint64_t, jsi::Value>::node_type stalePayload;
    jsi::Value data;
    {
      std::lock_guard<std::mutex> lock(retained->mutex);
      runtime = retained->runtime;
      retiredListeners = std::move(retained->retiredListeners);
      if (!runtime || retained->closed || retained->generation != generation) {
        stalePayload = retained->payloads.extract(payloadId);
        return;
      }
      auto entry = retained->listeners.find(eventName);
      if (entry != retained->listeners.end()) {
        for (const auto& listener : entry->second) listeners.push_back(listener.second);
      }
      if (payloadId) {
        auto payload = retained->payloads.find(payloadId);
        if (payload != retained->payloads.end()) {
          data = std::move(payload->second);
          retained->payloads.erase(payload);
        }
      }
    }
    // Listener calls may unsubscribe or dispose the source; never hold the
    // state mutex across JS execution. Factories only run on the JS thread.
    if (listeners.empty()) return;
    if (dataFactory) data = dataFactory(*runtime);
    for (const auto& listener : listeners) {
      {
        std::lock_guard<std::mutex> lock(retained->mutex);
        if (retained->closed || retained->generation != generation) break;
      }
      listener->call(*runtime, data);
    }
  });
}

jsi::Runtime* EventEmitter::getRuntime() {
  std::lock_guard<std::mutex> lock(state->mutex);
  return state->closed ? nullptr : state->runtime;
}

void EventEmitter::retireListeners(bool close) {
  auto retained = state;
  {
    std::lock_guard<std::mutex> lock(retained->mutex);
    if (!retained->runtime) return;
    retained->closed |= close;
    ++retained->generation;
    if (!retained->listeners.empty()) {
      retained->retiredListeners.push_back(std::move(retained->listeners));
      retained->listeners.clear();
    }
  }
  // A queued cleanup retains the state, not the HostObject. Runtime teardown
  // also clears it, so a dropped callback cannot leave dangling JS handles.
  callInvoker->invokeAsync([retained]() {
    std::vector<State::ListenerMap> listeners;
    std::map<uint64_t, jsi::Value> payloads;
    {
      std::lock_guard<std::mutex> lock(retained->mutex);
      listeners = std::move(retained->retiredListeners);
      if (retained->closed) payloads = std::move(retained->payloads);
    }
  });
}

void EventEmitter::removeAllListeners() {
  retireListeners(false);
}

} // namespace RNSkiaVideo

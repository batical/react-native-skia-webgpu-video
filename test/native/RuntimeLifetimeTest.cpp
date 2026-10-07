#include "RNSVEventEmitter.h"
#include "RNSVHostObject.h"
#include "RNSVMemoryBudget.h"
#include <JSCRuntime.h>
#include <cassert>
#include <deque>
#include <iostream>
#include <thread>

using namespace facebook;
using namespace RNSkiaVideo;

class QueuedInvoker final : public react::CallInvoker {
public:
  std::deque<react::CallFunc> queue;
  void invokeAsync(react::CallFunc&& function) noexcept override {
    queue.push_back(std::move(function));
  }
  void invokeSync(react::CallFunc&&) override { std::abort(); }
  void drain(jsi::Runtime& runtime) {
    while (!queue.empty()) {
      auto function = std::move(queue.front());
      queue.pop_front();
      function(runtime);
    }
  }
};

class TestHost final : public RNSVHostObject {
public:
  jsi::Value get(jsi::Runtime& runtime, const jsi::PropNameID&) override {
    return getFunction(runtime, "method", 0,
      [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
        ++calls;
        return jsi::Value::undefined();
      });
  }
  int calls = 0;
};

int main() {
  int calls = 0;
  auto invoker = std::make_shared<QueuedInvoker>();
  auto runtime = jsc::makeJSCRuntime();
  auto listener = [&]() {
    return jsi::Function::createFromHostFunction(
        *runtime, jsi::PropNameID::forAscii(*runtime, "listener"), 1,
        [&calls](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
          ++calls;
          return jsi::Value::undefined();
        });
  };
  {
    auto emitter = std::make_unique<EventEmitter>(*runtime, invoker);
    auto dispose = emitter->on("frame", listener());
    emitter->emit("frame", jsi::Value(42));
    invoker->drain(*runtime);
    assert(calls == 1);
    emitter->emit("frame");
    dispose.call(*runtime);
    invoker->drain(*runtime);
    assert(calls == 1);
    // An extracted disposer does not keep the native event source alive.
    emitter.reset();
    dispose.call(*runtime);
    invoker->drain(*runtime);
  }
  {
    auto emitter = std::make_unique<EventEmitter>(*runtime, invoker);
    auto dispose = emitter->on("frame", listener());
    for (int i = 0; i < 100; ++i) emitter->emit("frame", jsi::Value(i));
    std::thread release([&] { emitter.reset(); });
    release.join();
    invoker->drain(*runtime);
    assert(calls == 1);
    dispose.call(*runtime);
  }
  {
    auto host = std::make_shared<TestHost>();
    auto method = host->get(*runtime, jsi::PropNameID::forAscii(*runtime, "method"))
                      .asObject(*runtime).asFunction(*runtime);
    method.call(*runtime);
    assert(host->calls == 1);
    host.reset();
    bool rejected = false;
    try { method.call(*runtime); } catch (const jsi::JSError&) { rejected = true; }
    assert(rejected);
  }
  auto survivingEmitter = std::make_unique<EventEmitter>(*runtime, invoker);
  auto survivingHost = std::make_shared<TestHost>();
  {
    auto method = survivingHost->get(*runtime, jsi::PropNameID::forAscii(*runtime, "method"));
  }
  { auto dispose = survivingEmitter->on("frame", listener()); }
  survivingEmitter->emit("frame", jsi::Value(123));
  // JS handles are cleared by the runtime monitor before queued native
  // callbacks or a surviving event source can touch the destroyed runtime.
  runtime.reset();
  // A native callback may still own a HostObject after its JS runtime ends.
  // The monitor must have cleared its managed values before that owner dies.
  std::thread finalNativeOwner([&] { survivingHost.reset(); });
  finalNativeOwner.join();
  auto replacement = jsc::makeJSCRuntime();
  invoker->drain(*replacement);
  survivingEmitter->emit("frame");
  survivingEmitter.reset();
  invoker->drain(*replacement);
  assert(calls == 1);
  std::cout << "{\"test\":\"runtime-lifetime\",\"queuedAfterDispose\":100,"
               "\"runtimeTeardown\":true,\"extractedMethodGuard\":true}\n";
}

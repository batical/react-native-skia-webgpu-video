#include "RNSVMemoryBudget.h"
#include "RNSVRuntimeLifecycleMonitor.h"
#include <cmath>
#include <jsi/jsi.h>

namespace RNSkiaVideo {
namespace {
class BudgetRuntimeListener final : public RuntimeLifecycleListener {
public:
  void onRuntimeDestroyed(facebook::jsi::Runtime* runtime) override {
    MemoryBudget::instance().releaseOwner(runtime);
  }
};
const auto runtimeListener = std::make_shared<BudgetRuntimeListener>();
uint64_t positiveInteger(facebook::jsi::Runtime& rt,
                         const facebook::jsi::Value& value) {
  if (!value.isNumber()) throw facebook::jsi::JSError(rt, "Expected an integer");
  const auto number = value.asNumber();
  if (!std::isfinite(number) || number < 1 ||
      number > 9007199254740991.0 || std::floor(number) != number) {
    throw facebook::jsi::JSError(rt, "Expected a positive safe integer");
  }
  return static_cast<uint64_t>(number);
}
}

void MemoryBudget::install(facebook::jsi::Runtime& runtime,
                           facebook::jsi::Object& module) {
  namespace jsi = facebook::jsi;
  RuntimeLifecycleMonitor::addListener(runtime, runtimeListener);
  module.setProperty(runtime, "frameProtocolVersion", 1);
  module.setProperty(runtime, "reserveMemory", jsi::Function::createFromHostFunction(
      runtime, jsi::PropNameID::forAscii(runtime, "reserveMemory"), 2,
      [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
        if (count < 1) throw jsi::JSError(rt, "Missing memory size");
        RuntimeLifecycleMonitor::addListener(rt, runtimeListener);
        const auto bytes = positiveInteger(rt, args[0]);
        const auto label = count > 1 && args[1].isString()
            ? args[1].asString(rt).utf8(rt) : "video resource";
        return jsi::Value(static_cast<double>(instance().reserve(bytes, label, &rt)));
      }));
  module.setProperty(runtime, "releaseMemory", jsi::Function::createFromHostFunction(
      runtime, jsi::PropNameID::forAscii(runtime, "releaseMemory"), 1,
      [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
        if (count < 1) throw jsi::JSError(rt, "Missing reservation");
        instance().release(positiveInteger(rt, args[0]));
        return jsi::Value::undefined();
      }));
  module.setProperty(runtime, "configureMemoryBudget", jsi::Function::createFromHostFunction(
      runtime, jsi::PropNameID::forAscii(runtime, "configureMemoryBudget"), 1,
      [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
        if (count < 1) throw jsi::JSError(rt, "Missing memory limit");
        instance().configure(positiveInteger(rt, args[0]));
        return jsi::Value::undefined();
      }));
  module.setProperty(runtime, "getMemoryBudgetStats", jsi::Function::createFromHostFunction(
      runtime, jsi::PropNameID::forAscii(runtime, "getMemoryBudgetStats"), 0,
      [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
        const auto stats = instance().snapshot();
        jsi::Object result(rt);
        result.setProperty(rt, "currentBytes", static_cast<double>(stats.currentBytes));
        result.setProperty(rt, "peakBytes", static_cast<double>(stats.peakBytes));
        result.setProperty(rt, "allocations", static_cast<double>(stats.allocations));
        result.setProperty(rt, "maxBytes", static_cast<double>(stats.maxBytes));
        return jsi::Value(std::move(result));
      }));
}
} // namespace RNSkiaVideo

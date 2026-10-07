#pragma once

#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>
#include <memory>

namespace RNSkiaVideo {
using namespace facebook;
class EventEmitter {
public:
  EventEmitter(jsi::Runtime& runtime,
               std::shared_ptr<react::CallInvoker> callInvoker);
  ~EventEmitter();
  jsi::Function on(std::string eventName, jsi::Function listener);
  void emit(std::string eventName);
  void emit(std::string eventName, jsi::Value data);
  void emit(std::string eventName,
            std::function<jsi::Value(jsi::Runtime&)> dataFactory);
  void removeAllListeners();
  jsi::Runtime* getRuntime();

private:
  struct State;
  std::shared_ptr<State> state;
  std::shared_ptr<react::CallInvoker> callInvoker;
  void enqueue(std::string eventName,
               std::function<jsi::Value(jsi::Runtime&)> dataFactory,
               uint64_t payloadId = 0);
  void retireListeners(bool close);
};
} // namespace RNSkiaVideo

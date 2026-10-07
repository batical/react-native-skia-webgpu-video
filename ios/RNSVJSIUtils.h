#pragma once
#import <Foundation/Foundation.h>
#import <jsi/jsi.h>
#include <stdexcept>
#include <type_traits>

namespace RNSkiaVideo {

using namespace facebook;

// The worklet runtime threads that drive video exports never drain their
// autorelease pool, so every autoreleased object created by a host function
// (Metal command buffers, CoreMedia wrappers, AVFoundation internals…) would
// accumulate for the lifetime of the app. JSI entry points doing ObjC work
// run inside this helper. Convert NSError into an owning C++ exception after
// the pool drains, avoiding a leaked CF retain on every failed export.
template <typename F>
static jsi::Value runPooled(F&& body) {
  NSError* pendingError = nil;
  jsi::Value result = jsi::Value::undefined();
  @autoreleasepool {
    try {
      if constexpr (std::is_void_v<std::invoke_result_t<F>>) body();
      else result = body();
    } catch (NSError* error) {
      pendingError = error;
    }
  }
  if (pendingError) {
    throw std::runtime_error([[pendingError localizedDescription] UTF8String]);
  }
  return result;
}

static jsi::Value NSErrorToJSI(jsi::Runtime& runtime, NSError* error) {
  auto jsError = jsi::Object(runtime);
  auto message = error == nil ? @"Unknown error" : [error description];
  jsError.setProperty(
      runtime, "message",
      jsi::String::createFromUtf8(runtime, [message UTF8String]));
  jsError.setProperty(runtime, "code",
                      error != nil ? jsi::Value((double)[error code])
                                   : jsi::Value::null());
  return jsError;
}
} // namespace RNSkiaVideo

#include "NativeRgbaBuffer.h"
#include "RNSVMemoryBudget.h"
#include <limits>

namespace RNSkiaVideo {
using namespace facebook::jni;
namespace {
jlong reserve(alias_ref<jclass>, jint size) {
  if (size <= 0) throw std::invalid_argument("Invalid Android RGBA allocation size");
  return static_cast<jlong>(MemoryBudget::instance().reserve(static_cast<uint64_t>(size) + 7, "android-frame-rgba"));
}
local_ref<JByteBuffer> alias(alias_ref<jclass>, alias_ref<JByteBuffer> backing) {
  auto* env = Environment::current();
  const auto size = env->GetDirectBufferCapacity(backing.get());
  auto* bytes = env->GetDirectBufferAddress(backing.get());
  if (!bytes || size <= 0 || size > std::numeric_limits<jint>::max())
    throw std::invalid_argument("Invalid Android direct pixel buffer");
  auto buffer = env->NewDirectByteBuffer(bytes, size);
  if (env->ExceptionCheck()) throwPendingJniExceptionAsCppException();
  if (!buffer) throw std::bad_alloc();
  return adopt_local(static_cast<JByteBuffer::javaobject>(buffer));
}
void release(alias_ref<jclass>, jlong token) {
  MemoryBudget::instance().release(static_cast<uint64_t>(token));
}
local_ref<JArrayLong> stats(alias_ref<jclass>) {
  const auto snapshot = MemoryBudget::instance().snapshot();
  auto result = JArrayLong::newArray(4);
  const jlong values[] = {static_cast<jlong>(snapshot.currentBytes),
    static_cast<jlong>(snapshot.peakBytes), static_cast<jlong>(snapshot.allocations),
    static_cast<jlong>(snapshot.maxBytes)};
  result->setRegion(0, 4, values);
  return result;
}
void configure(alias_ref<jclass>, jlong bytes) {
  if (bytes <= 0) throw std::invalid_argument("Invalid Android memory limit");
  MemoryBudget::instance().configure(bytes);
}
}
void NativeRgbaBuffer::registerNatives() {
  javaClassStatic()->registerNatives({makeNativeMethod("nativeReserve", reserve),
    makeNativeMethod("nativeAlias", alias), makeNativeMethod("nativeRelease", release),
    makeNativeMethod("nativeBudgetStats", stats), makeNativeMethod("nativeConfigureBudget", configure)});
}
}

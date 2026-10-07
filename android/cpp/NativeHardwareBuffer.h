#pragma once
#include <android/hardware_buffer.h>
#include <fbjni/fbjni.h>
#include <cstdint>
#include <memory>

namespace RNSkiaVideo {

struct HardwareFrameStorage final {
  AHardwareBuffer* buffer = nullptr;
  AHardwareBuffer_Desc description{};
  uint64_t reservation = 0;
  ~HardwareFrameStorage();
};

std::shared_ptr<HardwareFrameStorage> acquireHardwareFrame(uint64_t handle);

struct NativeHardwareBuffer : facebook::jni::JavaClass<NativeHardwareBuffer> {
  static constexpr auto kJavaDescriptor = "Lcom/azzapp/rnskv/NativeHardwareBuffer;";
  static void registerNatives();
  static bool isEnabled();
  static void configure(bool enabled);
};

} // namespace RNSkiaVideo

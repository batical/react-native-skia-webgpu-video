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
  // ImageReader frames: the codec's YUV buffer, owned until the last lease
  // closes its android.media.Image (returning the slot to the codec). The
  // picture is the crop rectangle, turned clockwise by `rotation` for display.
  facebook::jni::global_ref<jobject> image;
  int cropX = 0;
  int cropY = 0;
  int cropWidth = 0;
  int cropHeight = 0;
  int rotation = 0;
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

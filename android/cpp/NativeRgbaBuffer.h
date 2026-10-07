#pragma once
#include <fbjni/fbjni.h>
#include <fbjni/ByteBuffer.h>
namespace RNSkiaVideo {
struct NativeRgbaBuffer : facebook::jni::JavaClass<NativeRgbaBuffer> {
  static constexpr auto kJavaDescriptor = "Lcom/azzapp/rnskv/NativeRgbaBuffer;";
  static void registerNatives();
};
}

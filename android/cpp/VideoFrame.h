#pragma once

#include <fbjni/fbjni.h>
#include <fbjni/ByteBuffer.h>
#include <jsi/jsi.h>

namespace RNSkiaVideo {
using namespace facebook;
using namespace jni;

struct VideoFrame : JavaClass<VideoFrame> {
  static constexpr auto kJavaDescriptor = "Lcom/azzapp/rnskv/VideoFrame;";
  jint getWidth();
  jint getHeight();
  jint getRotation();
  jint getBytesPerRow();
  jlong getTimestampNs();
  jlong getId();
  jlong getProducerId();
  local_ref<JByteBuffer> getPixelBuffer();
  jboolean isHardwareBuffer();
  jlong getNativeHardwareBufferHandle();
  void close();
  jsi::Value toJS(jsi::Runtime& runtime);
  jsi::Value toJSInternal(jsi::Runtime& runtime);
};
} // namespace RNSkiaVideo

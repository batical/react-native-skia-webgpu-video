#pragma once

#include "ExportHintSession.h"
#include "RNSVHostObject.h"
#include "VideoComposition.h"
#include <android/native_window.h>
#include <memory>
#include <mutex>
#include <fbjni/ByteBuffer.h>
#include <fbjni/fbjni.h>
#include <jsi/jsi.h>

namespace RNSkiaVideo {
using namespace facebook;
using namespace jni;

struct VideoEncoder : public jni::JavaClass<VideoEncoder> {

public:
  static constexpr auto kJavaDescriptor = "Lcom/azzapp/rnskv/VideoEncoder;";

  local_ref<VideoEncoder> static create(std::string& outPath, int width,
                                        int height, int frameRate, int bitRate,
                                        std::optional<std::string> encoderName,
                                        std::optional<std::string> codec,
                                        alias_ref<VideoComposition> composition,
                                        int audioSampleRate,
                                        int audioChannelCount,
                                        int audioBitRate);

  /**
   * Whether the device has an encoder for the given codec ("h264" or "hevc").
   */
  static bool isCodecSupported(const std::string& codec);

  void prepare() const;

  void encodeFrameRgba(alias_ref<JByteBuffer> pixels, jint width, jint height,
                       jint bytesPerRow, jdouble time) const;

  /** The codec's input Surface (an android.view.Surface). */
  local_ref<jobject> getInputSurface() const;

  /** Before a frame is presented to the input Surface: its time in µs. */
  jlong beginWindowFrame(jdouble time) const;

  /** Once the frame of beginWindowFrame was presented. */
  void endWindowFrame(jlong timeUs) const;

  void finishWriting() const;

  void release() const;
};

class JSI_EXPORT VideoEncoderHostObject : public RNSVHostObject {
public:
  VideoEncoderHostObject(std::string& outPath, int width, int height,
                         int frameRate, int bitRate,
                         std::optional<std::string> encoderName,
                         std::optional<std::string> codec,
                         alias_ref<VideoComposition> composition,
                         int audioSampleRate, int audioChannelCount,
                         int audioBitRate);
  ~VideoEncoderHostObject() override;
  jsi::Value get(jsi::Runtime&, const jsi::PropNameID& name) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override;

private:
  global_ref<VideoEncoder> framesExtractor;
  // GPU export: the codec's input Surface, which WebGPU presents to.
  ANativeWindow* window = nullptr;
  // GPU export: the system's hints, per presented frame.
  std::unique_ptr<ExportHintSession> hints;
  std::recursive_mutex encoderMutex;
  bool prepared = false;
  bool finished = false;
  std::atomic_flag released = ATOMIC_FLAG_INIT;
  void release();
};

} // namespace RNSkiaVideo

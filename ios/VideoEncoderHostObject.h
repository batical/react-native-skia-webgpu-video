#pragma once

#import "RNSVHostObject.h"
#import "VideoComposition.h"
#import <AVFoundation/AVFoundation.h>
#import <jsi/jsi.h>
#import <map>
#include <atomic>
#include <mutex>

namespace RNSkiaVideo {
using namespace facebook;

class JSI_EXPORT VideoEncoderHostObject : public RNSVHostObject {
public:
  VideoEncoderHostObject(std::string outPath, int width, int height,
                         int frameRate, int bitRate, std::string codec,
                         int audioBitRate, int audioSampleRate,
                         int audioChannelCount,
                         std::shared_ptr<VideoComposition> composition,
                         bool directEncoder);

  /**
   * Whether the device has an encoder for the given codec ("h264" or "hevc").
   * H.264 is guaranteed; HEVC needs an A10 or later.
   */
  static bool isCodecSupported(const std::string& codec);
  ~VideoEncoderHostObject() override;
  jsi::Value get(jsi::Runtime&, const jsi::PropNameID& name) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override;

private:
#if defined(RNSV_NATIVE_TESTS)
  friend class NativeEncoderTestDriver;
#endif
  std::string outPath;
  int width;
  int height;
  int bitRate;
  int frameRate;
  std::string codec;
  int audioBitRate;
  int audioSampleRate;
  int audioChannelCount;
  std::shared_ptr<VideoComposition> composition;
  // Direct native-buffer append avoids an additional CPU copy. The reference
  // rgba-pixels path always fills our bounded pool, regardless of this option.
  bool directEncoder = false;
  std::atomic<bool> disposed{false};
  std::recursive_mutex stateMutex;
  bool prepared = false;
  uint64_t poolMemoryToken = 0;
  AVAssetWriter* assetWriter;
  AVAssetWriterInput* assetWriterInput;
  CVPixelBufferPoolRef pixelBufferPool = NULL;
  // The pool buffer lent to JS for the GPU export path: drawn into through
  // WebGPU, then appended as is. One at a time; owned until encoded or released.
  CVPixelBufferRef vendedBuffer = NULL;

  AVAssetWriterInput* audioWriterInput;
  AVAssetReader* audioReader;
  AVAssetReaderAudioMixOutput* audioMixOutput;
  dispatch_queue_t audioQueue;
  dispatch_semaphore_t audioCompletionSemaphore;
  NSMutableArray<NSError*>* audioErrorHolder;

  void prepare();
  void prepareImpl();
  void encodeFrame(CVPixelBufferRef source, CMTime time);
  void encodePixels(const uint8_t* pixels, size_t rowBytes, CMTime time,
                    bool rgba = false);
  CVPixelBufferRef acquireOutputBuffer();
  uintptr_t acquireFrameBuffer();
  void releaseFrameBuffer();
  void appendBuffer(CVPixelBufferRef pixelBuffer, CMTime time);
  void waitUntilReady();
  void setupAudio();
  void startWritingAudio();
  void finish();
  void release();
};

} // namespace RNSkiaVideo

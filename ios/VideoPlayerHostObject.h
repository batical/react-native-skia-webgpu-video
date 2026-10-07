#pragma once

#include "RNSVEventEmitter.h"
#include "RNSVHostObject.h"
#include "RNSVVideoPlayer.h"
#include "VideoFrame.h"

using namespace facebook;
namespace RNSkiaVideo { class VideoPlayerHostObject; }

@interface RNSVSkiaVideoPlayerDelegateImpl : NSObject <RNSVVideoPlayerDelegate>

- (instancetype)initWithHost:
    (std::weak_ptr<RNSkiaVideo::VideoPlayerHostObject>)host;
- (void)dispose;

@end

namespace RNSkiaVideo {

class JSI_EXPORT VideoPlayerHostObject : public RNSVHostObject, public EventEmitter {
public:
  VideoPlayerHostObject(jsi::Runtime& runtime,
                        std::shared_ptr<react::CallInvoker> callInvoker,
                        NSURL* url, CGSize resolution, bool directTexture);
  ~VideoPlayerHostObject();
  void initialize(NSURL* url, CGSize resolution);
  jsi::Value get(jsi::Runtime&, const jsi::PropNameID& name) override;
  void set(jsi::Runtime&, const jsi::PropNameID& name,
           const jsi::Value& value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override;

  void readyToPlay(float width, float height, int rotation);
  void frameAvailableEventHandler(CMTime time);

private:
  NSObject* lock;
  RNSVVideoPlayer* player;
  RNSVSkiaVideoPlayerDelegateImpl* playerDelegate;
  std::shared_ptr<VideoFrame> currentFrame;
  VideoFrameRing frameRing;
  uint64_t producerId = allocateVideoProducerId();
  std::shared_ptr<VideoFrame> makeFrame(CVPixelBufferRef buffer);
  CMTime lastFrameAvailable = kCMTimeInvalid;
  CMTime lastFrameDrawn = kCMTimeInvalid;
  float width = 0;
  float height = 0;
  int rotation = 0;
  std::atomic_flag released = ATOMIC_FLAG_INIT;
  void release();
};
} // namespace RNSkiaVideo

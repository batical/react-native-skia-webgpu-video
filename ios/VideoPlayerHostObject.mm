//
//  VideoPlayerHostObject.m
//  azzapp-react-native-skia-video
//
//  Created by François de Campredon on 03/05/2024.
//

#import "VideoPlayerHostObject.h"
#import "RNSVJSIUtils.h"
#import "RNSVScopedPixelBuffer.h"
#include "RNSVCheckedSizes.h"

namespace RNSkiaVideo {
using namespace facebook;

VideoPlayerHostObject::VideoPlayerHostObject(
    jsi::Runtime& runtime, std::shared_ptr<react::CallInvoker> callInvoker,
    NSURL* url, CGSize resolution, bool directTexture)
    : EventEmitter(runtime, callInvoker) {
  lock = [[NSObject alloc] init];
  (void)directTexture;
  (void)url;
  (void)resolution;
}

void VideoPlayerHostObject::initialize(NSURL* url, CGSize resolution) {
  playerDelegate = [[RNSVSkiaVideoPlayerDelegateImpl alloc]
      initWithHost:std::weak_ptr<VideoPlayerHostObject>(
          std::static_pointer_cast<VideoPlayerHostObject>(shared_from_this()))];
  player = [[RNSVVideoPlayer alloc] initWithURL:url
                                       delegate:playerDelegate
                                     resolution:resolution];
}

VideoPlayerHostObject::~VideoPlayerHostObject() {
  release();
}

std::vector<jsi::PropNameID>
VideoPlayerHostObject::getPropertyNames(jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> result;
  result.push_back(
      jsi::PropNameID::forUtf8(rt, std::string("decodeNextFrame")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("play")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("pause")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("seekTo")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("currentTime")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("duration")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("volume")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("playbackSpeed")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("isLooping")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("isPlaying")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("dispose")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("on")));
  return result;
}

// The methods are created once per runtime (see RNSVHostObject):
// `decodeNextFrame` is read by useVideoPlayer at every vsync of the UI
// runtime, and a fresh host function on each read is two garbage collected
// allocations per frame for nothing.
jsi::Value VideoPlayerHostObject::get(jsi::Runtime& runtime,
                                      const jsi::PropNameID& propNameId) {
  @synchronized(lock) {
  auto propName = propNameId.utf8(runtime);
  if (propName == "decodeNextFrame") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          @synchronized(lock) {
          if (released.test() || !CMTIME_IS_VALID(lastFrameAvailable) ||
              CMTimeCompare(lastFrameDrawn, lastFrameAvailable) == 0) {
            return jsi::Value::null();
          }
          if (!frameRing.canAcquire()) return jsi::Value::null();
          ScopedPixelBuffer buffer([player copyPixelBufferForTime:lastFrameAvailable]);
          if (!buffer.get()) {
            return jsi::Value::null();
          }
          currentFrame = makeFrame(buffer.get());
          lastFrameDrawn = lastFrameAvailable;
          return jsi::Object::createFromHostObject(runtime, currentFrame);
          }
        });
  } else if (propName == "play") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          @synchronized(lock) { if (!released.test()) {
            [player play];
          } }
          return jsi::Value::undefined();
        });
  } else if (propName == "pause") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          @synchronized(lock) { if (!released.test()) {
            [player pause];
          } }
          return jsi::Value::undefined();
        });
  } else if (propName == "seekTo") {
    return getFunction(
        runtime, propName, 1,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          if (count < 1 || !arguments[0].isNumber())
            throw jsi::JSError(runtime, "seekTo expects media seconds");
          auto time = checkedMediaSeconds(arguments[0].asNumber());
          @synchronized(lock) { if (!released.test()) {
            std::weak_ptr<VideoPlayerHostObject> weak =
                std::static_pointer_cast<VideoPlayerHostObject>(shared_from_this());
            [player seekTo:CMTimeMakeWithSeconds(time, 600)
                completionHandler:^(BOOL) {
                  if (auto owner = weak.lock()) {
                    if (!owner->released.test()) {
                      owner->emit("seekComplete", jsi::Value::null());
                    }
                  }
                }];
          } }
          return jsi::Value::undefined();
        });
  } else if (propName == "on") {
    return getFunction(
        runtime, propName, 2,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          if (released.test()) {
            // Nothing to listen to anymore: hand out a no-op unsubscribe.
            return jsi::Function::createFromHostFunction(
                runtime, jsi::PropNameID::forAscii(runtime, "dispose"), 0,
                [](jsi::Runtime& runtime, const jsi::Value& thisValue,
                   const jsi::Value* arguments, size_t count) -> jsi::Value {
                  return jsi::Value::undefined();
                });
          }
          if (count < 2 || !arguments[0].isString() || !arguments[1].isObject() ||
              !arguments[1].asObject(runtime).isFunction(runtime))
            throw jsi::JSError(runtime, "on expects an event name and listener");
          auto name = arguments[0].asString(runtime).utf8(runtime);
          auto handler = arguments[1].asObject(runtime).asFunction(runtime);
          return this->on(name, std::move(handler));
        });
  } else if (propName == "dispose") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          this->release();
          return jsi::Value::undefined();
        });
  } else if (propName == "currentTime") {
    if (released.test()) {
      return jsi::Value(0);
    }
    double seconds = CMTimeGetSeconds(player.currentTime);
    return jsi::Value(isnan(seconds) ? -1 : seconds);
  } else if (propName == "duration") {
    if (released.test()) {
      return jsi::Value(0);
    }
    double seconds = CMTimeGetSeconds(player.duration);
    return jsi::Value(isnan(seconds) ? -1 : seconds);
  } else if (propName == "volume") {
    if (released.test()) {
      return jsi::Value(0);
    }
    float volume = player.volume;
    return jsi::Value(volume);
  } else if (propName == "playbackSpeed") {
    if (released.test()) {
      return jsi::Value(1);
    }
    float playbackSpeed = player.playbackSpeed;
    return jsi::Value(playbackSpeed);
  } else if (propName == "isLooping") {
    if (released.test()) {
      return jsi::Value(false);
    }
    return jsi::Value(player.isLooping);
  } else if (propName == "isPlaying") {
    if (released.test()) {
      return jsi::Value(false);
    }
    return jsi::Value(player.isPlaying);
  }

  return jsi::Value::undefined();
  }
}

void VideoPlayerHostObject::set(jsi::Runtime& runtime,
                                const jsi::PropNameID& propNameId,
                                const jsi::Value& value) {
  @synchronized(lock) {
  if (released.test()) {
    return;
  }
  auto propName = propNameId.utf8(runtime);
  if (propName == "volume") {
    player.volume = value.asNumber();
  } else if (propName == "playbackSpeed") {
    player.playbackSpeed = value.asNumber();
  } else if (propName == "isLooping") {
    player.isLooping = value.asBool();
  }
  }
}

void VideoPlayerHostObject::frameAvailableEventHandler(CMTime time) {
  if (released.test()) return;
  @synchronized(lock) { if (!released.test()) lastFrameAvailable = time; }
}

void VideoPlayerHostObject::readyToPlay(float width, float height,
                                        int rotation) {
  if (released.test()) return;
  @synchronized(lock) {
  if (released.test()) return;
  this->width = width;
  this->height = height;
  this->rotation = rotation;
  }
}

std::shared_ptr<VideoFrame>
VideoPlayerHostObject::makeFrame(CVPixelBufferRef buffer) {
  auto frame = std::make_shared<VideoFrame>(buffer, width, height, rotation,
                                           producerId);
  frameRing.push(frame);
  return frame;
}

void VideoPlayerHostObject::release() {
  if (!released.test_and_set()) {
    removeAllListeners();
    RNSVVideoPlayer* disposingPlayer;
    RNSVSkiaVideoPlayerDelegateImpl* disposingDelegate;
    @synchronized(lock) {
    frameRing.releaseAll();
    if (currentFrame) {
      currentFrame = nullptr;
    }
    disposingDelegate = playerDelegate;
    disposingPlayer = player;
    playerDelegate = nil;
    player = nil;
    }
    [disposingDelegate dispose];
    [disposingPlayer dispose];
  }
}

} // namespace RNSkiaVideo

using namespace facebook;

@implementation RNSVSkiaVideoPlayerDelegateImpl {
  std::weak_ptr<RNSkiaVideo::VideoPlayerHostObject> _host;
}
- (instancetype)initWithHost:
    (std::weak_ptr<RNSkiaVideo::VideoPlayerHostObject>)host {
  self = [super init];
  if (self) _host = std::move(host);
  return self;
}
- (void)readyToPlay:(NSDictionary*)assetInfos {
  auto host = _host.lock();
  if (!host) return;
  float width = [(NSNumber*)assetInfos[@"width"] floatValue];
  float height = [(NSNumber*)assetInfos[@"height"] floatValue];
  int rotation = [(NSNumber*)assetInfos[@"rotation"] intValue];
  host->readyToPlay(width, height, rotation);
  host->emit("ready", [=](jsi::Runtime& runtime) -> jsi::Value {
    auto result = jsi::Object(runtime);
    result.setProperty(runtime, "width", width);
    result.setProperty(runtime, "height", height);
    result.setProperty(runtime, "rotation", rotation);
    return result;
  });
}
- (void)frameAvailable:(CMTime)time {
  if (auto host = _host.lock()) host->frameAvailableEventHandler(time);
}
- (void)bufferingStart {
  if (auto host = _host.lock()) host->emit("bufferingStart");
}
- (void)bufferingEnd {
  if (auto host = _host.lock()) host->emit("bufferingEnd");
}
- (void)bufferingUpdate:(NSArray<NSValue*>*)loadedTimeRanges {
  if (auto host = _host.lock()) {
    host->emit("bufferingUpdate", [=](jsi::Runtime& runtime) -> jsi::Value {
      auto ranges = jsi::Array(runtime, loadedTimeRanges.count);
      for (size_t i = 0; i < loadedTimeRanges.count; ++i) {
        auto range = loadedTimeRanges[i].CMTimeRangeValue;
        auto result = jsi::Object(runtime);
        result.setProperty(runtime, "start", CMTimeGetSeconds(range.start));
        result.setProperty(runtime, "duration", CMTimeGetSeconds(range.duration));
        ranges.setValueAtIndex(runtime, i, result);
      }
      return ranges;
    });
  }
}
- (void)videoError:(nullable NSError*)error {
  if (auto host = _host.lock()) {
    host->emit("error", [=](jsi::Runtime& runtime) -> jsi::Value {
      return RNSkiaVideo::NSErrorToJSI(runtime, error);
    });
  }
}
- (void)complete {
  if (auto host = _host.lock()) host->emit("complete");
}
- (void)isPlaying:(BOOL)playing {
  if (auto host = _host.lock()) {
    host->emit("playingStatusChange", [playing](jsi::Runtime&) {
      return jsi::Value(playing ? true : false);
    });
  }
}
- (void)dispose {
  // The weak reference deliberately remains unchanged: callbacks racing with
  // host destruction either hold a valid owner or fail to lock it.
}
@end

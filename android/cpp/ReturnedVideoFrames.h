#pragma once
#include "VideoFrame.h"
#include <android/log.h>
#include <exception>

namespace RNSkiaVideo {

// Every Java public map owns independent wrapper leases, including cache hits.
// Keep cleanup tied to the whole map, not only frames converted successfully.
class ReturnedVideoFrames final {
 public:
  explicit ReturnedVideoFrames(alias_ref<JMap<JString, VideoFrame>> frames) : frames_(frames) {}
  ~ReturnedVideoFrames() {
    if (!closed_) {
      try { close(); }
      catch (const std::exception& error) {
        __android_log_print(ANDROID_LOG_ERROR, "SkiaVideo", "Returned-frame cleanup failed: %s", error.what());
      } catch (...) {
        __android_log_print(ANDROID_LOG_ERROR, "SkiaVideo", "Returned-frame cleanup failed");
      }
    }
  }
  void close() {
    if (closed_) return;
    std::exception_ptr failure;
    for (auto& entry : *frames_) {
      try { auto frame = entry.second; frame->close(); }
      catch (...) { if (!failure) failure = std::current_exception(); }
    }
    closed_ = true;
    if (failure) std::rethrow_exception(failure);
  }
 private:
  alias_ref<JMap<JString, VideoFrame>> frames_;
  bool closed_ = false;
};
} // namespace RNSkiaVideo

#pragma once

#include <cstdint>

struct APerformanceHintSession;

namespace RNSkiaVideo {

/**
 * Tells Android (ADPF) how long the export takes to make each frame, so that
 * it gives the export thread, and on Android 15 and later the GPU, the
 * capacity it needs. An export runs as fast as it can rather than at its frame
 * rate: frames are measured against a quarter of their real-time budget.
 * Best effort: before Android 13, or on a device without hint sessions,
 * nothing happens.
 */
class ExportHintSession {
public:
  explicit ExportHintSession(int frameRate);
  ~ExportHintSession();
  ExportHintSession(const ExportHintSession&) = delete;
  ExportHintSession& operator=(const ExportHintSession&) = delete;

  /** On the export thread, once a frame went to the encoder. */
  void frameDone();

private:
  int64_t targetNanos;
  APerformanceHintSession* session = nullptr;
  bool unavailable = false;
  int64_t lastNanos = 0;
  int64_t lastCpuNanos = 0;
};

} // namespace RNSkiaVideo

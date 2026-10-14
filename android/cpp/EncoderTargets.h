#pragma once

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <android/hardware_buffer.h>
#include <array>
#include <cstdint>
#include <vector>

namespace RNSkiaVideo {

/**
 * RGBA AHardwareBuffers lent to JS for the GPU export: Skia renders into one
 * through WebGPU, then the encoder's EGL context samples it into the codec's
 * input Surface. No CPU readback or upload. Bounded, one lent at a time.
 *
 * Methods that touch GL objects require the encoder's EGL context current.
 * A buffer is lent again only once the GL reads of its previous frame are
 * complete; the renderer's own completion is the sync-fd it hands back.
 */
class EncoderTargets {
public:
  static constexpr size_t kCapacity = 3;

  EncoderTargets(int width, int height);
  ~EncoderTargets();
  EncoderTargets(const EncoderTargets&) = delete;
  EncoderTargets& operator=(const EncoderTargets&) = delete;

  /** A buffer without pending GL reads; allocates up to kCapacity. */
  AHardwareBuffer* lend();
  /** Returns the lent buffer unencoded. Its renderer must have finished. */
  void giveBack();
  bool isLent(const AHardwareBuffer* buffer) const;
  /**
   * Waits on the renderer's sync-fds (taking ownership of each, -1 meaning
   * already signaled) and returns the lent buffer's texture, bound to its
   * EGLImage in the current context. The buffer stays reserved until
   * finishEncode().
   */
  GLuint beginEncode(const AHardwareBuffer* buffer, std::vector<int>& fences);
  /** After the draw sampling the texture, with the encoder context current. */
  void finishEncode();
  /** Encoder context current: waits for pending reads and frees everything. */
  void clear();
  bool empty() const { return slots.empty(); }

private:
  struct Slot {
    AHardwareBuffer* buffer = nullptr;
    uint64_t reservation = 0;
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLImageKHR image = EGL_NO_IMAGE_KHR;
    GLuint texture = 0;
    EGLSyncKHR reads = EGL_NO_SYNC_KHR;
  };
  int width;
  int height;
  std::vector<Slot> slots;
  // The lent slot, then the slot being encoded; -1 when none.
  int lent = -1;
  int encoding = -1;

  bool waitReads(Slot& slot, EGLTimeKHR timeout);
  void allocate(Slot& slot);
  void bindTexture(Slot& slot);
};

} // namespace RNSkiaVideo

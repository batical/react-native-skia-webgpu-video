#include "EncoderTargets.h"
#include "RNSVMemoryBudget.h"
#include <GLES2/gl2ext.h>
#include <cerrno>
#include <poll.h>
#include <stdexcept>
#include <string>
#include <unistd.h>

namespace RNSkiaVideo {
namespace {
constexpr EGLTimeKHR kWaitNanoseconds = 5'000'000'000ULL;
constexpr int kFenceTimeoutMs = 5000;

struct EglFunctions {
  PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC clientBuffer;
  PFNEGLCREATEIMAGEKHRPROC createImage;
  PFNEGLDESTROYIMAGEKHRPROC destroyImage;
  PFNGLEGLIMAGETARGETTEXTURE2DOESPROC imageTarget;
  PFNEGLCREATESYNCKHRPROC createSync;
  PFNEGLCLIENTWAITSYNCKHRPROC clientWaitSync;
  PFNEGLDESTROYSYNCKHRPROC destroySync;
};

const EglFunctions& egl() {
  static const EglFunctions functions = [] {
    EglFunctions f{
        reinterpret_cast<PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC>(
            eglGetProcAddress("eglGetNativeClientBufferANDROID")),
        reinterpret_cast<PFNEGLCREATEIMAGEKHRPROC>(eglGetProcAddress("eglCreateImageKHR")),
        reinterpret_cast<PFNEGLDESTROYIMAGEKHRPROC>(eglGetProcAddress("eglDestroyImageKHR")),
        reinterpret_cast<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>(
            eglGetProcAddress("glEGLImageTargetTexture2DOES")),
        reinterpret_cast<PFNEGLCREATESYNCKHRPROC>(eglGetProcAddress("eglCreateSyncKHR")),
        reinterpret_cast<PFNEGLCLIENTWAITSYNCKHRPROC>(eglGetProcAddress("eglClientWaitSyncKHR")),
        reinterpret_cast<PFNEGLDESTROYSYNCKHRPROC>(eglGetProcAddress("eglDestroySyncKHR")),
    };
    if (!f.clientBuffer || !f.createImage || !f.destroyImage || !f.imageTarget ||
        !f.createSync || !f.clientWaitSync || !f.destroySync)
      throw std::runtime_error("EGL hardware buffer or fence entry points are unavailable");
    return f;
  }();
  return functions;
}

/** Waits for a sync-fd to signal, then closes it. */
void waitFence(int& fd) {
  if (fd < 0) return;  // Already signaled.
  pollfd entry{fd, POLLIN, 0};
  int result;
  do {
    result = poll(&entry, 1, kFenceTimeoutMs);
  } while (result < 0 && errno == EINTR);
  const int error = errno;
  close(fd);
  fd = -1;
  if (result == 0) throw std::runtime_error("GPU export frame did not complete within 5 seconds");
  if (result < 0) throw std::runtime_error("Cannot wait on GPU export fence: errno " + std::to_string(error));
  if (entry.revents & (POLLERR | POLLNVAL))
    throw std::runtime_error("Invalid GPU export fence");
}
} // namespace

EncoderTargets::EncoderTargets(int width, int height) : width(width), height(height) {
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384)
    throw std::invalid_argument("Invalid encoder buffer dimensions");
}

EncoderTargets::~EncoderTargets() {
  // clear() could not run with the encoder context current: its textures went
  // with that context. Images, syncs and buffers need no current context.
  for (auto& slot : slots) {
    if (slot.reads != EGL_NO_SYNC_KHR) egl().destroySync(slot.display, slot.reads);
    if (slot.image != EGL_NO_IMAGE_KHR) egl().destroyImage(slot.display, slot.image);
    if (slot.buffer) AHardwareBuffer_release(slot.buffer);
    if (slot.reservation) MemoryBudget::instance().release(slot.reservation);
  }
}

bool EncoderTargets::waitReads(Slot& slot, EGLTimeKHR timeout) {
  if (slot.reads == EGL_NO_SYNC_KHR) return true;
  const auto status = egl().clientWaitSync(slot.display, slot.reads, 0, timeout);
  if (status == EGL_TIMEOUT_EXPIRED_KHR) return false;
  if (status != EGL_CONDITION_SATISFIED_KHR)
    throw std::runtime_error("Cannot wait on encoder buffer reads: EGL error " + std::to_string(eglGetError()));
  egl().destroySync(slot.display, slot.reads);
  slot.reads = EGL_NO_SYNC_KHR;
  return true;
}

void EncoderTargets::allocate(Slot& slot) {
  slot.reservation = MemoryBudget::instance().reserve(
      static_cast<uint64_t>(width) * height * 4, "android encoder ahardwarebuffer");
  AHardwareBuffer_Desc descriptor{};
  descriptor.width = width;
  descriptor.height = height;
  descriptor.layers = 1;
  descriptor.format = AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM;
  descriptor.usage = AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE | AHARDWAREBUFFER_USAGE_GPU_COLOR_OUTPUT;
  const int result = AHardwareBuffer_allocate(&descriptor, &slot.buffer);
  if (result != 0 || !slot.buffer)
    throw std::runtime_error("Encoder AHardwareBuffer allocation failed: " + std::to_string(result));
  AHardwareBuffer_Desc actual{};
  AHardwareBuffer_describe(slot.buffer, &actual);
  if (actual.width != descriptor.width || actual.height != descriptor.height ||
      actual.format != descriptor.format || actual.stride < descriptor.width ||
      (actual.usage & descriptor.usage) != descriptor.usage)
    throw std::runtime_error("Invalid encoder AHardwareBuffer layout");
  MemoryBudget::instance().resize(slot.reservation, static_cast<uint64_t>(actual.stride) * height * 4,
                                  "android encoder ahardwarebuffer padded stride");
}

void EncoderTargets::bindTexture(Slot& slot) {
  if (slot.texture) return;
  const auto display = eglGetCurrentDisplay();
  if (display == EGL_NO_DISPLAY || eglGetCurrentContext() == EGL_NO_CONTEXT)
    throw std::runtime_error("Encoder buffer import needs the encoder EGL context");
  const EGLint attributes[] = {EGL_IMAGE_PRESERVED_KHR, EGL_TRUE, EGL_NONE};
  slot.display = display;
  slot.image = egl().createImage(display, EGL_NO_CONTEXT, EGL_NATIVE_BUFFER_ANDROID,
                                 egl().clientBuffer(slot.buffer), attributes);
  if (slot.image == EGL_NO_IMAGE_KHR)
    throw std::runtime_error("Cannot import encoder AHardwareBuffer: EGL error " + std::to_string(eglGetError()));
  GLint previous = 0;
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &previous);
  glGenTextures(1, &slot.texture);
  glBindTexture(GL_TEXTURE_2D, slot.texture);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  egl().imageTarget(GL_TEXTURE_2D, slot.image);
  glBindTexture(GL_TEXTURE_2D, previous);
  const auto error = glGetError();
  if (error != GL_NO_ERROR)
    throw std::runtime_error("Encoder AHardwareBuffer texture binding failed: GL error " + std::to_string(error));
}

AHardwareBuffer* EncoderTargets::lend() {
  if (lent >= 0 || encoding >= 0)
    throw std::runtime_error("Previous encoder frame buffer was neither encoded nor released");
  // A buffer whose last frame the encoder already sampled.
  for (size_t i = 0; i < slots.size(); ++i) {
    if (waitReads(slots[i], 0)) {
      lent = static_cast<int>(i);
      return slots[i].buffer;
    }
  }
  if (slots.size() < kCapacity) {
    slots.emplace_back();
    try {
      allocate(slots.back());
    } catch (...) {
      auto& slot = slots.back();
      if (slot.buffer) AHardwareBuffer_release(slot.buffer);
      if (slot.reservation) MemoryBudget::instance().release(slot.reservation);
      slots.pop_back();
      throw;
    }
    lent = static_cast<int>(slots.size() - 1);
    return slots.back().buffer;
  }
  for (size_t i = 0; i < slots.size(); ++i) {
    if (waitReads(slots[i], kWaitNanoseconds)) {
      lent = static_cast<int>(i);
      return slots[i].buffer;
    }
  }
  throw std::runtime_error("Encoder buffers stayed in use for 5 seconds");
}

void EncoderTargets::giveBack() { lent = -1; }

bool EncoderTargets::isLent(const AHardwareBuffer* buffer) const {
  return lent >= 0 && buffer && slots[lent].buffer == buffer;
}

GLuint EncoderTargets::beginEncode(const AHardwareBuffer* buffer, std::vector<int>& fences) {
  if (!isLent(buffer)) throw std::runtime_error("Encoder frame buffer is not the one lent");
  // The renderer's writes, and its release of the buffer, end before GL reads.
  for (auto& fence : fences) waitFence(fence);
  auto& slot = slots[lent];
  bindTexture(slot);
  encoding = lent;
  lent = -1;
  return slot.texture;
}

void EncoderTargets::finishEncode() {
  if (encoding < 0) return;
  auto& slot = slots[encoding];
  encoding = -1;
  const auto display = eglGetCurrentDisplay();
  slot.reads = display == EGL_NO_DISPLAY ? EGL_NO_SYNC_KHR
                                         : egl().createSync(display, EGL_SYNC_FENCE_KHR, nullptr);
  if (slot.reads == EGL_NO_SYNC_KHR) {
    // No fence to poll later: complete the reads now.
    glFinish();
    return;
  }
  slot.display = display;
  glFlush();
}

void EncoderTargets::clear() {
  for (auto& slot : slots) {
    if (!waitReads(slot, kWaitNanoseconds)) glFinish();
    if (slot.reads != EGL_NO_SYNC_KHR) {
      egl().destroySync(slot.display, slot.reads);
      slot.reads = EGL_NO_SYNC_KHR;
    }
    if (slot.texture) glDeleteTextures(1, &slot.texture);
    slot.texture = 0;
    if (slot.image != EGL_NO_IMAGE_KHR) egl().destroyImage(slot.display, slot.image);
    slot.image = EGL_NO_IMAGE_KHR;
    if (slot.buffer) AHardwareBuffer_release(slot.buffer);
    slot.buffer = nullptr;
    if (slot.reservation) MemoryBudget::instance().release(slot.reservation);
    slot.reservation = 0;
  }
  slots.clear();
  lent = -1;
  encoding = -1;
}

} // namespace RNSkiaVideo

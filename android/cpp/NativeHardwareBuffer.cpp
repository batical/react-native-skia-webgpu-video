#include "NativeHardwareBuffer.h"
#include "RNSVMemoryBudget.h"
#include <fbjni/ByteBuffer.h>
#include <android/log.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <atomic>
#include <cerrno>
#include <cstring>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace RNSkiaVideo {
using namespace facebook::jni;
namespace {
std::atomic<bool> interopEnabled{false};
std::atomic<uint64_t> nextHandle{1};
std::mutex registryMutex;
std::unordered_map<uint64_t, std::shared_ptr<HardwareFrameStorage>> frames;

struct Unsupported final : std::runtime_error {
  explicit Unsupported(const std::string& detail)
      : std::runtime_error("Android native buffer interop unavailable: " + detail) {}
};
bool extension(const char* values, const char* name) {
  if (!values) return false;
  const size_t length = std::strlen(name);
  for (const char* p = values; (p = std::strstr(p, name)); p += length)
    if ((p == values || p[-1] == ' ') && (p[length] == 0 || p[length] == ' ')) return true;
  return false;
}
void checkGl(const char* operation) {
  const auto error = glGetError();
  if (error != GL_NO_ERROR)
    throw std::runtime_error(std::string(operation) + " failed: GL error " + std::to_string(error));
}
uint64_t newId() {
  const auto id = nextHandle.fetch_add(1);
  if (id == 0 || id > static_cast<uint64_t>(std::numeric_limits<jlong>::max()))
    throw std::runtime_error("Hardware buffer lease identifiers exhausted");
  return id;
}
uint64_t addFrame(const std::shared_ptr<HardwareFrameStorage>& owner) {
  const auto id = newId();
  std::lock_guard<std::mutex> lock(registryMutex);
  frames.emplace(id, owner);
  return id;
}
void releaseFrame(uint64_t handle) {
  std::shared_ptr<HardwareFrameStorage> released;
  {
    std::lock_guard<std::mutex> lock(registryMutex);
    auto found = frames.find(handle);
    if (found == frames.end()) return;
    released = std::move(found->second);
    frames.erase(found);
  }
}

struct RenderTarget final {
  std::shared_ptr<HardwareFrameStorage> owner;
  EGLDisplay display = EGL_NO_DISPLAY;
  EGLContext context = EGL_NO_CONTEXT;
  EGLImageKHR image = EGL_NO_IMAGE_KHR;
  GLuint texture = 0;
  uint64_t id = 0;
  RenderTarget* quarantineNext = nullptr;
  PFNEGLDESTROYIMAGEKHRPROC destroyImage = nullptr;
  ~RenderTarget() {
    if (texture) glDeleteTextures(1, &texture);
    if (image != EGL_NO_IMAGE_KHR && destroyImage) destroyImage(display, image);
  }
};
std::unordered_map<uint64_t, std::unique_ptr<RenderTarget>> writers;
RenderTarget* quarantinedWriters = nullptr;

void quarantineWriter(std::unique_ptr<RenderTarget> writer) {
  // Intrusive storage: uncertain GPU completion must not require a successful
  // heap allocation to keep its backing and reservation alive.
  std::lock_guard<std::mutex> lock(registryMutex);
  writer->quarantineNext = quarantinedWriters;
  quarantinedWriters = writer.release();
}

std::unique_ptr<RenderTarget> makeTarget(int width, int height) {
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384)
    throw std::invalid_argument("Invalid hardware video frame dimensions");
  auto display = eglGetCurrentDisplay();
  auto context = eglGetCurrentContext();
  if (display == EGL_NO_DISPLAY || context == EGL_NO_CONTEXT)
    throw std::runtime_error("Hardware frame producer has no current EGL context");
  const auto* eglExtensions = eglQueryString(display, EGL_EXTENSIONS);
  const auto* glExtensions = reinterpret_cast<const char*>(glGetString(GL_EXTENSIONS));
  if (!extension(eglExtensions, "EGL_ANDROID_get_native_client_buffer") ||
      !extension(eglExtensions, "EGL_ANDROID_image_native_buffer") ||
      !extension(eglExtensions, "EGL_KHR_image_base") ||
      !extension(glExtensions, "GL_OES_EGL_image"))
    throw Unsupported("required EGLImage/AHardwareBuffer extensions are absent");
  auto getClientBuffer = reinterpret_cast<PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC>(
      eglGetProcAddress("eglGetNativeClientBufferANDROID"));
  auto createImage = reinterpret_cast<PFNEGLCREATEIMAGEKHRPROC>(eglGetProcAddress("eglCreateImageKHR"));
  auto destroyImage = reinterpret_cast<PFNEGLDESTROYIMAGEKHRPROC>(eglGetProcAddress("eglDestroyImageKHR"));
  auto imageTarget = reinterpret_cast<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>(
      eglGetProcAddress("glEGLImageTargetTexture2DOES"));
  if (!getClientBuffer || !createImage || !destroyImage || !imageTarget)
    throw Unsupported("required EGLImage entry points are absent");

  auto target = std::make_unique<RenderTarget>();
  target->owner = std::make_shared<HardwareFrameStorage>();
  auto& owner = *target->owner;
  owner.reservation = MemoryBudget::instance().reserve(
      static_cast<uint64_t>(width) * height * 4, "android-frame-ahardwarebuffer");
  AHardwareBuffer_Desc descriptor{};
  descriptor.width = width; descriptor.height = height; descriptor.layers = 1;
  descriptor.format = AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM;
  descriptor.usage = AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE |
      AHARDWAREBUFFER_USAGE_GPU_COLOR_OUTPUT | AHARDWAREBUFFER_USAGE_CPU_READ_RARELY;
  const int result = AHardwareBuffer_allocate(&descriptor, &owner.buffer);
  if (result != 0) {
    if (result == -EINVAL || result == EINVAL)
      throw Unsupported("RGBA GPU color/sample buffer allocation is unsupported");
    throw std::runtime_error("AHardwareBuffer allocation failed: " + std::to_string(result));
  }
  AHardwareBuffer_describe(owner.buffer, &owner.description);
  if (owner.description.format != descriptor.format || owner.description.layers != 1 ||
      owner.description.width != descriptor.width || owner.description.height != descriptor.height ||
      owner.description.stride < descriptor.width ||
      (owner.description.usage & descriptor.usage) != descriptor.usage)
    throw std::runtime_error("Invalid allocated RGBA hardware buffer layout");
  MemoryBudget::instance().resize(owner.reservation,
      static_cast<uint64_t>(owner.description.stride) * height * 4,
      "android-frame-ahardwarebuffer padded stride");
  target->display = display; target->context = context; target->destroyImage = destroyImage;
  const EGLint attributes[] = {EGL_IMAGE_PRESERVED_KHR, EGL_TRUE, EGL_NONE};
  target->image = createImage(display, EGL_NO_CONTEXT, EGL_NATIVE_BUFFER_ANDROID,
      getClientBuffer(owner.buffer), attributes);
  if (target->image == EGL_NO_IMAGE_KHR)
    throw std::runtime_error("Cannot import hardware producer EGLImage: " + std::to_string(eglGetError()));
  GLint previousTexture = 0;
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &previousTexture);
  glGenTextures(1, &target->texture);
  glBindTexture(GL_TEXTURE_2D, target->texture);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  imageTarget(GL_TEXTURE_2D, target->image);
  glBindTexture(GL_TEXTURE_2D, previousTexture);
  checkGl("Hardware frame EGLImage binding");
  return target;
}

jlong create(alias_ref<jclass>, jint width, jint height) {
  auto writer = makeTarget(width, height);
  const auto id = newId();
  writer->id = id;
  std::lock_guard<std::mutex> lock(registryMutex);
  writers.emplace(id, std::move(writer));
  return static_cast<jlong>(id);
}
jint texture(alias_ref<jclass>, jlong id) {
  std::lock_guard<std::mutex> lock(registryMutex);
  auto found = writers.find(id);
  if (found == writers.end()) throw std::runtime_error("Hardware render target is closed");
  if (found->second->context != eglGetCurrentContext())
    throw std::runtime_error("Hardware render target has a different EGL context");
  return found->second->texture;
}
std::unique_ptr<RenderTarget> removeWriter(uint64_t id) {
  std::lock_guard<std::mutex> lock(registryMutex);
  auto found = writers.find(id);
  if (found == writers.end()) {
    for (auto** previous = &quarantinedWriters; *previous; previous = &(*previous)->quarantineNext) {
      auto* writer = *previous;
      if (writer->id != id) continue;
      if (writer->context != eglGetCurrentContext())
        throw std::runtime_error("Hardware render target has a different EGL context");
      *previous = writer->quarantineNext;
      writer->quarantineNext = nullptr;
      return std::unique_ptr<RenderTarget>(writer);
    }
    return nullptr;
  }
  if (found->second->context != eglGetCurrentContext())
    throw std::runtime_error("Hardware render target has a different EGL context");
  auto writer = std::move(found->second);
  writers.erase(found);
  return writer;
}
jlong finish(alias_ref<jclass>, jlong id) {
  auto writer = removeWriter(id);
  if (!writer) throw std::runtime_error("Hardware render target is closed");
  // RN WebGPU's native-buffer wrapper accepts no incoming producer fence.
  // Finish and validate our isolated EGL work before making the pointer visible.
  try {
    glFinish();
    checkGl("Hardware frame producer completion");
  } catch (...) {
    // Keep the allocation and budget live while producer completion is unknown.
    quarantineWriter(std::move(writer));
    throw;
  }
  return static_cast<jlong>(addFrame(writer->owner));
}
void abort(alias_ref<jclass>, jlong id) {
  auto writer = removeWriter(id);
  if (!writer) return;
  try {
    glFinish();
    checkGl("Abandoned hardware frame producer completion");
  } catch (...) {
    quarantineWriter(std::move(writer));
    throw;
  }
}
jlong retain(alias_ref<jclass>, jlong id) {
  return static_cast<jlong>(addFrame(acquireHardwareFrame(id)));
}
void release(alias_ref<jclass>, jlong id) { releaseFrame(id); }
jboolean enabled(alias_ref<jclass>) { return interopEnabled.load(); }
void read(alias_ref<jclass>, jlong id, alias_ref<JByteBuffer> destination) {
  auto owner = acquireHardwareFrame(id);
  auto* env = Environment::current();
  auto* bytes = static_cast<uint8_t*>(env->GetDirectBufferAddress(destination.get()));
  const auto capacity = env->GetDirectBufferCapacity(destination.get());
  const size_t row = static_cast<size_t>(owner->description.width) * 4;
  if (!bytes || capacity < 0 || static_cast<uint64_t>(capacity) < row * owner->description.height)
    throw std::invalid_argument("Hardware frame readback destination is too small");
  void* source = nullptr;
  const int result = AHardwareBuffer_lock(owner->buffer, AHARDWAREBUFFER_USAGE_CPU_READ_RARELY,
      -1, nullptr, &source);
  if (result != 0 || !source) throw std::runtime_error("Hardware frame diagnostic CPU lock failed");
  for (size_t y = 0; y < owner->description.height; ++y)
    std::memcpy(bytes + y * row, static_cast<uint8_t*>(source) +
        y * owner->description.stride * 4, row);
  if (AHardwareBuffer_unlock(owner->buffer, nullptr) != 0)
    throw std::runtime_error("Hardware frame diagnostic CPU unlock failed");
}

void probe() {
  const auto previousDisplay = eglGetCurrentDisplay();
  const auto previousContext = eglGetCurrentContext();
  const auto previousDraw = eglGetCurrentSurface(EGL_DRAW);
  const auto previousRead = eglGetCurrentSurface(EGL_READ);
  auto display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  if (display == EGL_NO_DISPLAY || !eglInitialize(display, nullptr, nullptr))
    throw std::runtime_error("Cannot initialize hardware-frame probe EGL display");
  EGLContext context = EGL_NO_CONTEXT;
  EGLSurface surface = EGL_NO_SURFACE;
  const auto cleanup = [&] {
    bool restored = false;
    if (previousContext != EGL_NO_CONTEXT) {
      restored = eglMakeCurrent(previousDisplay, previousDraw, previousRead, previousContext);
    } else restored = eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (!restored) eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (surface != EGL_NO_SURFACE) eglDestroySurface(display, surface);
    if (context != EGL_NO_CONTEXT) eglDestroyContext(display, context);
    // The initialized default display is process-owned; never eglTerminate it.
    if (!restored) throw std::runtime_error("Cannot restore caller EGL context after hardware-frame probe");
  };
  std::exception_ptr failure;
  try {
    const EGLint attributes[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
      EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8,
      EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
    EGLConfig config; EGLint count = 0;
    if (!eglChooseConfig(display, attributes, &config, 1, &count) || count == 0)
      throw Unsupported("no RGBA EGL producer configuration");
    const EGLint contextAttributes[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
    const EGLint surfaceAttributes[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
    surface = eglCreatePbufferSurface(display, config, surfaceAttributes);
    if (context == EGL_NO_CONTEXT || surface == EGL_NO_SURFACE ||
        !eglMakeCurrent(display, surface, surface, context))
      throw std::runtime_error("Cannot create hardware-frame probe EGL context");
    {
      auto target = makeTarget(4, 4);
      GLuint framebuffer = 0;
      glGenFramebuffers(1, &framebuffer);
      glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
      glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, target->texture, 0);
      const auto complete = glCheckFramebufferStatus(GL_FRAMEBUFFER);
      glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
      glBindFramebuffer(GL_FRAMEBUFFER, 0);
      glDeleteFramebuffers(1, &framebuffer);
      if (complete != GL_FRAMEBUFFER_COMPLETE)
        throw Unsupported("RGBA hardware buffer is not an EGL color render target");
      checkGl("Hardware-frame probe");
    }
  } catch (...) { failure = std::current_exception(); }
  cleanup();
  if (failure) std::rethrow_exception(failure);
}
} // namespace

HardwareFrameStorage::~HardwareFrameStorage() {
  if (buffer) AHardwareBuffer_release(buffer);
  if (reservation) MemoryBudget::instance().release(reservation);
}
std::shared_ptr<HardwareFrameStorage> acquireHardwareFrame(uint64_t handle) {
  std::lock_guard<std::mutex> lock(registryMutex);
  auto found = frames.find(handle);
  if (found == frames.end()) throw std::runtime_error("Hardware video frame is disposed");
  return found->second;
}
bool NativeHardwareBuffer::isEnabled() { return interopEnabled.load(); }
void NativeHardwareBuffer::configure(bool value) {
  if (!value) { interopEnabled.store(false); return; }
  if (!interopEnabled.load()) probe();
  interopEnabled.store(true);
}
void NativeHardwareBuffer::registerNatives() {
  javaClassStatic()->registerNatives({makeNativeMethod("nativeCreateRenderTarget", create),
    makeNativeMethod("nativeRenderTargetTexture", texture), makeNativeMethod("nativeFinishRenderTarget", finish),
    makeNativeMethod("nativeAbortRenderTarget", abort), makeNativeMethod("nativeRetain", retain),
    makeNativeMethod("nativeRelease", release), makeNativeMethod("nativeReadPixels", read),
    makeNativeMethod("nativeIsEnabled", enabled)});
}
} // namespace RNSkiaVideo

package com.azzapp.rnskv;

import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicLong;

/** Private immutable AHB ownership. Native writers may only be used on their EGL thread. */
final class NativeHardwareBuffer {
  static { System.loadLibrary("react-native-skia-video"); }
  private static final BufferLifetime lifetimes = new BufferLifetime(NativeHardwareBuffer::nativeRelease);
  static {
    Thread reaper = new Thread(lifetimes::run, "SkiaVideoHardwareBufferReaper");
    reaper.setDaemon(true);
    reaper.start();
  }
  private NativeHardwareBuffer() {}

  static final class Lease {
    private final AtomicLong handle;
    Lease(long handle) {
      if (handle <= 0) throw new IllegalArgumentException("Invalid hardware frame lease");
      try {
        this.handle = new AtomicLong(handle);
        lifetimes.track(this, null, handle);
      }
      catch (Throwable error) { nativeRelease(handle); throw error; }
    }
    synchronized long get() {
      long value = handle.get();
      if (value == 0) throw new IllegalStateException("Hardware video frame is disposed");
      return value;
    }
    synchronized long retain() { return nativeRetain(get()); }
    synchronized void read(ByteBuffer destination) { nativeReadPixels(get(), destination); }
    synchronized void close() {
      long value = handle.getAndSet(0);
      if (value != 0) nativeRelease(value);
    }
  }

  static boolean isEnabled() { return nativeIsEnabled(); }
  static long createRenderTarget(int width, int height) { return nativeCreateRenderTarget(width, height); }
  static int renderTargetTexture(long handle) { return nativeRenderTargetTexture(handle); }
  static long finishRenderTarget(long handle) { return nativeFinishRenderTarget(handle); }
  static void abortRenderTarget(long handle) { nativeAbortRenderTarget(handle); }
  static void release(long handle) { if (handle != 0) nativeRelease(handle); }
  /** Takes over {@code image} on success; on failure the caller still owns it. */
  static long wrapImage(android.hardware.HardwareBuffer buffer, android.media.Image image,
      int cropX, int cropY, int cropWidth, int cropHeight, int rotation) {
    return nativeWrapImage(buffer, image, cropX, cropY, cropWidth, cropHeight, rotation);
  }
  private static native boolean nativeIsEnabled();
  private static native long nativeCreateRenderTarget(int width, int height);
  private static native int nativeRenderTargetTexture(long handle);
  private static native long nativeFinishRenderTarget(long handle);
  private static native void nativeAbortRenderTarget(long handle);
  private static native long nativeRetain(long handle);
  private static native void nativeRelease(long handle);
  private static native void nativeReadPixels(long handle, ByteBuffer destination);
  // fbjni registers alias_ref<jobject> parameters as java.lang.Object.
  private static native long nativeWrapImage(Object buffer, Object image, int cropX, int cropY,
      int cropWidth, int cropHeight, int rotation);
}

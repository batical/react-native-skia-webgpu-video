package com.azzapp.rnskv;

import java.nio.ByteBuffer;

/** Owned pixel storage; no full-frame memcpy across the Java/JSI boundary. */
final class NativeRgbaBuffer {
  static {
    System.loadLibrary("react-native-skia-video");
  }
  private static final BufferLifetime lifetimes = new BufferLifetime(NativeRgbaBuffer::nativeRelease);
  static {
    Thread reaper = new Thread(lifetimes::run, "SkiaVideoBufferReaper");
    reaper.setDaemon(true);
    reaper.start();
  }
  private NativeRgbaBuffer() {}

  private static final RgbaBufferAllocator allocator = new RgbaBufferAllocator(lifetimes,
    NativeRgbaBuffer::nativeReserve, NativeRgbaBuffer::nativeRelease,
    // ART-managed, non-moving backing creates real Java GC pressure.
    ByteBuffer::allocateDirect, NativeRgbaBuffer::nativeAlias, size -> {
      Runtime runtime = Runtime.getRuntime();
      RgbaBufferAllocator.checkAllocationCapacity(size, runtime.maxMemory());
    });

  static ByteBuffer allocate(int size) { return allocator.allocate(size); }

  static long[] budgetStats() { return nativeBudgetStats(); }
  static void configureBudget(long bytes) { nativeConfigureBudget(bytes); }
  private static native long nativeReserve(int size);
  private static native ByteBuffer nativeAlias(ByteBuffer backing);
  private static native void nativeRelease(long token);
  private static native long[] nativeBudgetStats();
  private static native void nativeConfigureBudget(long bytes);
}

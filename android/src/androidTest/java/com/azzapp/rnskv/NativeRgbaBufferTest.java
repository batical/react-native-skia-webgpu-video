package com.azzapp.rnskv;

import android.os.SystemClock;
import org.junit.Test;
import java.nio.ByteBuffer;
import java.lang.ref.WeakReference;
import static org.junit.Assert.*;

/** Device-only lifetime checks: JVM ByteBuffers do not model Android JNI roots. */
public class NativeRgbaBufferTest {
  private static void collectUntil(java.util.function.BooleanSupplier condition) {
    long end = SystemClock.uptimeMillis() + 5000;
    do { System.gc(); System.runFinalization(); SystemClock.sleep(25); }
    while (!condition.getAsBoolean() && SystemClock.uptimeMillis() < end);
    assertTrue("GC did not reclaim unreferenced RGBA backing within 5 seconds", condition.getAsBoolean());
  }

  @Test public void readOnlySliceKeepsBudgetAndBytesAfterFrameIsDropped() {
    long baseline = NativeRgbaBuffer.budgetStats()[0];
    ByteBuffer owned = NativeRgbaBuffer.allocate(64);
    owned.put(8, (byte) 91);
    VideoFrame frame = new VideoFrame(owned, 4, 4, 0, 0, 1);
    ByteBuffer readOnly = frame.getPixelBuffer();
    readOnly.position(8);
    ByteBuffer retained = readOnly.slice().asReadOnlyBuffer();
    WeakReference<VideoFrame> oldFrame = new WeakReference<>(frame);
    frame = null; owned = null; readOnly = null;
    collectUntil(() -> oldFrame.get() == null);
    assertEquals(91, retained.get(0));
    assertTrue(retained.isReadOnly());
    assertEquals(baseline + 71, NativeRgbaBuffer.budgetStats()[0]);
    retained = null;
    collectUntil(() -> NativeRgbaBuffer.budgetStats()[0] == baseline);
  }

  @Test public void rejectedAllocationDoesNotLeaveReservation() {
    long[] baseline = NativeRgbaBuffer.budgetStats();
    NativeRgbaBuffer.configureBudget(baseline[0] + 8);
    try {
      try { NativeRgbaBuffer.allocate(64); fail("Expected memory budget rejection"); }
      catch (RuntimeException expected) {
        assertTrue(expected.getMessage().contains("budget"));
      }
      assertEquals(baseline[0], NativeRgbaBuffer.budgetStats()[0]);
      assertEquals(baseline[2], NativeRgbaBuffer.budgetStats()[2]);
    } finally { NativeRgbaBuffer.configureBudget(baseline[3]); }
  }

  @Test public void snapshotsAreDistinctAndReadOnlyViewsCannotModifyPixels() {
    ByteBuffer first = NativeRgbaBuffer.allocate(64);
    first.put(0, (byte) 31);
    VideoFrame frame = new VideoFrame(first, 4, 4, 0, 0, 1);
    ByteBuffer second = NativeRgbaBuffer.allocate(64); second.put(0, (byte) 63);
    assertEquals(31, frame.getPixelBuffer().get(0));
    try { frame.getPixelBuffer().put(0, (byte) 0); fail("Expected read-only view"); }
    catch (java.nio.ReadOnlyBufferException expected) { }
  }
  @Test public void artHeapRefusalDoesNotReserveOrAllocateTheHugeBacking() {
    long[] baseline = NativeRgbaBuffer.budgetStats();
    int impossibleSize = (int) Math.min(Integer.MAX_VALUE, Runtime.getRuntime().maxMemory());
    try { NativeRgbaBuffer.allocate(impossibleSize); fail("Expected ART heap refusal"); }
    catch (IllegalStateException expected) {
      assertTrue(expected.getMessage().contains("single-allocation Java heap capacity"));
    }
    assertEquals(baseline[0], NativeRgbaBuffer.budgetStats()[0]);
    assertEquals(baseline[2], NativeRgbaBuffer.budgetStats()[2]);
  }

  @Test public void budgetRefusalPropagatesAndReleaseClosesDecoderAndFrames() throws Exception {
    java.io.File cache = androidx.test.platform.app.InstrumentationRegistry
      .getInstrumentation().getTargetContext().getCacheDir();
    java.io.File video = TestVideo.write(new java.io.File(cache, "budget-refusal.mp4"), 1);
    VideoComposition composition = Compositions.composition(video, false,
      new Compositions.Clip("a", 0, 0, 1));
    Export export = new Export(composition);
    VideoCompositionDecoder decoder = export.decoder();
    long[] baseline = NativeRgbaBuffer.budgetStats();
    NativeRgbaBuffer.configureBudget(baseline[0] + 8);
    try {
      try { export.frames(0.2); fail("Expected decode memory budget refusal"); }
      catch (Exception error) {
        Throwable cause = error;
        while (cause.getCause() != null) cause = cause.getCause();
        assertTrue(String.valueOf(error), cause instanceof RuntimeException);
        assertTrue(String.valueOf(error), String.valueOf(cause.getMessage()).contains("budget"));
      }
    } finally {
      export.close();
      NativeRgbaBuffer.configureBudget(baseline[3]);
    }
    // release() queues GL/codec cleanup on the owning export thread.
    long deadline = SystemClock.uptimeMillis() + 3000;
    while (Compositions.openCount(decoder, composition) != 0 && SystemClock.uptimeMillis() < deadline)
      SystemClock.sleep(10);
    assertEquals(0, Compositions.openCount(decoder, composition));
    assertTrue(((java.util.Map<?, ?>) Compositions.get(decoder, "videoFrames")).isEmpty());
    assertTrue(((DecodeRequests<?>) Compositions.get(export.extractor, "requests")).isClosed());
    // No backing was allocated by the rejected reservation.
    assertEquals(baseline[0], NativeRgbaBuffer.budgetStats()[0]);
  }

}

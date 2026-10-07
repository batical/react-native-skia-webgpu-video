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
}

package com.azzapp.rnskv;

import android.opengl.GLES20;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import javax.microedition.khronos.egl.EGL10;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Device-only EGL/AHB pixel and ownership checks, with no codec, Worklets or forced GC. */
public class NativeHardwareBufferTest {
  // Odd dimensions exercise the native packed-row copy when the AHB stride is padded.
  private static final int WIDTH = 5;
  private static final int HEIGHT = 3;
  private static final int BYTE_SIZE = WIDTH * HEIGHT * 4;
  private final ArrayList<NativeHardwareBuffer.Lease> leases = new ArrayList<>();
  private final ArrayList<VideoFrame> frames = new ArrayList<>();
  private EGLResourcesHolder producer;
  private long[] baseline;

  @Before public void setUp() {
    baseline = NativeRgbaBuffer.budgetStats();
    producer = EGLResourcesHolder.createWithPBBufferSurface(EGL10.EGL_NO_CONTEXT);
    try {
      producer.runWithContextCurrent(() -> {
        long writer = NativeHardwareBuffer.createRenderTarget(WIDTH, HEIGHT);
        int[] framebuffer = new int[1];
        try {
          GLES20.glGenFramebuffers(1, framebuffer, 0);
          GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer[0]);
          GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER,
            GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D,
            NativeHardwareBuffer.renderTargetTexture(writer), 0);
          int status = GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER);
          assumeTrue("AHardwareBuffer RGBA EGL color target is unsupported: " + status,
            status == GLES20.GL_FRAMEBUFFER_COMPLETE);
          assertGl("AHB capability check");
        } finally {
          detachFramebuffer(framebuffer);
          NativeHardwareBuffer.abortRenderTarget(writer);
        }
      });
    } catch (RuntimeException error) {
      String message = String.valueOf(error.getMessage());
      if (!message.contains("Android native buffer interop unavailable:")) throw error;
      assumeTrue(message, false);
    }
    assertBudget(baseline);
  }

  @After public void tearDown() {
    try {
      for (VideoFrame frame : frames) frame.close();
      for (NativeHardwareBuffer.Lease lease : leases) lease.close();
    } finally {
      try {
        if (producer != null) producer.release();
      } finally {
        if (baseline != null) NativeRgbaBuffer.configureBudget(baseline[3]);
      }
    }
    if (baseline != null) assertBudget(baseline);
  }

  @Test public void finishPublishesCompletedRgbaPixelsWithPackedRows() {
    NativeHardwareBuffer.Lease ready = own(publishPattern());
    ByteBuffer pixels = ByteBuffer.allocateDirect(BYTE_SIZE);
    // No test-side glFinish: the producer's finishRenderTarget must establish completion.
    ready.read(pixels);
    assertPattern(pixels);
    assertEquals(baseline[2] + 1, NativeRgbaBuffer.budgetStats()[2]);
    assertTrue(NativeRgbaBuffer.budgetStats()[0] >= baseline[0] + BYTE_SIZE);
    ready.close();
    assertBudget(baseline);
  }

  @Test public void retainedLeaseSurvivesOriginalCloseAndEglProducerTeardown() {
    NativeHardwareBuffer.Lease original = own(publishPattern());
    NativeHardwareBuffer.Lease retained = own(original.retain());
    assertNotEquals(original.get(), retained.get());
    long[] sharedOwner = NativeRgbaBuffer.budgetStats();
    assertEquals(baseline[2] + 1, sharedOwner[2]);
    original.close();
    original.close();
    producer.release();
    producer = null;
    assertBudget(sharedOwner);
    ByteBuffer pixels = ByteBuffer.allocateDirect(BYTE_SIZE);
    retained.read(pixels);
    assertPattern(pixels);
    retained.close();
    retained.close();
    assertBudget(baseline);
  }

  @Test public void videoFrameRetainKeepsIdentityAndIndependentOwnership() {
    VideoFrame original = new VideoFrame(publishPattern(), WIDTH, HEIGHT, 270,
      123456789L, 73L);
    frames.add(original);
    VideoFrame retained = original.retain();
    frames.add(retained);
    assertNotSame(original, retained);
    assertEquals(original.getId(), retained.getId());
    assertEquals(73L, retained.getProducerId());
    assertEquals(123456789L, retained.getTimestampNs());
    assertEquals(WIDTH, retained.getWidth());
    assertEquals(HEIGHT, retained.getHeight());
    assertEquals(270, retained.getRotation());
    assertTrue(retained.isHardwareBuffer());
    assertNotEquals(original.getNativeHardwareBufferHandle(),
      retained.getNativeHardwareBufferHandle());
    long[] sharedOwner = NativeRgbaBuffer.budgetStats();
    original.close();
    original.close();
    producer.release();
    producer = null;
    assertTrue(retained.getNativeHardwareBufferHandle() > 0);
    assertBudget(sharedOwner);
    try { original.getNativeHardwareBufferHandle(); fail("Closed frame exposed a lease"); }
    catch (IllegalStateException expected) {
      assertTrue(expected.getMessage().contains("disposed"));
    }
    retained.close();
    retained.close();
    assertBudget(baseline);
  }

  @Test public void abortIsIdempotentAndCannotPublishAClosedWriter() {
    producer.runWithContextCurrent(() -> {
      long writer = NativeHardwareBuffer.createRenderTarget(WIDTH, HEIGHT);
      int[] framebuffer = new int[1];
      try {
        assertTrue(NativeRgbaBuffer.budgetStats()[0] >= baseline[0] + BYTE_SIZE);
        GLES20.glGenFramebuffers(1, framebuffer, 0);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer[0]);
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER,
          GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D,
          NativeHardwareBuffer.renderTargetTexture(writer), 0);
        assertEquals(GLES20.GL_FRAMEBUFFER_COMPLETE,
          GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER));
        GLES20.glClearColor(0, 1, 0, 1);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        assertGl("Aborted AHB clear");
        detachFramebuffer(framebuffer);
        // Queue actual writes and rely on abort's native completion, not a test fence.
        NativeHardwareBuffer.abortRenderTarget(writer);
        NativeHardwareBuffer.abortRenderTarget(writer);
        assertBudget(baseline);
        try { NativeHardwareBuffer.finishRenderTarget(writer); fail("Aborted writer published a frame"); }
        catch (RuntimeException expected) {
          assertTrue(expected.getMessage().contains("closed"));
        }
        assertBudget(baseline);
      } finally {
        detachFramebuffer(framebuffer);
        NativeHardwareBuffer.abortRenderTarget(writer);
      }
    });
  }

  @Test public void quotaRefusalPreservesAnExistingLeaseAndReleasesPartialAllocation() {
    NativeHardwareBuffer.Lease existing = own(publishPattern());
    long[] existingOwner = NativeRgbaBuffer.budgetStats();
    long actualBytes = existingOwner[0] - baseline[0];
    assertTrue(actualBytes >= BYTE_SIZE);
    // If AHB rows are padded, the second reservation passes its initial packed size
    // and fails the later stride resize. Without padding, it fails before allocation.
    NativeRgbaBuffer.configureBudget(existingOwner[0] + actualBytes - 1);
    try {
      producer.runWithContextCurrent(() -> {
        long unexpectedWriter = 0;
        try {
          unexpectedWriter = NativeHardwareBuffer.createRenderTarget(WIDTH, HEIGHT);
          fail("Expected hardware frame memory budget refusal");
        } catch (RuntimeException expected) {
          assertTrue(String.valueOf(expected), expected.getMessage().contains("budget"));
        } finally {
          if (unexpectedWriter != 0) NativeHardwareBuffer.abortRenderTarget(unexpectedWriter);
        }
      });
      assertBudget(existingOwner);
      ByteBuffer pixels = ByteBuffer.allocateDirect(BYTE_SIZE);
      existing.read(pixels);
      assertPattern(pixels);
    } finally {
      NativeRgbaBuffer.configureBudget(baseline[3]);
    }
    existing.close();
    assertBudget(baseline);
  }

  @Test public void invalidReadDestinationAndClosedLeaseCannotExposePixels() {
    NativeHardwareBuffer.Lease ready = own(publishPattern());
    ByteBuffer shortBuffer = ByteBuffer.allocateDirect(BYTE_SIZE - 1);
    shortBuffer.put(0, (byte) 91);
    try { ready.read(shortBuffer); fail("Accepted an undersized read destination"); }
    catch (RuntimeException expected) {
      assertTrue(expected.getMessage().contains("too small"));
    }
    assertEquals(91, shortBuffer.get(0));
    try { ready.read(ByteBuffer.allocate(BYTE_SIZE)); fail("Accepted a non-direct destination"); }
    catch (RuntimeException expected) {
      assertTrue(expected.getMessage().contains("too small"));
    }
    ready.close();
    try { ready.read(ByteBuffer.allocateDirect(BYTE_SIZE)); fail("Read a disposed hardware frame"); }
    catch (IllegalStateException expected) {
      assertTrue(expected.getMessage().contains("disposed"));
    }
    assertBudget(baseline);
  }

  private NativeHardwareBuffer.Lease own(long handle) {
    NativeHardwareBuffer.Lease lease = new NativeHardwareBuffer.Lease(handle);
    leases.add(lease);
    return lease;
  }

  private long publishPattern() {
    return producer.withContextCurrent(() -> {
      long writer = NativeHardwareBuffer.createRenderTarget(WIDTH, HEIGHT);
      int[] framebuffer = new int[1];
      try {
        GLES20.glGenFramebuffers(1, framebuffer, 0);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer[0]);
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER,
          GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D,
          NativeHardwareBuffer.renderTargetTexture(writer), 0);
        assertEquals(GLES20.GL_FRAMEBUFFER_COMPLETE,
          GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER));
        GLES20.glViewport(0, 0, WIDTH, HEIGHT);
        GLES20.glDisable(GLES20.GL_DITHER);
        GLES20.glEnable(GLES20.GL_SCISSOR_TEST);
        clear(0, 0, WIDTH / 2, HEIGHT / 2, 1, 0, 0);
        clear(WIDTH / 2, 0, WIDTH - WIDTH / 2, HEIGHT / 2, 0, 1, 0);
        clear(0, HEIGHT / 2, WIDTH / 2, HEIGHT - HEIGHT / 2, 0, 0, 1);
        clear(WIDTH / 2, HEIGHT / 2, WIDTH - WIDTH / 2,
          HEIGHT - HEIGHT / 2, 1, 1, 1);
        GLES20.glDisable(GLES20.GL_SCISSOR_TEST);
        assertGl("AHB quadrant clear");
        detachFramebuffer(framebuffer);
        long ready = NativeHardwareBuffer.finishRenderTarget(writer);
        writer = 0;
        return ready;
      } finally {
        detachFramebuffer(framebuffer);
        if (writer != 0) NativeHardwareBuffer.abortRenderTarget(writer);
      }
    });
  }

  private static void clear(int x, int y, int width, int height,
      float red, float green, float blue) {
    GLES20.glScissor(x, y, width, height);
    GLES20.glClearColor(red, green, blue, 1);
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
  }

  private static void detachFramebuffer(int[] framebuffer) {
    if (framebuffer[0] == 0) return;
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer[0]);
    GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0,
      GLES20.GL_TEXTURE_2D, 0, 0);
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
    GLES20.glDeleteFramebuffers(1, framebuffer, 0);
    framebuffer[0] = 0;
  }

  private static void assertPattern(ByteBuffer pixels) {
    for (int y = 0; y < HEIGHT; y++) {
      for (int x = 0; x < WIDTH; x++) {
        int[] expected = y < HEIGHT / 2
          ? (x < WIDTH / 2 ? new int[]{255, 0, 0, 255} : new int[]{0, 255, 0, 255})
          : (x < WIDTH / 2 ? new int[]{0, 0, 255, 255} : new int[]{255, 255, 255, 255});
        int offset = (y * WIDTH + x) * 4;
        for (int channel = 0; channel < 4; channel++) {
          assertEquals("RGBA pixel " + x + "," + y + " channel " + channel,
            expected[channel], pixels.get(offset + channel) & 255);
        }
      }
    }
  }

  private static void assertGl(String operation) {
    assertEquals(operation, GLES20.GL_NO_ERROR, GLES20.glGetError());
  }

  private static void assertBudget(long[] expected) {
    long[] actual = NativeRgbaBuffer.budgetStats();
    assertEquals("Owned bytes", expected[0], actual[0]);
    assertEquals("Reservation count", expected[2], actual[2]);
  }
}

package com.azzapp.rnskv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import android.media.MediaCodec;
import org.junit.Test;

public class SurfaceOutputPolicyTest {
  @Test public void surfaceFrameDoesNotNeedAnAccessiblePayload() {
    assertTrue(SurfaceOutputPolicy.hasFrame(0, 0));
    assertTrue(SurfaceOutputPolicy.hasFrame(0, MediaCodec.BUFFER_FLAG_KEY_FRAME));
  }
  @Test public void lastFrameWithPixelsIsRenderedBeforeEndOfStream() {
    assertTrue(SurfaceOutputPolicy.hasFrame(1, MediaCodec.BUFFER_FLAG_END_OF_STREAM));
  }
  @Test public void emptyEndOfStreamIsNotRenderedAsAnExtraFrame() {
    assertFalse(SurfaceOutputPolicy.hasFrame(0, MediaCodec.BUFFER_FLAG_END_OF_STREAM));
  }
  @Test public void configurationIsNotAPicture() {
    assertFalse(SurfaceOutputPolicy.hasFrame(4, MediaCodec.BUFFER_FLAG_CODEC_CONFIG));
  }
}

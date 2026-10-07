package com.azzapp.rnskv;

import static com.azzapp.rnskv.Compositions.composition;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.media.MediaFormat;

import androidx.test.platform.app.InstrumentationRegistry;

import com.azzapp.rnskv.Compositions.Clip;
import com.azzapp.rnskv.TestVideo.Spec;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.File;
import java.util.Arrays;
import java.util.List;

/**
 * Both requested texture modes produce the same owned reference pixels with
 * codec padding removed and rotation applied. Raw OES textures are never exposed.
 */
@RunWith(Parameterized.class)
public class DirectTextureTest {

  private static final String AVC = MediaFormat.MIMETYPE_VIDEO_AVC;

  private static final String HEVC = MediaFormat.MIMETYPE_VIDEO_HEVC;

  @Parameterized.Parameters(name = "{0}")
  public static List<Spec> specs() {
    return Arrays.asList(
      new Spec("avc-1080p", AVC, 1920, 1080, 30, 0),
      new Spec("avc-720p", AVC, 1280, 720, 30, 0),
      new Spec("avc-638x358", AVC, 638, 358, 30, 0),
      new Spec("hevc-4k", HEVC, 3840, 2160, 30, 0),
      new Spec("avc-1080p-rot90", AVC, 1920, 1080, 30, 90));
  }

  private final Spec spec;

  public DirectTextureTest(Spec spec) {
    this.spec = spec;
  }

  private static VideoComposition direct(File video, Clip clip, boolean direct) {
    VideoComposition composition = composition(video, false, clip);
    Compositions.set(Compositions.item(composition, clip.id), "directTexture", direct);
    return composition;
  }

  @Test
  public void bothModesKeepTheirPixelsCropOrientationAndTimestamp() throws Exception {
    assumeTrue(TestVideo.canEncode(spec));
    File cache = InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir();
    File video = TestVideo.write(new File(cache, "direct-" + spec.name + ".mp4"), 2, spec);
    Clip clip = new Clip("a", 0, 0, 2);
    int[] copyCenters = new int[3];
    boolean[][] copyMarkers = new boolean[3][];
    double[] times = {0.2, 0.5, 1.2};
    try (Export export = new Export(direct(video, clip, false))) {
      for (int i = 0; i < times.length; i++) {
        VideoFrame frame = export.frames(times[i]).get("a");
        copyCenters[i] = Pixels.center(frame)[0];
        copyMarkers[i] = Pixels.marker(frame);
      }
    }
    try (Export export = new Export(direct(video, clip, true))) {
      for (int i = 0; i < times.length; i++) {
        double time = times[i];
        VideoFrame frame = export.frames(time).get("a");
        Compositions.assertFrameAt(java.util.Map.of("a", frame), clip, time, 1_000);
        String at = spec + " at " + time + "s";
        assertEquals(at + " normalized rotation", 0, frame.getRotation());
        boolean rotated = spec.rotation == 90 || spec.rotation == 270;
        assertEquals(at + " cropped width", rotated ? spec.height : spec.width, frame.getWidth());
        assertEquals(at + " cropped height", rotated ? spec.width : spec.height, frame.getHeight());
        assertEquals(at + " packed stride", frame.getWidth() * 4, frame.getBytesPerRow());
        int center = Pixels.center(frame)[0];
        int expected = TestVideo.gray((int) Math.round(frame.getTimestampNs() / 1e9 * spec.fps));
        assertTrue(at + ": centre " + center + ", expected " + expected,
          Math.abs(center - expected) <= Pixels.TOLERANCE);
        assertTrue(at + ": centre " + center + ", the copy's " + copyCenters[i],
          Math.abs(center - copyCenters[i]) <= Pixels.TOLERANCE);
        org.junit.Assert.assertArrayEquals(at + " marker", copyMarkers[i], Pixels.marker(frame));
      }
    }
  }

  @Test
  public void oldPixelsRemainValidAcrossLaterFramesAndSessionDisposal() throws Exception {
    assumeTrue(TestVideo.canEncode(spec));
    File cache = InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir();
    File video = TestVideo.write(new File(cache, "owned-" + spec.name + ".mp4"), 2, spec);
    VideoFrame retained;
    int[] original;
    try (Export export = new Export(direct(video, new Clip("a", 0, 0, 2), true))) {
      retained = export.frames(0.2).get("a");
      original = Pixels.center(retained);
      export.frames(0.5);
      export.frames(1.2);
      org.junit.Assert.assertArrayEquals(original, Pixels.center(retained));
    }
    org.junit.Assert.assertArrayEquals(original, Pixels.center(retained));
  }
}

package com.azzapp.rnskv;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.nio.ByteBuffer;

/** Reads the owned CPU reference pixels; no GL context or share group is required. */
final class Pixels {
  static final int TOLERANCE = 3;
  private Pixels() {}

  static int[] center(VideoFrame frame) {
    return at(frame, frame.getWidth() / 2, frame.getHeight() / 2);
  }

  static int[] at(VideoFrame frame, int x, int y) {
    ByteBuffer pixels = frame.getPixelBuffer();
    int index = y * frame.getBytesPerRow() + x * 4;
    return new int[]{pixels.get(index) & 0xff, pixels.get(index + 1) & 0xff,
      pixels.get(index + 2) & 0xff};
  }

  static boolean[] marker(VideoFrame frame) {
    int w = frame.getWidth();
    int h = frame.getHeight();
    int[][] corners = {{w / 8, h / 8}, {w - w / 8, h / 8},
      {w / 8, h - h / 8}, {w - w / 8, h - h / 8}};
    int background = center(frame)[0];
    assertTrue("frame too bright to find the marker: " + background, background < 200);
    int found = -1;
    for (int i = 0; i < corners.length; i++) {
      if (at(frame, corners[i][0], corners[i][1])[0] > background + 50) {
        assertTrue("marker in two corners", found < 0);
        found = i;
      }
    }
    assertTrue("no marker in any corner", found >= 0);
    return new boolean[]{found % 2 == 0, found < 2};
  }

  static void assertShowsItsFrame(String label, VideoFrame frame, int fps) {
    assertNotNull(label + ": no frame", frame);
    int index = (int) Math.round(frame.getTimestampNs() / 1e9 * fps);
    int expected = TestVideo.gray(index);
    int[] rgb = center(frame);
    for (int channel : rgb) {
      assertTrue(label + ": frame " + index + " reads (" + rgb[0] + "," + rgb[1] + ","
          + rgb[2] + "), expected grey " + expected,
        Math.abs(channel - expected) <= TOLERANCE);
    }
  }
}

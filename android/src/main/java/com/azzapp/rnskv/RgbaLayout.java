package com.azzapp.rnskv;

/** Checked byte arithmetic shared by readback and encoder upload. */
final class RgbaLayout {
  private RgbaLayout() {}

  static int bytesPerRow(int width) {
    if (width <= 0 || width > Integer.MAX_VALUE / 4) {
      throw new IllegalArgumentException("Invalid RGBA width: " + width);
    }
    return width * 4;
  }

  static int byteSize(int width, int height) {
    int stride = bytesPerRow(width);
    if (height <= 0 || height > Integer.MAX_VALUE / stride) {
      throw new IllegalArgumentException("Invalid RGBA height: " + height);
    }
    return stride * height;
  }

  static int requiredBytes(int width, int height, int stride) {
    int packedStride = bytesPerRow(width);
    if (stride < packedStride || height <= 0) {
      throw new IllegalArgumentException("Invalid RGBA stride or height");
    }
    long bytes = (long) stride * (height - 1) + packedStride;
    if (bytes > Integer.MAX_VALUE) {
      throw new IllegalArgumentException("RGBA upload exceeds Android ByteBuffer limits");
    }
    return (int) bytes;
  }
}

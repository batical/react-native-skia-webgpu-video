package com.azzapp.rnskv;

import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicLong;

/** An owned RGBA snapshot. No decoder texture or recyclable codec buffer escapes this class. */
public final class VideoFrame {
  private static final AtomicLong nextId = new AtomicLong(1);
  private final long id = nextId.getAndIncrement();
  private final long producerId;
  private final ByteBuffer pixels;
  private final int width;
  private final int height;
  private final int rotation;
  private final long timestampNs;

  VideoFrame(ByteBuffer ownedPixels, int width, int height, int rotation, long timestampNs,
      long producerId) {
    int required = RgbaLayout.byteSize(width, height);
    if (!ownedPixels.isDirect() || ownedPixels.capacity() != required) {
      throw new IllegalArgumentException("RGBA frame byte size does not match its dimensions");
    }
    this.pixels = ownedPixels;
    this.producerId = producerId;
    this.width = width;
    this.height = height;
    this.rotation = rotation;
    this.timestampNs = timestampNs;
  }

  /** A read-only view; its JNI root retains the allocation until all aliases die. */
  public ByteBuffer getPixelBuffer() { return pixels.asReadOnlyBuffer(); }
  public int getWidth() { return width; }
  public int getHeight() { return height; }
  public int getBytesPerRow() { return RgbaLayout.bytesPerRow(width); }
  public int getRotation() { return rotation; }
  public long getTimestampNs() { return timestampNs; }
  public long getId() { return id; }
  public long getProducerId() { return producerId; }
}

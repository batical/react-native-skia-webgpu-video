package com.azzapp.rnskv;

import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicLong;

/** An owned RGBA snapshot. No decoder texture or recyclable codec buffer escapes this class. */
public final class VideoFrame implements AutoCloseable {
  private static final AtomicLong nextId = new AtomicLong(1);
  private final long id;
  private final long producerId;
  private final ByteBuffer pixels;
  private final NativeHardwareBuffer.Lease hardware;
  private final int width;
  private final int height;
  private final int rotation;
  private final long timestampNs;

  VideoFrame(ByteBuffer ownedPixels, int width, int height, int rotation, long timestampNs,
      long producerId) {
    this.id = nextId.getAndIncrement();
    int required = RgbaLayout.byteSize(width, height);
    if (!ownedPixels.isDirect() || ownedPixels.capacity() != required) {
      throw new IllegalArgumentException("RGBA frame byte size does not match its dimensions");
    }
    this.pixels = ownedPixels;
    this.hardware = null;
    this.producerId = producerId;
    this.width = width;
    this.height = height;
    this.rotation = rotation;
    this.timestampNs = timestampNs;
  }

  VideoFrame(long nativeLease, int width, int height, int rotation, long timestampNs,
      long producerId) {
    this(nativeLease, width, height, rotation, timestampNs, producerId, nextId.getAndIncrement());
  }

  private VideoFrame(long nativeLease, int width, int height, int rotation, long timestampNs,
      long producerId, long id) {
    this.hardware = new NativeHardwareBuffer.Lease(nativeLease);
    this.pixels = null;
    this.id = id; this.width = width; this.height = height; this.rotation = rotation;
    this.timestampNs = timestampNs; this.producerId = producerId;
  }

  public VideoFrame retain() {
    if (hardware == null) return this;
    long retained = hardware.retain();
    try { return new VideoFrame(retained, width, height, rotation, timestampNs, producerId, id); }
    catch (Throwable error) { NativeHardwareBuffer.release(retained); throw error; }
  }

  /** Releases only this wrapper. Other snapshots of the same immutable AHB survive. */
  @Override public void close() { if (hardware != null) hardware.close(); }
  public boolean isHardwareBuffer() { return hardware != null; }
  public long getNativeHardwareBufferHandle() { return hardware == null ? 0 : hardware.get(); }

  /** A read-only view; its JNI root retains the allocation until all aliases die. */
  public ByteBuffer getPixelBuffer() {
    if (hardware == null) return pixels.asReadOnlyBuffer();
    // Diagnostic/raw Java oracle only. Normal AHB rendering never reads CPU pixels.
    ByteBuffer destination = NativeRgbaBuffer.allocate(RgbaLayout.byteSize(width, height));
    hardware.read(destination);
    return destination.asReadOnlyBuffer();
  }
  public int getWidth() { return width; }
  public int getHeight() { return height; }
  public int getBytesPerRow() { return RgbaLayout.bytesPerRow(width); }
  public int getRotation() { return rotation; }
  public long getTimestampNs() { return timestampNs; }
  public long getId() { return id; }
  public long getProducerId() { return producerId; }
}

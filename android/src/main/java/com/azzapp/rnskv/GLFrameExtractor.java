package com.azzapp.rnskv;

import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.hardware.HardwareBuffer;
import android.hardware.SyncFence;
import android.media.Image;
import android.media.ImageReader;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A class that extracts frames from a SurfaceTexture streaming to an external texture and renders
 * them to a 2D texture.
 */
public class GLFrameExtractor implements SurfaceTexture.OnFrameAvailableListener {
  private static final AtomicLong nextProducerId = new AtomicLong(1);
  private final long producerId = nextProducerId.getAndIncrement();

  private final AtomicBoolean frameAvailable = new AtomicBoolean(false);

  private final float[] transformMatrix = new float[16];

  private final Surface surface;

  private final SurfaceTexture surfaceTexture;

  private int frameWidth = -1;

  private int frameHeight = -1;

  private final int inputTexId;

  private final int outputTexId;

  private final int frameBuffer;

  private final TextureRenderer textureRenderer;

  private OnFrameAvailableListener onFrameAvailableListener;

  private long latestTimeStampNs = -1;

  private final boolean direct;
  private final boolean hardwareBuffer;
  private long pendingHardwareFrame;

  private volatile boolean released;

  private int bufferWidth = -1;

  private int bufferHeight = -1;

  // ImageReader mode (API 29+): the codec writes GPU-sampled YUV buffers that
  // WebGPU imports directly, with no EGL render pass or glFinish per frame.
  // Enough images for the codec plus the frames still leased downstream.
  private static final int READER_IMAGES = 4;
  private static Handler readerCallbacks;
  private ImageReader imageReader;
  private int imageRotation;

  public GLFrameExtractor() {
    this(false);
  }

  /**
   * @param direct whether frames are handed over as the decoder's buffer, in
   *               the input texture, instead of being drawn into the output
   *               texture, whose storage is then never allocated
   */
  public GLFrameExtractor(boolean direct) {
    this(direct, false);
  }

  public GLFrameExtractor(boolean direct, boolean hardwareBuffer) {
    // Both historical modes use the correctness reference backend. An OES
    // texture belongs to this isolated EGL context and cannot be imported by Graphite.
    this.direct = false;
    this.hardwareBuffer = hardwareBuffer;
    EGLUtils.purgeOpenGLError();



    int[] texIds = new int[2];
    GLES20.glGenTextures(2, texIds,0);

    inputTexId = texIds[0];
    EGLUtils.configureTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, inputTexId);

    outputTexId = texIds[1];
    EGLUtils.configureTexture(GLES20.GL_TEXTURE_2D, outputTexId);

    int[] bufferIds = new int[1];
    GLES20.glGenFramebuffers(1, bufferIds, 0);
    frameBuffer = bufferIds[0];

    EGLUtils.checkGlError("GLFrameExtractor()");

    textureRenderer = new TextureRenderer(true);

    surfaceTexture = new SurfaceTexture(inputTexId);
    surfaceTexture.setOnFrameAvailableListener(this);
    surface = new Surface(surfaceTexture);
  }

  private static synchronized Handler readerCallbacks() {
    if (readerCallbacks == null) {
      HandlerThread thread = new HandlerThread("ReactNativeSkiaVideo-ImageReader");
      thread.setDaemon(true);
      thread.start();
      readerCallbacks = new Handler(thread.getLooper());
    }
    return readerCallbacks;
  }

  /**
   * The Surface the codec renders into. With {@code nativeImages}, on API 29+
   * with hardware buffers, it is an ImageReader's: frames then keep the codec's
   * YUV buffer, cropped, turned by {@code rotation} and scaled to the frame's
   * size when WebGPU converts it.
   */
  @android.annotation.TargetApi(Build.VERSION_CODES.Q)
  public Surface surfaceFor(int videoWidth, int videoHeight, int rotation, boolean nativeImages) {
    if (!nativeImages || !hardwareBuffer || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return surface;
    }
    synchronized (this) {
      if (released) return surface;
      if (imageReader == null) {
        ImageReader reader = ImageReader.newInstance(videoWidth, videoHeight,
          ImageFormat.YUV_420_888, READER_IMAGES, HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE);
        reader.setOnImageAvailableListener(source -> onFrameAvailable(surfaceTexture),
          readerCallbacks());
        imageRotation = rotation;
        imageReader = reader;
      }
      return imageReader.getSurface();
    }
  }

  @android.annotation.TargetApi(Build.VERSION_CODES.Q)
  private boolean decodeImage(ImageReader reader, int width, int height) {
    Image image;
    try {
      image = reader.acquireLatestImage();
    } catch (IllegalStateException everyImageLeased) {
      // Downstream still holds them all; retry once a lease is released.
      frameAvailable.set(true);
      return false;
    }
    if (image == null) return false;
    boolean owned = true;
    try {
      if (Build.VERSION.SDK_INT >= 33) awaitProducer(image);
      Rect crop = image.getCropRect();
      if (crop.isEmpty()) throw new IllegalStateException("Decoded image has an empty crop");
      HardwareBuffer buffer = image.getHardwareBuffer();
      if (buffer == null) throw new IllegalStateException("Decoded image has no hardware buffer");
      long lease;
      try {
        lease = NativeHardwareBuffer.wrapImage(buffer, image, crop.left, crop.top,
          crop.width(), crop.height(), imageRotation);
      } finally {
        buffer.close();
      }
      owned = false;
      NativeHardwareBuffer.release(pendingHardwareFrame);
      pendingHardwareFrame = lease;
      latestTimeStampNs = image.getTimestamp();
      frameWidth = width;
      frameHeight = height;
      return true;
    } finally {
      if (owned) image.close();
    }
  }

  /** WebGPU's frame wrapper takes no producer fence: wait for it here. */
  @android.annotation.TargetApi(Build.VERSION_CODES.TIRAMISU)
  private static void awaitProducer(Image image) {
    if (Build.VERSION.SDK_INT < 33) return;
    try (SyncFence fence = image.getFence()) {
      if (fence.isValid() && !fence.await(Duration.ofSeconds(5))) {
        throw new IllegalStateException("Decoded image was not ready within 5 seconds");
      }
    } catch (IOException error) {
      throw new IllegalStateException("Cannot read the decoded image's fence", error);
    }
  }

  /**
   * Set the listener that will be called when a new frame is available.
   * @param onFrameAvailableListener the listener to set
   */
  public void setOnFrameAvailableListener(OnFrameAvailableListener onFrameAvailableListener) {
    this.onFrameAvailableListener = onFrameAvailableListener;
  }

  /**
   * @return whether a frame rendered by the producer is waiting to be decoded.
   * Thread-safe and cheap, it lets callers skip the EGL context switch of
   * {@link #decodeNextFrame} when there is nothing new.
   */
  public boolean hasPendingFrame() {
    return frameAvailable.get();
  }

  /**
   * Decode the next frame and render it to the output texture.
   * @param width the width of the frame
   * @param height the height of the frame
   * @return true if a new frame was decoded, false otherwise
   */
  public boolean decodeNextFrame(int width, int height) {
    if (released) {
      return false;
    }
    if(!frameAvailable.compareAndSet(true, false)) {
      return false;
    }

    ImageReader reader;
    synchronized (this) {
      reader = imageReader;
    }
    if (reader != null) {
      return decodeImage(reader, width, height);
    }

    EGLUtils.purgeOpenGLError();

    if (hardwareBuffer) {
      RgbaLayout.byteSize(width, height);
      surfaceTexture.updateTexImage();
      latestTimeStampNs = surfaceTexture.getTimestamp();
      surfaceTexture.getTransformMatrix(transformMatrix);
      long writer = NativeHardwareBuffer.createRenderTarget(width, height);
      Throwable primaryError = null;
      try {
        int texture = NativeHardwareBuffer.renderTargetTexture(writer);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, frameBuffer);
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0,
          GLES20.GL_TEXTURE_2D, texture, 0);
        if (GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER) != GLES20.GL_FRAMEBUFFER_COMPLETE)
          throw new IllegalStateException("Hardware decoder framebuffer is incomplete");
        GLES20.glClearColor(0, 0, 0, 0);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        GLES20.glViewport(0, 0, width, height);
        textureRenderer.draw(inputTexId, transformMatrix);
        EGLUtils.checkGlError("Hardware decoder draw");
        // Detach before native texture/EGLImage cleanup so this FBO cannot keep
        // an unaccounted backing alive after its allocation owner is released.
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0,
          GLES20.GL_TEXTURE_2D, 0, 0);
        long ready = NativeHardwareBuffer.finishRenderTarget(writer);
        writer = 0;
        NativeHardwareBuffer.release(pendingHardwareFrame);
        pendingHardwareFrame = ready;
        frameWidth = width; frameHeight = height;
        return true;
      } catch (Throwable error) {
        primaryError = error;
        throw error;
      } finally {
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, frameBuffer);
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0,
          GLES20.GL_TEXTURE_2D, 0, 0);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
        if (writer != 0) {
          try { NativeHardwareBuffer.abortRenderTarget(writer); }
          catch (RuntimeException cleanupError) {
            if (primaryError == null) throw cleanupError;
            primaryError.addSuppressed(cleanupError);
          }
        }
      }
    }

    if (direct) {
      surfaceTexture.updateTexImage();
      latestTimeStampNs = surfaceTexture.getTimestamp();
      surfaceTexture.getTransformMatrix(transformMatrix);
      measureBuffer(width, height);
      return true;
    }

    if (width != frameWidth || height != frameHeight) {
      frameWidth = width;
      frameHeight = height;
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, outputTexId);
      GLES20.glTexImage2D(
        GLES20.GL_TEXTURE_2D,
        0,
        GLES20.GL_RGBA,
        width, height,
        0,
        GLES20.GL_RGBA,
        GLES20.GL_UNSIGNED_BYTE,
        null
      );
    }
    surfaceTexture.updateTexImage();
    latestTimeStampNs = surfaceTexture.getTimestamp();
    surfaceTexture.getTransformMatrix(transformMatrix);

    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, frameBuffer);
    GLES20.glFramebufferTexture2D(
      GLES20.GL_FRAMEBUFFER,
      GLES20.GL_COLOR_ATTACHMENT0,
      GLES20.GL_TEXTURE_2D,
      outputTexId,
      0
    );
    GLES20.glClearColor(0,0,0,0);
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
    GLES20.glViewport(0, 0, width, height);
    textureRenderer.draw(inputTexId, transformMatrix);
    EGLUtils.checkGlError("GLFrameExtractor.draw()");
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
    return true;
  }


  /**
   * The decoder's buffer is often larger than the picture (1920x1088 for a
   * 1080p H.264 stream), and the transform maps the picture into it, shrunk by
   * up to a texel on each side against bilinear bleeding. The padding is at the
   * right and the bottom, so the picture's two ends along each texture axis,
   * summed, give its share of the buffer along that axis.
   *
   * @param pictureWidth  the picture's width, in the buffer's orientation
   * @param pictureHeight the picture's height, in the buffer's orientation
   */
  private void measureBuffer(int pictureWidth, int pictureHeight) {
    float[] m = transformMatrix;
    float minS = Float.MAX_VALUE;
    float maxS = -Float.MAX_VALUE;
    float minT = Float.MAX_VALUE;
    float maxT = -Float.MAX_VALUE;
    for (int corner = 0; corner < 4; corner++) {
      float s = corner & 1;
      float t = corner >> 1;
      float u = m[0] * s + m[4] * t + m[12];
      float v = m[1] * s + m[5] * t + m[13];
      minS = Math.min(minS, u);
      maxS = Math.max(maxS, u);
      minT = Math.min(minT, v);
      maxT = Math.max(maxT, v);
    }
    float sumS = minS + maxS;
    float sumT = minT + maxT;
    bufferWidth = Math.max(pictureWidth, sumS > 0 ? Math.round(pictureWidth / sumS) : pictureWidth);
    bufferHeight = Math.max(pictureHeight, sumT > 0 ? Math.round(pictureHeight / sumT) : pictureHeight);
  }

  /**
   * @return whether frames are handed over in the input texture
   */
  public boolean isDirect() {
    return direct;
  }

  /**
   * @return the external texture the decoder's buffers are bound to
   */
  public int getInputTexId() {
    return inputTexId;
  }

  /**
   * @return the width of the decoder's buffer, in direct mode, once a frame
   * was decoded
   */
  public int getBufferWidth() {
    return bufferWidth;
  }

  /**
   * @return the height of the decoder's buffer, in direct mode, once a frame
   * was decoded
   */
  public int getBufferHeight() {
    return bufferHeight;
  }

  /**
   * Get the name of the texture that contains the output frame.
   */
  public int getOutputTexId() {
    return outputTexId;
  }

  /** Copies the rendered pixels while this extractor's private EGL context is current. */
  public VideoFrame snapshotFrame(int rotation) {
    if (hardwareBuffer) {
      long ready = pendingHardwareFrame;
      pendingHardwareFrame = 0;
      if (ready == 0) throw new IllegalStateException("No completed hardware video frame");
      try {
        return new VideoFrame(ready, frameWidth, frameHeight, rotation, latestTimeStampNs, producerId);
      } catch (Throwable error) { NativeHardwareBuffer.release(ready); throw error; }
    }
    int size = RgbaLayout.byteSize(frameWidth, frameHeight);
    // One owned allocation is written once by GL and never recycled by this decoder.
    ByteBuffer ownedPixels = NativeRgbaBuffer.allocate(size);
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, frameBuffer);
    GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0,
      GLES20.GL_TEXTURE_2D, outputTexId, 0);
    try {
      if (GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER)
          != GLES20.GL_FRAMEBUFFER_COMPLETE) {
        throw new IllegalStateException("RGBA decoder framebuffer is incomplete");
      }
      GLES20.glPixelStorei(GLES20.GL_PACK_ALIGNMENT, 1);
      GLES20.glReadPixels(0, 0, frameWidth, frameHeight, GLES20.GL_RGBA,
        GLES20.GL_UNSIGNED_BYTE, ownedPixels);
      EGLUtils.checkGlError("decoder RGBA readback");
      return new VideoFrame(ownedPixels, frameWidth, frameHeight, rotation, latestTimeStampNs,
        producerId);
    } finally {
      GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
    }
  }

  /**
   * Get the surface that can be used to render to the output texture.
   */
  public Surface getSurface() {
    return surface;
  }

  @Override
  public void onFrameAvailable(SurfaceTexture surfaceTexture) {
    if (released) {
      return;
    }
    frameAvailable.set(true);
    if (onFrameAvailableListener != null) {
      onFrameAvailableListener.onFrameAvailable();
    }
  }

  public long getLatestTimeStampNs() {
    return latestTimeStampNs;
  }

  /**
   * Release the surface and the GL objects. The EGL context they were created
   * with must be current on the calling thread: without it the GL deletes are
   * silently ignored and the textures live on in the share group.
   */
  public void release() {
    synchronized (this) {
      if (released) {
        return;
      }
      released = true;
    }
    NativeHardwareBuffer.release(pendingHardwareFrame);
    pendingHardwareFrame = 0;
    ImageReader reader;
    synchronized (this) {
      reader = imageReader;
      imageReader = null;
    }
    if (reader != null) {
      // Leased frames keep their own buffer reference; the codec is gone.
      reader.setOnImageAvailableListener(null, null);
      reader.close();
    }
    onFrameAvailableListener = null;
    frameAvailable.set(false);
    if (surfaceTexture != null) {
      surfaceTexture.release();
    }
    if (surface != null) {
      surface.release();
    }
    if (frameBuffer != -1) {
      GLES20.glDeleteFramebuffers(1, new int[]{frameBuffer}, 0);
    }
    if (inputTexId != -1) {
      GLES20.glDeleteTextures(2, new int[]{inputTexId, outputTexId}, 0);
    }
    textureRenderer.release();
  }

  /**
   * A listener that will be called when a new frame is available.
   */
  public interface OnFrameAvailableListener {
    void onFrameAvailable();
  }
}

package com.azzapp.rnskv;

import android.graphics.Bitmap;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.opengl.GLES20;
import android.os.SystemClock;
import android.util.Log;
import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

import javax.microedition.khronos.egl.EGL10;
import javax.microedition.khronos.egl.EGLContext;


/**
 * Helper class for encoding video (and the audio of the composition items,
 * if any).
 */
public class VideoEncoder {

  private static final String TAG = "VideoEncoder";

  public static final String MIME_TYPE = "video/avc";    // H.264 Advanced Video Coding

  public static final String MIME_TYPE_HEVC = "video/hevc";  // H.265 High Efficiency Video Coding

  public static final int DEFAULT_I_FRAME_INTERVAL_SECONDS = 1;

  /**
   * Maps a codec name from the JS API onto its Android mime type, falling back
   * to H.264 for anything the device cannot encode — including an unknown name.
   * H.264 is mandated by the platform, so the fallback is always available.
   *
   * @param codec the codec name, "h264" or "hevc"; null means H.264
   * @return the mime type to encode with
   */
  public static String resolveMimeType(String codec) {
    if ("hevc".equals(codec) && isCodecSupported("hevc")) {
      return MIME_TYPE_HEVC;
    }
    return MIME_TYPE;
  }

  /**
   * Whether the device has an encoder for the given codec.
   *
   * HEVC decoding is far more common than HEVC encoding on Android, so this
   * asks specifically for encoders rather than for codec support at large.
   *
   * @param codec the codec name, "h264" or "hevc"
   * @return true if an encoder exists for it
   */
  public static boolean isCodecSupported(String codec) {
    String mimeType;
    if ("h264".equals(codec)) {
      mimeType = MIME_TYPE;
    } else if ("hevc".equals(codec)) {
      mimeType = MIME_TYPE_HEVC;
    } else {
      return false;
    }
    MediaCodecList codecList = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
    for (MediaCodecInfo info : codecList.getCodecInfos()) {
      if (!info.isEncoder()) {
        continue;
      }
      for (String supported : info.getSupportedTypes()) {
        if (supported.equalsIgnoreCase(mimeType)) {
          return true;
        }
      }
    }
    return false;
  }

  private final String outputPath;

  private final int width;

  private final int height;

  private final int frameRate;

  private final int bitRate;

  private final String encoderName;

  private final String mimeType;

  private final VideoComposition composition;

  private final int audioSampleRate;

  private final int audioChannelCount;

  private final int audioBitRate;

  private final boolean hasAudio;

  private MediaCodec encoder;

  private Surface inputSurface;

  private EGLResourcesHolder eglResourcesHolder;

  private TextureRenderer textureRenderer;

  private int uploadTexture;
  private int uploadWidth;
  private int uploadHeight;
  private ByteBuffer packedUpload;
  private long lastPresentationTimeUs = -1;
  private long submittedFrames;
  private long writtenFrames;
  private static final int MAX_IN_FLIGHT_FRAMES = 4;
  private static final long MAX_PENDING_SAMPLE_BYTES = 16L * 1024 * 1024;
  private long pendingSampleBytes;

  private MediaMuxer muxer;

  private int trackIndex;

  private int audioTrackIndex;

  private boolean muxerStarted;

  private final MediaCodec.BufferInfo bufferInfo;

  private Thread audioThread;

  private volatile boolean audioCanceled = false;

  private volatile Exception audioException;

  private final List<PendingSample> pendingVideoSamples = new ArrayList<>();

  private final List<PendingSample> pendingAudioSamples = new ArrayList<>();

  /**
   * Creates a new VideoEncoder.
   *
   * @param outputPath the path to write the encoded video to
   * @param width      the width of the video
   * @param height     the height of the video
   * @param frameRate  the frame rate of the video
   * @param bitRate    the bit rate of the video
   * @param encoderName the name of the encoder to use, or null to use the default encoder
   * @param codec      the codec to encode with ("h264" or "hevc"), or null for
   *                   H.264; ignored when encoderName names an encoder, and
   *                   falls back to H.264 when the device cannot encode it
   * @param composition the composition being exported, used to encode the
   *                    audio of its audio-enabled items; can be null
   * @param audioSampleRate the sample rate of the exported audio track
   * @param audioChannelCount the number of channels of the exported audio track
   * @param audioBitRate the bit rate of the exported audio track
   */
  public VideoEncoder(
    String outputPath,
    int width,
    int height,
    int frameRate,
    int bitRate,
    String encoderName,
    String codec,
    VideoComposition composition,
    int audioSampleRate,
    int audioChannelCount,
    int audioBitRate
  ) {
    this.outputPath = outputPath;
    this.width = width;
    this.height = height;
    this.frameRate = frameRate;
    this.bitRate = bitRate;
    this.encoderName = encoderName;
    // Resolved once here so the rest of the object works with a mime type the
    // device is known to have an encoder for.
    this.mimeType = resolveMimeType(codec);
    this.composition = composition;
    this.audioSampleRate = audioSampleRate;
    this.audioChannelCount = audioChannelCount;
    this.audioBitRate = audioBitRate;
    this.hasAudio = composition != null && composition.hasAudio();
    bufferInfo = new MediaCodec.BufferInfo();
  }

  /**
   * Configures encoder and muxer state, and prepares the input Surface.
   */
  public void prepare() throws IOException {
    if (encoder != null) throw new IllegalStateException("Encoder already prepared");
    encoder = encoderName != null
      ? MediaCodec.createByCodecName(encoderName)
      : MediaCodec.createEncoderByType(mimeType);

    MediaFormat format = MediaFormat.createVideoFormat(mimeType, width, height);
    format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
      MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
    format.setInteger(MediaFormat.KEY_BIT_RATE, bitRate);
    format.setInteger(MediaFormat.KEY_FRAME_RATE, frameRate);
    format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, DEFAULT_I_FRAME_INTERVAL_SECONDS);

    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);

    inputSurface = encoder.createInputSurface();
    eglResourcesHolder = EGLResourcesHolder.createWithWindowedSurface(EGL10.EGL_NO_CONTEXT, inputSurface);
    eglResourcesHolder.runWithContextCurrent(() -> {
      textureRenderer = new TextureRenderer();
      int[] textures = new int[1];
      GLES20.glGenTextures(1, textures, 0);
      uploadTexture = textures[0];
      EGLUtils.configureTexture(GLES20.GL_TEXTURE_2D, uploadTexture);
    });
    encoder.start();

    try {
      muxer = new MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
    } catch (IOException ioe) {
      throw new RuntimeException("MediaMuxer creation failed", ioe);
    }

    trackIndex = -1;
    audioTrackIndex = -1;
    muxerStarted = false;

    if (hasAudio) {
      AudioCompositionExporter audioExporter = new AudioCompositionExporter(
        composition,
        audioSampleRate,
        audioChannelCount,
        audioBitRate,
        new AudioCompositionExporter.Sink() {
          @Override
          public void onAudioFormat(MediaFormat format) {
            synchronized (VideoEncoder.this) {
              audioTrackIndex = muxer.addTrack(format);
              maybeStartMuxer();
            }
          }

          @Override
          public void onAudioSample(ByteBuffer buffer, MediaCodec.BufferInfo info) {
            writeOrQueueSample(false, buffer, info);
          }
        },
        () -> audioCanceled
      );
      audioThread = new Thread(() -> {
        try {
          audioExporter.run();
        } catch (Exception e) {
          audioException = e;
        }
      }, "ReactNativeSkiaVideo-AudioExportThread");
      audioThread.start();
    }
  }

  public void makeGLContextCurrent() {
    eglResourcesHolder.makeCurrent();
  }

  /** Uploads owned pixels into this encoder's private context, without retaining the input buffer. */
  public void encodeFrameRgba(ByteBuffer rgba, int sourceWidth, int sourceHeight,
      int bytesPerRow, double time) {
    int required = RgbaLayout.requiredBytes(sourceWidth, sourceHeight, bytesPerRow);
    if (rgba == null || rgba.remaining() < required || !Double.isFinite(time) || time < 0) {
      throw new IllegalArgumentException("Invalid encoder RGBA frame or timestamp");
    }
    if (encoder == null || eglResourcesHolder == null) {
      throw new IllegalStateException("Encoder has not been prepared");
    }
    awaitEncoderCapacity();
    ByteBuffer source = rgba.duplicate();
    if (bytesPerRow != RgbaLayout.bytesPerRow(sourceWidth)) {
      int packedSize = RgbaLayout.byteSize(sourceWidth, sourceHeight);
      if (packedUpload == null || packedUpload.capacity() != packedSize) {
        packedUpload = ByteBuffer.allocateDirect(packedSize);
      }
      packedUpload.clear();
      int rowSize = RgbaLayout.bytesPerRow(sourceWidth);
      int start = source.position();
      for (int row = 0; row < sourceHeight; row++) {
        source.limit(start + row * bytesPerRow + rowSize);
        source.position(start + row * bytesPerRow);
        packedUpload.put(source);
      }
      packedUpload.flip();
      source = packedUpload;
    }
    final ByteBuffer upload = source;
    eglResourcesHolder.runWithContextCurrent(() -> {
      GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1);
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, uploadTexture);
      if (sourceWidth != uploadWidth || sourceHeight != uploadHeight) {
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA,
          sourceWidth, sourceHeight, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, upload);
        uploadWidth = sourceWidth;
        uploadHeight = sourceHeight;
      } else {
        GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, sourceWidth, sourceHeight,
          GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, upload);
      }
      EGLUtils.checkGlError("encoder RGBA upload");
      encodeTextureCurrent(uploadTexture, time);
    });
  }

  private void awaitEncoderCapacity() {
    drainEncoder(false);
    long deadline = SystemClock.uptimeMillis() + 15_000;
    while (submittedFrames - writtenFrames >= MAX_IN_FLIGHT_FRAMES) {
      if (audioCanceled || SystemClock.uptimeMillis() > deadline) {
        throw new IllegalStateException("Video encoder did not make progress within its bounded queue");
      }
      drainEncoder(false, 10_000);
    }
  }

  private void encodeTextureCurrent(int texture, double time) {
    // Fail fast if the audio pipeline died: the muxer cannot start without
    // the audio track and every video sample would pile up in
    // pendingVideoSamples until the end of the export.
    if (audioException != null) {
      throw new RuntimeException("Could not encode composition audio", audioException);
    }
    long timeUS = TimeHelpers.secToUs(time);
    if (timeUS <= lastPresentationTimeUs) {
      throw new IllegalArgumentException("Encoder presentation timestamps must increase");
    }
    GLES20.glClearColor(0, 0, 0, 0);
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
    GLES20.glViewport(0, 0, width, height);
    textureRenderer.draw(texture, EGLUtils.IDENTITY_MATRIX);
    eglResourcesHolder.setPresentationTime(timeUS * 1000);
    if (!eglResourcesHolder.swapBuffers()) {
      throw new RuntimeException("eglSwapBuffer failed");
    }
    lastPresentationTimeUs = timeUS;
    submittedFrames++;
    // Upload and sampling are ordered in the same private context. No shared
    // Skia texture can be overwritten while this draw is queued.
    drainEncoder(false);
  }

  public void finishWriting() {
    drainEncoder(true);
    if (audioThread != null) {
      try {
        audioThread.join(30_000);
        if (audioThread.isAlive()) {
          throw new IllegalStateException("Audio encoder did not finish within 30 seconds");
        }
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new RuntimeException("Interrupted while writing audio", e);
      }
      audioThread = null;
      if (audioException != null) {
        throw new RuntimeException("Could not encode composition audio", audioException);
      }
    }
  }

  /**
   * Starts the muxer once every track has been registered and flushes the
   * queued samples. Must be called with the monitor held.
   */
  private void maybeStartMuxer() {
    if (muxerStarted
      || trackIndex < 0
      || (hasAudio && audioTrackIndex < 0)) {
      return;
    }
    muxer.start();
    muxerStarted = true;
    for (PendingSample sample : pendingVideoSamples) {
      muxer.writeSampleData(trackIndex, sample.buffer, sample.bufferInfo);
    }
    pendingVideoSamples.clear();
    for (PendingSample sample : pendingAudioSamples) {
      muxer.writeSampleData(audioTrackIndex, sample.buffer, sample.bufferInfo);
    }
    pendingAudioSamples.clear();
    pendingSampleBytes = 0;
    notifyAll();
  }

  /**
   * Writes a sample to the muxer, or queues it until the muxer has started.
   */
  private synchronized void writeOrQueueSample(
    boolean isVideo,
    ByteBuffer buffer,
    MediaCodec.BufferInfo info
  ) {
    if (muxerStarted) {
      muxer.writeSampleData(isVideo ? trackIndex : audioTrackIndex, buffer, info);
      return;
    }
    if (info.size > MAX_PENDING_SAMPLE_BYTES) {
      throw new IllegalStateException("Encoded sample exceeds the pending muxer budget");
    }
    long deadline = SystemClock.uptimeMillis() + 15_000;
    while (pendingSampleBytes + info.size > MAX_PENDING_SAMPLE_BYTES && !muxerStarted) {
      if (audioCanceled || audioException != null || SystemClock.uptimeMillis() > deadline) {
        throw new IllegalStateException("Muxer tracks did not become ready within the memory budget");
      }
      try {
        wait(100);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Interrupted while waiting for muxer capacity", error);
      }
    }
    if (muxerStarted) {
      muxer.writeSampleData(isVideo ? trackIndex : audioTrackIndex, buffer, info);
      return;
    }
    ByteBuffer copy = ByteBuffer.allocateDirect(info.size);
    copy.put(buffer);
    copy.flip();
    MediaCodec.BufferInfo infoCopy = new MediaCodec.BufferInfo();
    infoCopy.set(0, info.size, info.presentationTimeUs, info.flags);
    (isVideo ? pendingVideoSamples : pendingAudioSamples)
      .add(new PendingSample(copy, infoCopy));
    pendingSampleBytes += info.size;
  }

  private static class PendingSample {
    final ByteBuffer buffer;
    final MediaCodec.BufferInfo bufferInfo;

    PendingSample(ByteBuffer buffer, MediaCodec.BufferInfo bufferInfo) {
      this.buffer = buffer;
      this.bufferInfo = bufferInfo;
    }
  }

  /**
   * Extracts all pending data from the encoder.
   *
   * @param endOfStream true if this is the end of the stream
   */
  private void drainEncoder(boolean endOfStream) {
    // Wait for output only when flushing the stream at the end. During the
    // export the encoder runs a few frames behind its input, so a positive
    // timeout blocks the export thread for that long on every frame whose
    // output is not ready yet; what is not ready now is drained with the next
    // frame.
    drainEncoder(endOfStream, endOfStream ? 10_000 : 0);
  }

  private void drainEncoder(boolean endOfStream, int timeoutUsec) {
    long deadline = SystemClock.uptimeMillis() + 30_000;

    if (endOfStream) {
      encoder.signalEndOfInputStream();
    }

    while (true) {
      if (audioCanceled || SystemClock.uptimeMillis() > deadline) {
        throw new IllegalStateException("Video encoder did not finish within 30 seconds");
      }
      int encoderStatus = encoder.dequeueOutputBuffer(bufferInfo, timeoutUsec);
      if (encoderStatus == MediaCodec.INFO_TRY_AGAIN_LATER) {
        // no output available yet
        if (!endOfStream) {
          break; // out of while
        }
        continue;
      }
      if (encoderStatus == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
        // should happen before receiving buffers, and should only happen once
        if (trackIndex >= 0) {
          throw new RuntimeException("format changed twice");
        }
        synchronized (this) {
          trackIndex = muxer.addTrack(encoder.getOutputFormat());
          maybeStartMuxer();
        }
      } else if (encoderStatus < 0) {
        Log.w(TAG, "unexpected result from encoder.dequeueOutputBuffer: " + encoderStatus);
        // let's ignore it
      } else {
        ByteBuffer encodedData = encoder.getOutputBuffer(encoderStatus);
        if (encodedData == null) {
          throw new RuntimeException("encoderOutputBuffer " + encoderStatus + " was null");
        }

        if ((bufferInfo.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
          // The codec config data was pulled out and fed to the muxer when we got
          // the INFO_OUTPUT_FORMAT_CHANGED status.  Ignore it.
          bufferInfo.size = 0;
        }

        if (bufferInfo.size != 0) {
          // adjust the ByteBuffer values to match BufferInfo (not needed?)
          encodedData.position(bufferInfo.offset);
          encodedData.limit(bufferInfo.offset + bufferInfo.size);

          writeOrQueueSample(true, encodedData, bufferInfo);
          writtenFrames++;
        }

        encoder.releaseOutputBuffer(encoderStatus, false);

        if ((bufferInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
          if (!endOfStream) {
            Log.w(TAG, "reached end of stream unexpectedly");
          }
          break; // out of while
        }
      }
    }
  }

  /**
   * Releases encoder resources.  May be called after partial / failed initialization.
   */
  public void release() {
    audioCanceled = true;
    synchronized (this) { notifyAll(); }
    if (audioThread != null) {
      // Stop the audio pipeline before tearing down the muxer.
      audioThread.interrupt();
      boolean interrupted = Thread.interrupted();
      // Never destroy the muxer while its audio worker can still write it.
      while (audioThread.isAlive()) {
        try {
          audioThread.join(1000);
        } catch (InterruptedException e) {
          interrupted = true;
        }
      }
      if (interrupted) Thread.currentThread().interrupt();
      audioThread = null;
    }
    if (eglResourcesHolder != null) {
      if (textureRenderer != null) {
        // The program can only be deleted with the encoder's context current;
        // on the export thread the Skia context is the one bound here.
        eglResourcesHolder.runWithContextCurrent(() -> {
          textureRenderer.release();
          if (uploadTexture != 0) {
            GLES20.glDeleteTextures(1, new int[]{uploadTexture}, 0);
            uploadTexture = 0;
          }
        });
        textureRenderer = null;
      }
      eglResourcesHolder.release();
      eglResourcesHolder = null;
    }
    if (encoder != null) {
      try {
        encoder.stop();
      } catch (IllegalStateException e) {
        // the encoder never started or is in an error state (failed or
        // canceled exports); release() below reclaims it anyway.
        Log.w(TAG, "Could not stop the encoder", e);
      }
      encoder.release();
      encoder = null;
    }
    if (inputSurface != null) {
      inputSurface.release();
      inputSurface = null;
    }
    if (muxer != null) {
      try {
        muxer.stop();
      } catch (IllegalStateException e) {
        // the muxer never started or has no sample (failed exports).
        Log.w(TAG, "Could not stop the muxer", e);
      }
      muxer.release();
      muxer = null;
    }
    // Direct ByteBuffers only reclaim their native memory once the Java
    // object is collected; drop them eagerly.
    synchronized (this) {
      pendingVideoSamples.clear();
      pendingAudioSamples.clear();
      pendingSampleBytes = 0;
    }
    packedUpload = null;
  }

  public Bitmap saveTexture(int texture, int width, int height) {
    int[] frame = new int[1];
    GLES20.glGenFramebuffers(1, frame, 0);
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, frame[0]);
    GLES20.glFramebufferTexture2D(
      GLES20.GL_FRAMEBUFFER,
      GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, texture,
      0
    );

    ByteBuffer buffer = ByteBuffer.allocate(width * height * 4);
    GLES20.glReadPixels(
      0, 0, width, height, GLES20.GL_RGBA,
      GLES20.GL_UNSIGNED_BYTE, buffer
    );

    Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
    bitmap.copyPixelsFromBuffer(buffer);

    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
    GLES20.glDeleteFramebuffers(1, frame, 0);

    return bitmap;
  }
}

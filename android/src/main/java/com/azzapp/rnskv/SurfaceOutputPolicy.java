package com.azzapp.rnskv;

import android.media.MediaCodec;

/** Surface frames can have no byte payload; an empty EOS is only a stream marker. */
final class SurfaceOutputPolicy {
  private SurfaceOutputPolicy() { }

  static boolean hasFrame(int size, int flags) {
    return (flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0
      && (size > 0 || (flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) == 0);
  }
}

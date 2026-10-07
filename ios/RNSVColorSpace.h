#pragma once

#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>

namespace RNSkiaVideo {

/**
 * Rec.709 — the one color space this library decodes into, draws in and
 * encodes out.
 *
 * Skia is handed plain BGRA textures and does no color management, so every
 * frame has to reach it already in the space the canvas assumes. Since the
 * iPhone 12 the camera records HLG HDR by default, and an HLG buffer decoded
 * as-is into BGRA and drawn as sRGB comes out washed out, with crushed
 * contrast. Asking AVFoundation for these properties makes it tone-map to
 * SDR on the way out, on its own fast path.
 *
 * Applied unconditionally rather than only to HDR sources: a source already
 * in Rec.709 costs nothing, and a BT.601 one gets the conversion it always
 * needed. It also spares the decoders an inspection of the track's transfer
 * function before its format descriptions are even loaded.
 */
static inline NSDictionary* SDRColorProperties() {
  return @{
    AVVideoColorPrimariesKey : AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey : AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey : AVVideoYCbCrMatrix_ITU_R_709_2,
  };
}

/**
 * Stamps Rec.709 onto a buffer handed to AVAssetWriter. The writer's own
 * output settings already declare it, but a buffer carrying no color
 * attachment at all leaves some muxers to guess, and a file with no
 * colorimetry is read differently by every player.
 */
static inline void TagBufferAsSDR(CVPixelBufferRef buffer) {
  CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey,
                        kCVImageBufferColorPrimaries_ITU_R_709_2,
                        kCVAttachmentMode_ShouldPropagate);
  CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey,
                        kCVImageBufferTransferFunction_ITU_R_709_2,
                        kCVAttachmentMode_ShouldPropagate);
  CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey,
                        kCVImageBufferYCbCrMatrix_ITU_R_709_2,
                        kCVAttachmentMode_ShouldPropagate);
}

} // namespace RNSkiaVideo

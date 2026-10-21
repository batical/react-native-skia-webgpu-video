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
 * Applied to every BGRA output rather than only to HDR sources: a source
 * already in Rec.709 costs nothing, and a BT.601 one gets the conversion it
 * always needed. NV12 output takes them only for HDR, see
 * TrackNeedsSDRConversion.
 */
static inline NSDictionary* SDRColorProperties() {
  return @{
    AVVideoColorPrimariesKey : AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey : AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey : AVVideoYCbCrMatrix_ITU_R_709_2,
  };
}

/**
 * Whether a track needs AVFoundation's conversion to Rec.709 even when its
 * frames are decoded to NV12: an HDR transfer function (HLG, PQ) or BT.2020
 * primaries, which only a tone mapping brings to SDR.
 *
 * An SDR track decoded to NV12 is left as it is: its buffers carry their own
 * YCbCr matrix, which the GPU applies when it converts them. Asked for Rec.709
 * properties, VideoToolbox relabels an SD clip's BT.601 samples as BT.709
 * without converting them, and its saturated colors shift (a yellow's blue
 * by 11 levels), where its BGRA output does convert.
 */
static inline bool TrackNeedsSDRConversion(AVAssetTrack* track) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  NSArray* descriptions = track.formatDescriptions;
#pragma clang diagnostic pop
  for (id description in descriptions) {
    auto format = (__bridge CMFormatDescriptionRef)description;
    CFTypeRef transfer = CMFormatDescriptionGetExtension(
        format, kCMFormatDescriptionExtension_TransferFunction);
    CFTypeRef primaries = CMFormatDescriptionGetExtension(
        format, kCMFormatDescriptionExtension_ColorPrimaries);
    if (transfer && (CFEqual(transfer, kCVImageBufferTransferFunction_ITU_R_2100_HLG) ||
                     CFEqual(transfer, kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ)))
      return true;
    if (primaries && CFEqual(primaries, kCVImageBufferColorPrimaries_ITU_R_2020))
      return true;
  }
  return false;
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

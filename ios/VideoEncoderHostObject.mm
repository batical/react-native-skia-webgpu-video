#import "VideoEncoderHostObject.h"
#import "AudioCompositionUtils.h"
#import "NativeResourceStats.h"
#include "RNSVMemoryBudget.h"
#include "RNSVCheckedSizes.h"
#import "RNSVColorSpace.h"
#import "RNSVJSIUtils.h"
#import "RNSVScopedPixelBuffer.h"
// VTCopyVideoEncoderList, for asking the device which codecs it can encode
// rather than inferring it from the chip generation.
#import <VideoToolbox/VideoToolbox.h>
#import <future>
#include <chrono>
#include <cstring>
#include <stdexcept>
#include <thread>

NS_INLINE NSError* createErrorWithMessage(NSString* message) {
  return [NSError errorWithDomain:@"com.azzapp.rnskv"
                             code:0
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

namespace RNSkiaVideo {

VideoEncoderHostObject::VideoEncoderHostObject(
    std::string outPath, int width, int height, int frameRate, int bitRate,
    std::string codec, int audioBitRate, int audioSampleRate,
    int audioChannelCount, std::shared_ptr<VideoComposition> composition,
    bool directEncoder) {
  this->directEncoder = directEncoder;
  this->outPath = outPath;
  this->width = width;
  this->height = height;
  this->frameRate = frameRate;
  this->bitRate = bitRate;
  // Resolved here rather than in prepare() so that the fallback is decided
  // once, before anything is allocated, and the rest of the object can treat
  // this as a codec the device is known to have.
  this->codec = isCodecSupported(codec) ? codec : "h264";
  this->audioBitRate = audioBitRate;
  this->audioSampleRate = audioSampleRate;
  this->audioChannelCount = audioChannelCount;
  this->composition = composition;
  NativeResourceStats::encoders.add(1);
}

VideoEncoderHostObject::~VideoEncoderHostObject() {
  release();
  NativeResourceStats::encoders.remove(1);
}

bool VideoEncoderHostObject::isCodecSupported(const std::string& codec) {
  if (codec == "h264") {
    // Every device that runs this library encodes H.264.
    return true;
  }
  if (codec != "hevc") {
    return false;
  }
  // VTCopyVideoEncoderList is the only answer that comes from the encoders the
  // device actually has, rather than from a hardcoded chip generation. It
  // reports hardware and software encoders alike, which is what we want: an
  // HEVC export that lands on a software encoder is slow but correct.
  CFArrayRef encoders = NULL;
  if (VTCopyVideoEncoderList(NULL, &encoders) != noErr || encoders == NULL) {
    return false;
  }
  bool supported = false;
  for (CFIndex i = 0, n = CFArrayGetCount(encoders); i < n && !supported; i++) {
    auto encoder = (CFDictionaryRef)CFArrayGetValueAtIndex(encoders, i);
    auto codecType = (CFNumberRef)CFDictionaryGetValue(
        encoder, kVTVideoEncoderList_CodecType);
    int32_t value = 0;
    if (codecType &&
        CFNumberGetValue(codecType, kCFNumberSInt32Type, &value) &&
        value == kCMVideoCodecType_HEVC) {
      supported = true;
    }
  }
  CFRelease(encoders);
  return supported;
}

std::vector<jsi::PropNameID>
VideoEncoderHostObject::getPropertyNames(jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> result;
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("prepare")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("encodeFrame")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("acquireFrameBuffer")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("releaseFrameBuffer")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("finishWriting")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("dispose")));
  return result;
}

// The methods are created once per runtime (see RNSVHostObject):
// `encodeFrame` is read for every exported frame.
jsi::Value VideoEncoderHostObject::get(jsi::Runtime& runtime,
                                       const jsi::PropNameID& propNameId) {
  auto propName = propNameId.utf8(runtime);
  if (propName == "prepare") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          return runPooled([&] { prepare(); });
        });
  }
  if (propName == "encodeFrame") {
    return getFunction(
        runtime, propName, 2,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          if (count < 2 || !arguments[0].isObject() || !arguments[1].isNumber()) {
            throw jsi::JSError(runtime, "encodeFrame expects a frame and seconds");
          }
          auto descriptor = arguments[0].asObject(runtime);
          auto time = CMTimeMakeWithSeconds(checkedMediaSeconds(arguments[1].asNumber()), NSEC_PER_SEC);
          auto kindValue = descriptor.getProperty(runtime, "kind");
          auto kind = kindValue.isString() ? kindValue.asString(runtime).utf8(runtime)
                                          : std::string();
          if (kind == "bgra") {
            auto data = descriptor.getProperty(runtime, "data").asObject(runtime)
                            .getArrayBuffer(runtime);
            auto rowValue = descriptor.getProperty(runtime, "bytesPerRow");
            size_t rowBytes = rowValue.isNumber()
                ? checkedStorageInteger(rowValue.asNumber(), "BGRA row bytes")
                : checkedSizeProduct(static_cast<size_t>(width), 4, "BGRA row bytes");
            size_t required = checkedPixelStorage(width, height, rowBytes);
            if (descriptor.getProperty(runtime, "width").asNumber() != width ||
                descriptor.getProperty(runtime, "height").asNumber() != height ||
                data.size(runtime) < required) {
              throw jsi::JSError(runtime, "Invalid BGRA encoder dimensions/storage");
            }
            return runPooled([&] { encodePixels(data.data(runtime), rowBytes, time); });
          }
          if (kind == "rgba-pixels") {
            auto pixels = descriptor.getProperty(runtime, "pixels").asObject(runtime);
            auto storage = pixels.getProperty(runtime, "buffer").asObject(runtime)
                               .getArrayBuffer(runtime);
            size_t offset = checkedStorageInteger(
                pixels.getProperty(runtime, "byteOffset").asNumber(), "RGBA byte offset");
            size_t length = checkedStorageInteger(
                pixels.getProperty(runtime, "byteLength").asNumber(), "RGBA byte length");
            auto rowValue = descriptor.getProperty(runtime, "rowBytes");
            size_t rowBytes = rowValue.isNumber()
                ? checkedStorageInteger(rowValue.asNumber(), "RGBA row bytes")
                : checkedSizeProduct(static_cast<size_t>(width), 4, "RGBA row bytes");
            size_t required = checkedPixelStorage(width, height, rowBytes);
            if (descriptor.getProperty(runtime, "width").asNumber() != width ||
                descriptor.getProperty(runtime, "height").asNumber() != height ||
                offset > storage.size(runtime) ||
                length > storage.size(runtime) - offset ||
                length < required) {
              throw jsi::JSError(runtime, "Invalid RGBA encoder pixel storage");
            }
            return runPooled([&] {
              encodePixels(storage.data(runtime) + offset, rowBytes, time, true);
            });
          }
          if (kind != "native-buffer") {
            throw jsi::JSError(runtime, "encodeFrame needs bgra, native-buffer or rgba-pixels");
          }
          auto pointer = descriptor.getProperty(runtime, "nativeBuffer");
          if (!pointer.isBigInt()) {
            throw jsi::JSError(runtime, "nativeBuffer must be a CVPixelBuffer BigInt");
          }
          auto buffer = reinterpret_cast<CVPixelBufferRef>(
              pointer.asBigInt(runtime).asUint64(runtime));
          if (!buffer) throw jsi::JSError(runtime, "Null encoder nativeBuffer");
          return runPooled([&] { encodeFrame(buffer, time); });
        });
  }
  if (propName == "acquireFrameBuffer") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          uintptr_t pointer = 0;
          runPooled([&] { pointer = acquireFrameBuffer(); });
          return jsi::BigInt::fromUint64(runtime, pointer);
        });
  }
  if (propName == "releaseFrameBuffer") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          return runPooled([&] { releaseFrameBuffer(); });
        });
  }
  if (propName == "finishWriting") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          return runPooled([&] { finish(); });
        });
  } else if (propName == "dispose") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          return runPooled([&] { this->release(); });
        });
  }
  return jsi::Value::undefined();
}

void VideoEncoderHostObject::prepare() {
  std::lock_guard<std::recursive_mutex> guard(stateMutex);
  if (disposed) throw createErrorWithMessage(@"Encoder is disposed");
  if (prepared) return;
  try { prepareImpl(); }
  catch (...) { release(); throw; }
}

void VideoEncoderHostObject::prepareImpl() {
  if (width <= 0 || height <= 0 || frameRate <= 0 || bitRate <= 0) {
    throw createErrorWithMessage(@"Invalid encoder dimensions, cadence or bitrate");
  }
  // Validate/reserve before starting a writer or an audio callback. A failed
  // preparation rolls this reservation back immediately, even if JS retains
  // the encoder host object while reporting the error.
  size_t rowBytes = checkedSizeProduct(static_cast<size_t>(width), 4, "encoder stride");
  auto capacity = checkedSizeProduct(checkedPixelStorage(width, height, rowBytes),
                                     3, "encoder pool capacity");
  poolMemoryToken = MemoryBudget::instance().reserve(capacity, "iOS encoder pool capacity");
  NSDictionary* attributes = @{
    (NSString*)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
    (NSString*)kCVPixelBufferWidthKey : @(width),
    (NSString*)kCVPixelBufferHeightKey : @(height),
    (NSString*)kCVPixelBufferMetalCompatibilityKey : @YES,
    (NSString*)kCVPixelBufferIOSurfacePropertiesKey : @{},
  };
  // Allocate a fresh buffer per frame from this pool instead of reusing a
  // single CVPixelBuffer. AVAssetWriter encodes appended buffers
  // asynchronously, so a reused buffer could be overwritten by the next frame
  // while the encoder is still reading it, producing torn frames on fast
  // motion. The pool only recycles a buffer once every reference to it (the
  // encoder's included) is gone.
  if (pixelBufferPool) {
    CVPixelBufferPoolRelease(pixelBufferPool);
    pixelBufferPool = NULL;
  }
  CVReturn status = CVPixelBufferPoolCreate(
      kCFAllocatorDefault, NULL, (__bridge CFDictionaryRef)attributes,
      &pixelBufferPool);

  if (status != kCVReturnSuccess) {
    throw createErrorWithMessage(@"Could not create pixel buffer pool");
    return;
  }

  CVPixelBufferRef probeBuffer = NULL;
  if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pixelBufferPool,
                                         &probeBuffer) != kCVReturnSuccess || !probeBuffer)
    throw createErrorWithMessage(@"Could not probe encoder pixel storage");
  ScopedPixelBuffer probe(probeBuffer);
  MemoryBudget::instance().resize(poolMemoryToken,
      checkedSizeProduct(pixelBufferBytes(probe.get()), 3, "aligned encoder pool"),
      "iOS aligned encoder pool capacity");

  NSError* error = nil;
  assetWriter = [AVAssetWriter
      assetWriterWithURL:
          [NSURL fileURLWithPath:
                     [NSString
                         stringWithCString:outPath.c_str()
                                  encoding:[NSString defaultCStringEncoding]]]
                fileType:AVFileTypeMPEG4
                   error:&error];
  if (error) {
    throw error;
  }

  bool isHEVC = codec == "hevc";

  // The profile is codec specific and the H.264 constants are rejected outright
  // for HEVC, so the compression properties are built per codec rather than
  // shared. HEVC's Main profile is the interoperable one — Main10 would mean
  // a 10 bit pixel format, which this encoder does not produce.
  NSMutableDictionary* compressionProperties = [@{
    AVVideoAverageBitRateKey : @(bitRate),
    AVVideoMaxKeyFrameIntervalKey : @(frameRate),
  } mutableCopy];
  compressionProperties[AVVideoProfileLevelKey] =
      isHEVC ? (id)kVTProfileLevel_HEVC_Main_AutoLevel
             : (id)AVVideoProfileLevelH264HighAutoLevel;

  auto videoSettings = @{
    AVVideoCodecKey : isHEVC ? AVVideoCodecTypeHEVC : AVVideoCodecTypeH264,
    AVVideoWidthKey : @(width),
    AVVideoHeightKey : @(height),
    // The frames come out of Skia in Rec.709; say so in the file rather than
    // leaving every player to guess (see RNSVColorSpace.h).
    AVVideoColorPropertiesKey : SDRColorProperties(),
    AVVideoCompressionPropertiesKey : compressionProperties,
  };

  assetWriterInput =
      [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                         outputSettings:videoSettings];
  assetWriterInput.expectsMediaDataInRealTime = NO;
  assetWriterInput.performsMultiPassEncodingIfSupported = NO;
  if ([assetWriter canAddInput:assetWriterInput]) {
    [assetWriter addInput:assetWriterInput];
  } else {
    throw assetWriter.error
        ?: createErrorWithMessage(@"could not add output to asset writer");
    return;
  }

  if (composition && composition->hasAudio()) {
    setupAudio();
  }

  if (![assetWriter startWriting]) {
    throw assetWriter.error ?: createErrorWithMessage(@"Could not start writing");
  }
  [assetWriter startSessionAtSourceTime:kCMTimeZero];

  if (audioWriterInput) {
    startWritingAudio();
  }

  prepared = true;
}

void VideoEncoderHostObject::waitUntilReady() {
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (!assetWriterInput.isReadyForMoreMediaData) {
    if (disposed || assetWriter.status != AVAssetWriterStatusWriting) {
      throw assetWriter.error ?: createErrorWithMessage(@"Encoder stopped writing");
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      throw createErrorWithMessage(@"Encoder input stalled for 10 seconds");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
}

CVPixelBufferRef VideoEncoderHostObject::acquireOutputBuffer() {
  waitUntilReady();
  // AVAssetWriter retains submitted buffers. Refuse allocation past the
  // threshold and wait for the writer to release one instead of growing.
  NSDictionary* auxiliary = @{(id)kCVPixelBufferPoolAllocationThresholdKey : @3};
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  CVPixelBufferRef buffer = NULL;
  while (true) {
    CVReturn status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
        kCFAllocatorDefault, pixelBufferPool,
        (__bridge CFDictionaryRef)auxiliary, &buffer);
    if (status == kCVReturnSuccess && buffer) return buffer;
    if (status != kCVReturnWouldExceedAllocationThreshold) {
      throw createErrorWithMessage(@"Could not allocate encoder pixel buffer");
    }
    if (std::chrono::steady_clock::now() >= deadline || disposed ||
        assetWriter.status != AVAssetWriterStatusWriting) {
      throw createErrorWithMessage(@"Bounded encoder pool stalled");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
}

uintptr_t VideoEncoderHostObject::acquireFrameBuffer() {
  std::lock_guard<std::recursive_mutex> guard(stateMutex);
  if (!prepared || disposed) throw createErrorWithMessage(@"Encoder not prepared");
  if (vendedBuffer) {
    throw createErrorWithMessage(@"Previous encoder frame buffer was neither encoded nor released");
  }
  vendedBuffer = acquireOutputBuffer();
  return reinterpret_cast<uintptr_t>(vendedBuffer);
}

void VideoEncoderHostObject::releaseFrameBuffer() {
  std::lock_guard<std::recursive_mutex> guard(stateMutex);
  if (vendedBuffer) {
    CVPixelBufferRelease(vendedBuffer);
    vendedBuffer = NULL;
  }
}

void VideoEncoderHostObject::encodePixels(const uint8_t* pixels,
                                          size_t rowBytes, CMTime time,
                                          bool rgba) {
  std::lock_guard<std::recursive_mutex> guard(stateMutex);
  if (!prepared || disposed) throw createErrorWithMessage(@"Encoder not prepared");
  CVPixelBufferRef output = acquireOutputBuffer();
  CVReturn status = CVPixelBufferLockBaseAddress(output, 0);
  if (status != kCVReturnSuccess) {
    CVPixelBufferRelease(output);
    throw createErrorWithMessage(@"Could not lock encoder pixel buffer");
  }
  auto destination = static_cast<uint8_t*>(CVPixelBufferGetBaseAddress(output));
  size_t destinationStride = CVPixelBufferGetBytesPerRow(output);
  if (!destination) {
    CVPixelBufferUnlockBaseAddress(output, 0);
    CVPixelBufferRelease(output);
    throw createErrorWithMessage(@"Encoder pixel storage unavailable");
  }
  for (int row = 0; row < height; ++row) {
    auto sourceRow = pixels + row * rowBytes;
    auto targetRow = destination + row * destinationStride;
    if (!rgba) {
      memcpy(targetRow, sourceRow, static_cast<size_t>(width) * 4);
    } else {
      for (int column = 0; column < width; ++column) {
        targetRow[column * 4] = sourceRow[column * 4 + 2];
        targetRow[column * 4 + 1] = sourceRow[column * 4 + 1];
        targetRow[column * 4 + 2] = sourceRow[column * 4];
        targetRow[column * 4 + 3] = sourceRow[column * 4 + 3];
      }
    }
  }
  CVPixelBufferUnlockBaseAddress(output, 0);
  try { appendBuffer(output, time); }
  catch (...) { CVPixelBufferRelease(output); throw; }
  CVPixelBufferRelease(output);
}

void VideoEncoderHostObject::encodeFrame(CVPixelBufferRef source, CMTime time) {
  std::lock_guard<std::recursive_mutex> guard(stateMutex);
  if (!prepared || disposed) throw createErrorWithMessage(@"Encoder not prepared");
  if (CVPixelBufferGetWidth(source) != static_cast<size_t>(width) ||
      CVPixelBufferGetHeight(source) != static_cast<size_t>(height) ||
      CVPixelBufferGetPixelFormatType(source) != kCVPixelFormatType_32BGRA) {
    throw createErrorWithMessage(@"Encoder requires exact-sized BGRA native buffer");
  }
  if (source == vendedBuffer) {
    // The GPU already drew into this pool buffer; take over the lent reference.
    vendedBuffer = NULL;
    try { appendBuffer(source, time); }
    catch (...) { CVPixelBufferRelease(source); throw; }
    CVPixelBufferRelease(source);
    return;
  }
  if (directEncoder) {
    CVPixelBufferRetain(source);
    try { appendBuffer(source, time); }
    catch (...) { CVPixelBufferRelease(source); throw; }
    CVPixelBufferRelease(source);
    return;
  }
  CVPixelBufferRef output = acquireOutputBuffer();
  CVReturn sourceStatus = CVPixelBufferLockBaseAddress(source, kCVPixelBufferLock_ReadOnly);
  CVReturn targetStatus = CVPixelBufferLockBaseAddress(output, 0);
  if (sourceStatus != kCVReturnSuccess || targetStatus != kCVReturnSuccess) {
    if (sourceStatus == kCVReturnSuccess)
      CVPixelBufferUnlockBaseAddress(source, kCVPixelBufferLock_ReadOnly);
    if (targetStatus == kCVReturnSuccess) CVPixelBufferUnlockBaseAddress(output, 0);
    CVPixelBufferRelease(output);
    throw createErrorWithMessage(@"Could not lock encoder copy buffers");
  }
  auto input = static_cast<const uint8_t*>(CVPixelBufferGetBaseAddress(source));
  auto destination = static_cast<uint8_t*>(CVPixelBufferGetBaseAddress(output));
  size_t inputStride = CVPixelBufferGetBytesPerRow(source);
  size_t targetStride = CVPixelBufferGetBytesPerRow(output);
  if (!input || !destination) {
    CVPixelBufferUnlockBaseAddress(source, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferUnlockBaseAddress(output, 0);
    CVPixelBufferRelease(output);
    throw createErrorWithMessage(@"Could not access encoder copy buffers");
  }
  for (int row = 0; row < height; ++row) {
    memcpy(destination + row * targetStride, input + row * inputStride, static_cast<size_t>(width) * 4);
  }
  CVPixelBufferUnlockBaseAddress(source, kCVPixelBufferLock_ReadOnly);
  CVPixelBufferUnlockBaseAddress(output, 0);
  try { appendBuffer(output, time); }
  catch (...) { CVPixelBufferRelease(output); throw; }
  CVPixelBufferRelease(output);
}

void VideoEncoderHostObject::appendBuffer(CVPixelBufferRef pixelBuffer,
                                         CMTime time) {
  waitUntilReady();
  TagBufferAsSDR(pixelBuffer);
  size_t bytes = pixelBufferBytes(pixelBuffer);
  NativeResourceStats::encoderSubmittingBuffers.add(1);
  NativeResourceStats::encoderSubmittingBytes.add(bytes);
  CMSampleBufferRef sampleBuffer = NULL;
  CMVideoFormatDescriptionRef formatDescription = NULL;
  OSStatus status = CMVideoFormatDescriptionCreateForImageBuffer(
      NULL, pixelBuffer, &formatDescription);
  CMSampleTimingInfo timingInfo = {CMTimeMake(1, frameRate), time, kCMTimeInvalid};
  NSError* error = nil;
  if (status != noErr || CMSampleBufferCreateForImageBuffer(
          kCFAllocatorDefault, pixelBuffer, true, NULL, NULL,
          formatDescription, &timingInfo, &sampleBuffer) != noErr) {
    error = createErrorWithMessage(@"Could not create sample buffer from frame");
  } else if (![assetWriterInput appendSampleBuffer:sampleBuffer]) {
    error = assetWriter.error ?: createErrorWithMessage(@"Could not append frame");
  }
  if (sampleBuffer) CFRelease(sampleBuffer);
  if (formatDescription) CFRelease(formatDescription);
  NativeResourceStats::encoderSubmittingBuffers.remove(1);
  NativeResourceStats::encoderSubmittingBytes.remove(bytes);
  if (error) throw error;
}

void VideoEncoderHostObject::setupAudio() {
  auto audioComposition = buildAudioComposition(composition, nil);
  if (!audioComposition.composition) {
    return;
  }

  NSError* error = nil;
  audioReader = [AVAssetReader assetReaderWithAsset:audioComposition.composition
                                              error:&error];
  if (error) {
    throw error;
  }
  // The audio composition is padded with silence past the composition
  // duration, clamp the export to the exact video duration.
  audioReader.timeRange = CMTimeRangeMake(
      kCMTimeZero, CMTimeMakeWithSeconds(composition->duration, NSEC_PER_SEC));

  NSDictionary* pcmSettings = @{
    AVFormatIDKey : @(kAudioFormatLinearPCM),
    AVSampleRateKey : @(audioSampleRate),
    AVNumberOfChannelsKey : @(audioChannelCount),
    AVLinearPCMBitDepthKey : @(16),
    AVLinearPCMIsFloatKey : @(NO),
    AVLinearPCMIsBigEndianKey : @(NO),
    AVLinearPCMIsNonInterleaved : @(NO)
  };
  audioMixOutput = [[AVAssetReaderAudioMixOutput alloc]
      initWithAudioTracks:[audioComposition.composition
                              tracksWithMediaType:AVMediaTypeAudio]
            audioSettings:pcmSettings];
  if (audioComposition.audioMix) {
    audioMixOutput.audioMix = audioComposition.audioMix;
  }
  if (![audioReader canAddOutput:audioMixOutput]) {
    throw createErrorWithMessage(@"Could not read composition audio");
  }
  [audioReader addOutput:audioMixOutput];

  NSDictionary* aacSettings = @{
    AVFormatIDKey : @(kAudioFormatMPEG4AAC),
    AVSampleRateKey : @(audioSampleRate),
    AVNumberOfChannelsKey : @(audioChannelCount),
    AVEncoderBitRateKey : @(audioBitRate)
  };
  audioWriterInput =
      [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio
                                         outputSettings:aacSettings];
  audioWriterInput.expectsMediaDataInRealTime = NO;
  if ([assetWriter canAddInput:audioWriterInput]) {
    [assetWriter addInput:audioWriterInput];
  } else {
    audioWriterInput = nil;
    throw assetWriter.error
        ?: createErrorWithMessage(
               @"could not add audio output to asset writer");
  }
}

void VideoEncoderHostObject::startWritingAudio() {
  if (![audioReader startReading]) {
    throw audioReader.error
        ?: createErrorWithMessage(@"Could not read composition audio");
  }
  audioCompletionSemaphore = dispatch_semaphore_create(0);
  audioErrorHolder = [NSMutableArray array];
  dispatch_queue_attr_t attr = dispatch_queue_attr_make_with_qos_class(
      DISPATCH_QUEUE_SERIAL, QOS_CLASS_UTILITY, 0);
  audioQueue = dispatch_queue_create("RNSkiaVideoAudioEncoder", attr);

  // The block only captures ObjC objects, never `this`, so it can safely
  // outlive this host object.
  AVAssetWriterInput* input = audioWriterInput;
  AVAssetReaderAudioMixOutput* output = audioMixOutput;
  AVAssetReader* reader = audioReader;
  AVAssetWriter* writer = assetWriter;
  dispatch_semaphore_t semaphore = audioCompletionSemaphore;
  NSMutableArray<NSError*>* errorHolder = audioErrorHolder;
  __block BOOL finished = NO;
  [input
      requestMediaDataWhenReadyOnQueue:audioQueue
                            usingBlock:^{
                              if (finished) {
                                return;
                              }
                              while (input.isReadyForMoreMediaData) {
                                CMSampleBufferRef sampleBuffer =
                                    [output copyNextSampleBuffer];
                                if (!sampleBuffer) {
                                  if (reader.status ==
                                      AVAssetReaderStatusFailed) {
                                    [errorHolder
                                        addObject:reader.error
                                                      ?: createErrorWithMessage(
                                                             @"Could not read "
                                                             @"composition "
                                                             @"audio")];
                                  }
                                  finished = YES;
                                  [input markAsFinished];
                                  dispatch_semaphore_signal(semaphore);
                                  return;
                                }
                                BOOL appended =
                                    [input appendSampleBuffer:sampleBuffer];
                                CFRelease(sampleBuffer);
                                if (!appended) {
                                  [errorHolder
                                      addObject:writer.error
                                                    ?: createErrorWithMessage(
                                                           @"Could not append "
                                                           @"audio data to "
                                                           @"AVAssetWriter")];
                                  [reader cancelReading];
                                  finished = YES;
                                  [input markAsFinished];
                                  dispatch_semaphore_signal(semaphore);
                                  return;
                                }
                              }
                            }];
}

void VideoEncoderHostObject::finish() {
  std::lock_guard<std::recursive_mutex> guard(stateMutex);
  if (!prepared || disposed) throw createErrorWithMessage(@"Encoder not prepared");
  [assetWriterInput markAsFinished];
  if (audioWriterInput) {
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (dispatch_semaphore_wait(audioCompletionSemaphore,
               dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_MSEC)) != 0) {
      if (disposed) throw createErrorWithMessage(@"Encoder is disposed");
      if (std::chrono::steady_clock::now() >= deadline)
        throw createErrorWithMessage(@"Audio encoder finalization timed out");
    }
    NSError* audioError = audioErrorHolder.firstObject;
    if (audioError) throw audioError;
  }
  // The completion may run after timeout/disposal; it owns its own state and
  // never dereferences this host object or a destroyed stack promise.
  struct WriterCompletion {
    std::promise<void> done;
    NSError* __strong error = nil;
  };
  auto completion = std::make_shared<WriterCompletion>();
  auto future = completion->done.get_future();
  AVAssetWriter* writer = assetWriter;
  [writer finishWritingWithCompletionHandler:^{
    completion->error = writer.status == AVAssetWriterStatusCompleted ? nil :
        (writer.error ?: createErrorWithMessage(@"Failed to finalize export"));
    completion->done.set_value();
  }];
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
  while (future.wait_for(std::chrono::milliseconds(10)) != std::future_status::ready) {
    if (disposed || std::chrono::steady_clock::now() >= deadline) {
      [writer cancelWriting];
      throw createErrorWithMessage(disposed ? @"Encoder is disposed" :
          @"Video encoder finalization timed out");
    }
  }
  future.get();
  NSError* error = completion->error;
  if (error) throw error;
}

void VideoEncoderHostObject::release() {
  // A closer announces cancellation before waiting for a synchronous encode
  // or finish call. Those waits then wake promptly without freeing an in-use
  // pool or writer from under the other runtime.
  if (disposed.exchange(true)) return;
  std::lock_guard<std::recursive_mutex> guard(stateMutex);
  prepared = false;
  if (audioReader && audioReader.status == AVAssetReaderStatusReading) {
    [audioReader cancelReading];
  }
  if (audioQueue) {
    AVAssetWriterInput* input = audioWriterInput;
    BOOL shouldMarkFinished =
        input && (assetWriter.status == AVAssetWriterStatusWriting ||
                  assetWriter.status == AVAssetWriterStatusFailed);
    dispatch_sync(audioQueue, ^{
      if (shouldMarkFinished) {
        [input markAsFinished];
      }
    });
    audioQueue = nil;
  }
  audioReader = nil;
  audioMixOutput = nil;
  audioWriterInput = nil;
  if (assetWriter && assetWriter.status == AVAssetWriterStatusWriting) {
    [assetWriter cancelWriting];
  }
  assetWriter = nil;
  assetWriterInput = nil;
  releaseFrameBuffer();
  if (pixelBufferPool) {
    CVPixelBufferPoolRelease(pixelBufferPool);
    pixelBufferPool = NULL;
  }
  MemoryBudget::instance().release(poolMemoryToken);
  poolMemoryToken = 0;
}

} // namespace RNSkiaVideo

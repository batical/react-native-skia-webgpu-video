#import <React/RCTBridgeModule.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>
#import <UIKit/UIKit.h>
#import <TargetConditionals.h>
#import <mach/mach.h>
#import <sys/utsname.h>
#import <unistd.h>
#include <cmath>

// Example-only file/metadata/RSS collector. This is not a library API.
@interface VideoBenchmarkHarness : NSObject <RCTBridgeModule>
@property(atomic, copy) NSString *benchmarkApplicationState;
@property(nonatomic, strong) dispatch_source_t idleMeasurementTimer;
@property(nonatomic, assign) BOOL previousIdleTimerDisabled;
@property(nonatomic, assign) BOOL ownsIdleTimerOverride;
@end

@implementation VideoBenchmarkHarness
RCT_EXPORT_MODULE(VideoBenchmarkHarness)

+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    [self updateBenchmarkApplicationState];
    for (NSString *name in @[UIApplicationDidBecomeActiveNotification,
                            UIApplicationWillResignActiveNotification,
                            UIApplicationDidEnterBackgroundNotification]) {
      [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(applicationStateChanged:)
        name:name object:nil];
    }
    // Benchmark apps only: preserve the user's setting and keep the display
    // awake during an explicitly launched measurement, without a debugger.
    NSString *profile = NSProcessInfo.processInfo.environment[@"RNSKV_BENCHMARK_PROFILE"];
    if ([@[@"smoke", @"full", @"soak"] containsObject:profile]) {
      self.previousIdleTimerDisabled = UIApplication.sharedApplication.idleTimerDisabled;
      self.ownsIdleTimerOverride = YES;
      UIApplication.sharedApplication.idleTimerDisabled = YES;
    }
  }
  return self;
}
- (void)updateBenchmarkApplicationState {
  switch (UIApplication.sharedApplication.applicationState) {
    case UIApplicationStateActive: self.benchmarkApplicationState = @"active"; break;
    case UIApplicationStateInactive: self.benchmarkApplicationState = @"inactive"; break;
    case UIApplicationStateBackground: self.benchmarkApplicationState = @"background"; break;
  }
}
- (void)applicationStateChanged:(NSNotification *)notification {
  // WillResignActive is delivered before UIApplication updates its property.
  if ([notification.name isEqualToString:UIApplicationWillResignActiveNotification])
    self.benchmarkApplicationState = @"inactive";
  else [self updateBenchmarkApplicationState];
}
- (void)restoreBenchmarkIdleTimer {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.ownsIdleTimerOverride) {
      UIApplication.sharedApplication.idleTimerDisabled = self.previousIdleTimerDisabled;
      self.ownsIdleTimerOverride = NO;
    }
  });
}
- (void)invalidate {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  dispatch_async([self methodQueue], ^{
    if (self.idleMeasurementTimer) {
      dispatch_source_cancel(self.idleMeasurementTimer);
      self.idleMeasurementTimer = nil;
    }
  });
  [self restoreBenchmarkIdleTimer];
}
- (dispatch_queue_t)methodQueue {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("video.benchmark.files", DISPATCH_QUEUE_SERIAL); });
  return queue;
}

- (NSString *)resultDirectory {
  NSString *documents = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  return [documents stringByAppendingPathComponent:@"benchmark-results"];
}

- (NSDictionary *)operatingConditions {
  NSString *thermal = @"unknown";
  switch (NSProcessInfo.processInfo.thermalState) {
    case NSProcessInfoThermalStateNominal: thermal = @"nominal"; break;
    case NSProcessInfoThermalStateFair: thermal = @"fair"; break;
    case NSProcessInfoThermalStateSerious: thermal = @"serious"; break;
    case NSProcessInfoThermalStateCritical: thermal = @"critical"; break;
  }
  return @{ @"thermalState": thermal,
    @"powerMode": NSProcessInfo.processInfo.lowPowerModeEnabled ? @"low-power" : @"normal",
    @"applicationState": self.benchmarkApplicationState ?: @"unknown",
    @"source": @"NSProcessInfo thermalState/lowPowerModeEnabled; UIApplication lifecycle" };
}

- (NSDictionary *)constantsToExport {
  struct utsname system;
  uname(&system);
  NSString *profile = NSProcessInfo.processInfo.environment[@"RNSKV_BENCHMARK_PROFILE"];
  if (![@[@"smoke", @"full", @"soak"] containsObject:profile]) profile = nil;
  NSData *caseData = [NSProcessInfo.processInfo.environment[@"RNSKV_BENCHMARK_CASE_IDS"] dataUsingEncoding:NSUTF8StringEncoding];
  id caseIds = caseData ? [NSJSONSerialization JSONObjectWithData:caseData options:0 error:nil] : nil;
  if (![caseIds isKindOfClass:NSArray.class] || ![caseIds count]) caseIds = nil;
  for (id caseId in caseIds) {
    if (![caseId isKindOfClass:NSString.class]) { caseIds = nil; break; }
  }
  NSInteger repetitions = [NSProcessInfo.processInfo.environment[@"RNSKV_BENCHMARK_REPETITIONS"] integerValue];
  if (repetitions < 1 || repetitions > 10) repetitions = 3;
  NSString *executionTarget = @"device";
  NSString *deviceModel = [NSString stringWithUTF8String:system.machine];
  NSString *deviceId = UIDevice.currentDevice.identifierForVendor.UUIDString ?: @"unavailable";
#if TARGET_OS_SIMULATOR
  executionTarget = @"simulator";
  deviceModel = NSProcessInfo.processInfo.environment[@"SIMULATOR_MODEL_IDENTIFIER"] ?: deviceModel;
  deviceId = NSProcessInfo.processInfo.environment[@"SIMULATOR_UDID"] ?: @"unavailable";
#endif
  return @{
    @"fixtureDirectory": [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"fixtures"],
    @"resultDirectory": [self resultDirectory],
    @"deviceModel": deviceModel,
    @"executionTarget": executionTarget,
    // App-scoped identifier only. The CLI-connected physical UDID is injected
    // by the local device metadata for A/B comparisons across bundle IDs.
    @"deviceId": deviceId,
    @"deviceLabel": UIDevice.currentDevice.name,
    @"osVersion": UIDevice.currentDevice.systemVersion,
    @"displayRefreshRate": @(UIScreen.mainScreen.maximumFramesPerSecond),
    @"benchmarkProfile": profile ?: NSNull.null,
    @"benchmarkCaseIds": caseIds ?: NSNull.null,
    @"benchmarkRepetitions": @(repetitions),
    @"benchmarkRunId": NSProcessInfo.processInfo.environment[@"RNSKV_BENCHMARK_RUN_ID"] ?: NSNull.null,
    @"processIdentifier": @(getpid()),
    @"thermalState": [self operatingConditions][@"thermalState"],
    @"powerMode": [self operatingConditions][@"powerMode"],
  };
}

RCT_REMAP_METHOD(sampleOperatingConditions, sampleOperatingConditionsResolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve([self operatingConditions]);
}

- (BOOL)prepareResultDirectory:(NSError **)error {
  return [NSFileManager.defaultManager createDirectoryAtPath:[self resultDirectory]
    withIntermediateDirectories:YES attributes:nil error:error];
}

RCT_REMAP_METHOD(stat, statPath:(NSString *)path
  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error;
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:&error];
  if (!attributes) { reject(@"FILE_STAT", error.localizedDescription, error); return; }
  resolve(@{ @"size": attributes[NSFileSize] ?: @0 });
}

RCT_REMAP_METHOD(remove, removePath:(NSString *)path
  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *allowed = [[self resultDirectory] stringByAppendingString:@"/"];
  if (![path.stringByStandardizingPath hasPrefix:allowed]) {
    reject(@"FILE_SCOPE", @"Only benchmark output files can be removed", nil); return;
  }
  NSError *error;
  if ([NSFileManager.defaultManager fileExistsAtPath:path] &&
      ![NSFileManager.defaultManager removeItemAtPath:path error:&error]) {
    reject(@"FILE_REMOVE", error.localizedDescription, error); return;
  }
  resolve(@YES);
}

RCT_REMAP_METHOD(writeResult, writeResultJSON:(NSString *)json filename:(NSString *)filename
  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!filename.length || ![filename isEqualToString:filename.lastPathComponent] ||
      ![filename.pathExtension isEqualToString:@"json"] || [filename hasPrefix:@"."]) {
    reject(@"FILE_NAME", @"A plain JSON filename is required", nil); return;
  }
  NSError *error;
  if (![NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&error]) {
    reject(@"RESULT_JSON", @"Result is not valid JSON", error); return;
  }
  if (![self prepareResultDirectory:&error]) { reject(@"FILE_DIRECTORY", error.localizedDescription, error); return; }
  NSString *path = [[self resultDirectory] stringByAppendingPathComponent:filename];
  if (![json writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
    reject(@"FILE_WRITE", error.localizedDescription, error); return;
  }
  resolve(path);
  NSInteger idleSeconds = [NSProcessInfo.processInfo.environment[@"RNSKV_BENCHMARK_IDLE_SECONDS"] integerValue];
  if (idleSeconds >= 30 && idleSeconds <= 600 && idleSeconds % 30 == 0) {
    // Queue behind this bridge call so its temporary JSON string can drain.
    dispatch_async([self methodQueue], ^{ [self startIdleMeasurementFor:filename seconds:idleSeconds]; });
  } else [self restoreBenchmarkIdleTimer];
}

RCT_REMAP_METHOD(prepareOutputDirectory, prepareOutputDirectoryResolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error;
  if (![self prepareResultDirectory:&error]) { reject(@"FILE_DIRECTORY", error.localizedDescription, error); return; }
  resolve([self resultDirectory]);
}

- (NSDictionary *)processMemorySnapshot {
  mach_task_basic_info_data_t info = {};
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  kern_return_t status = task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
    reinterpret_cast<task_info_t>(&info), &count);
  task_vm_info_data_t vm = {};
  mach_msg_type_number_t vmCount = TASK_VM_INFO_COUNT;
  kern_return_t vmStatus = task_info(mach_task_self(), TASK_VM_INFO,
    reinterpret_cast<task_info_t>(&vm), &vmCount);
  return @{
    @"rssBytes": status == KERN_SUCCESS
      ? @{ @"value": @(info.resident_size), @"source": @"iOS mach task_info resident_size" }
      : @{ @"value": NSNull.null, @"reason": @"mach task_info failed" },
    @"physicalFootprintBytes": vmStatus == KERN_SUCCESS && vmCount >= TASK_VM_INFO_REV1_COUNT
      ? @{ @"value": @(vm.phys_footprint), @"source": @"iOS task_vm_info phys_footprint" }
      : @{ @"value": NSNull.null, @"reason": @"task_vm_info physical footprint unavailable" },
    @"nativeHeapBytes": @{ @"value": NSNull.null, @"reason": @"No malloc heap profiler attached" },
    @"gpuBytes": @{ @"value": NSNull.null, @"reason": @"No total GPU allocation collector attached" },
  };
}
RCT_REMAP_METHOD(sampleMemory, sampleMemoryResolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve([self processMemorySnapshot]);
}

- (void)startIdleMeasurementFor:(NSString *)filename seconds:(NSInteger)seconds {
  if (self.idleMeasurementTimer) {
    dispatch_source_cancel(self.idleMeasurementTimer);
    self.idleMeasurementTimer = nil;
  }
  NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSString *startedAt = [formatter stringFromDate:NSDate.date];
  const NSTimeInterval started = NSProcessInfo.processInfo.systemUptime;
  NSMutableArray *samples = [NSMutableArray new];
  NSString *idleFilename = [[filename stringByDeletingPathExtension] stringByAppendingString:@"-idle.json"];
  __weak VideoBenchmarkHarness *weakSelf = self;
  void (^sample)(void) = ^{
    @autoreleasepool {
      VideoBenchmarkHarness *owner = weakSelf;
      if (!owner) return;
      NSTimeInterval elapsed = NSProcessInfo.processInfo.systemUptime - started;
      [samples addObject:@{ @"elapsedSeconds": @(elapsed),
        @"sampledAt": [formatter stringFromDate:NSDate.date],
        @"memory": [owner processMemorySnapshot],
        @"operatingConditions": [owner operatingConditions] }];
      if (elapsed + 0.001 >= seconds) {
        dispatch_source_cancel(owner.idleMeasurementTimer);
        owner.idleMeasurementTimer = nil;
        NSDictionary *result = @{ @"schema": @1, @"benchmarkFilename": filename,
          @"benchmarkRunId": NSProcessInfo.processInfo.environment[@"RNSKV_BENCHMARK_RUN_ID"] ?: NSNull.null,
          @"requestedSeconds": @(seconds), @"intervalSeconds": @30,
          @"processIdentifier": @(getpid()), @"startedAt": startedAt,
          @"finishedAt": [formatter stringFromDate:NSDate.date], @"samples": samples };
        NSError *error;
        NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:&error];
        if (!data || ![data writeToFile:[[owner resultDirectory] stringByAppendingPathComponent:idleFilename]
          options:NSDataWritingAtomic error:&error]) {
          NSLog(@"Benchmark idle result failed: %@", error.localizedDescription);
        }
        [owner restoreBenchmarkIdleTimer];
      }
    }
  };
  self.idleMeasurementTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, [self methodQueue]);
  dispatch_source_set_timer(self.idleMeasurementTimer,
    dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), 30 * NSEC_PER_SEC, 10 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(self.idleMeasurementTimer, sample);
  dispatch_resume(self.idleMeasurementTimer);
  sample();
}

RCT_REMAP_METHOD(probe, probePath:(NSString *)path
  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  @autoreleasepool {
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
    AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
    if (!track || !track.formatDescriptions.count) { reject(@"PROBE_VIDEO", @"Output has no video track", nil); return; }
    CMVideoCodecType type = CMFormatDescriptionGetMediaSubType((__bridge CMFormatDescriptionRef)track.formatDescriptions.firstObject);
    NSString *codec = type == kCMVideoCodecType_H264 ? @"h264" : type == kCMVideoCodecType_HEVC ? @"hevc" : @"unknown";
    CGSize size = track.naturalSize;
    CGAffineTransform transform = track.preferredTransform;
    int rotation = ((int)std::lround(std::atan2(transform.b, transform.a) * 180 / M_PI) % 360 + 360) % 360;
    NSError *error;
    AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
    if (!reader) { reject(@"PROBE_READER", error.localizedDescription, error); return; }
    AVAssetReaderTrackOutput *output = [[AVAssetReaderTrackOutput alloc] initWithTrack:track
      outputSettings:@{ (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA) }];
    output.alwaysCopiesSampleData = NO;
    if (![reader canAddOutput:output]) { reject(@"PROBE_READER", @"Cannot read video frames", nil); return; }
    [reader addOutput:output];
    if (![reader startReading]) { reject(@"PROBE_READER", reader.error.localizedDescription, reader.error); return; }
    NSInteger frames = 0;
    double first = 0, last = 0;
    BOOL monotonic = YES, exact = track.nominalFrameRate > 0;
    while (reader.status == AVAssetReaderStatusReading) {
      @autoreleasepool {
        CMSampleBufferRef sample = [output copyNextSampleBuffer];
        if (!sample) break;
        double time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
        if (!std::isfinite(time) || (frames && time <= last)) monotonic = NO;
        if (std::abs(time - (double)frames / track.nominalFrameRate) > 0.001) exact = NO;
        if (!frames) first = time;
        last = time;
        frames++;
        CFRelease(sample);
      }
    }
    if (reader.status != AVAssetReaderStatusCompleted || !frames) {
      [reader cancelReading];
      reject(@"PROBE_DECODE", reader.error.localizedDescription ?: @"Output decoded no frames", reader.error); return;
    }
    resolve(@{ @"codec": codec, @"width": @(std::lround(size.width)), @"height": @(std::lround(size.height)),
      @"fps": @(track.nominalFrameRate), @"duration": @(CMTimeGetSeconds(asset.duration)),
      @"rotation": @(rotation), @"frameCount": @(frames), @"timestampsMonotonic": @(monotonic),
      @"presentationTimesExact": @(exact), @"firstPresentationTime": @(first), @"lastPresentationTime": @(last),
      @"audioTracks": @([asset tracksWithMediaType:AVMediaTypeAudio].count) });
  }
}
@end

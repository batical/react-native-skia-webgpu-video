#import "VideoFrame.h"
#import "NativeResourceStats.h"
#import "RNSVScopedPixelBuffer.h"
#include "RNSVMemoryBudget.h"
#import <Foundation/Foundation.h>
#include <cassert>
#include <chrono>
#include <iostream>

using namespace RNSkiaVideo;

static CVPixelBufferRef acquire(CVPixelBufferPoolRef pool) {
  CVPixelBufferRef buffer = NULL;
  NSDictionary* options = @{(id)kCVPixelBufferPoolAllocationThresholdKey : @2};
  assert(CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
      NULL, pool, (__bridge CFDictionaryRef)options, &buffer) == kCVReturnSuccess);
  assert(buffer);
  return buffer;
}

int main() {
  @autoreleasepool {
    auto baseline = MemoryBudget::instance().snapshot().currentBytes;
    NSDictionary* attributes = @{
      (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
      (id)kCVPixelBufferWidthKey : @64,
      (id)kCVPixelBufferHeightKey : @32,
      (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
    };
    CVPixelBufferPoolRef pool = NULL;
    assert(CVPixelBufferPoolCreate(NULL, NULL,
        (__bridge CFDictionaryRef)attributes, &pool) == kCVReturnSuccess);

    VideoFrameRing registry(2);
    auto firstBuffer = acquire(pool);
    auto first = std::make_shared<VideoFrame>(firstBuffer, 64, 32, 0, 1);
    registry.push(first);
    CVPixelBufferRelease(firstBuffer);
    auto secondBuffer = acquire(pool);
    auto second = std::make_shared<VideoFrame>(secondBuffer, 64, 32, 0, 1);
    registry.push(second);
    CVPixelBufferRelease(secondBuffer);
    assert(!registry.canAcquire());
    assert(first->hasBuffer() && second->hasBuffer());

    // The producer pool cannot recycle either buffer while a frame owns it.
    CVPixelBufferRef blocked = NULL;
    NSDictionary* threshold = @{(id)kCVPixelBufferPoolAllocationThresholdKey : @2};
    assert(CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
        NULL, pool, (__bridge CFDictionaryRef)threshold, &blocked) ==
        kCVReturnWouldExceedAllocationThreshold);
    assert(!blocked);

    first->releaseBuffer();
    first->releaseBuffer(); // idempotent even with the wrapper still alive
    assert(!first->hasBuffer() && registry.canAcquire());
    auto recycled = acquire(pool); // explicit disposal frees a pool slot
    CVPixelBufferRelease(recycled);
    registry.releaseAll();
    assert(second->hasBuffer()); // producer teardown cannot revoke a reader
    second->releaseBuffer();
    assert(NativeResourceStats::frameBuffers.current.load() == 0);
    assert(MemoryBudget::instance().snapshot().currentBytes == baseline);

    // Repeated producers do not depend on the JS/native wrapper collector.
    auto started = std::chrono::steady_clock::now();
    for (int cycle = 0; cycle < 10000; ++cycle) {
      auto buffer = acquire(pool);
      auto frame = std::make_shared<VideoFrame>(buffer, 64, 32, 0, cycle + 2);
      CVPixelBufferRelease(buffer);
      frame->releaseBuffer();
      assert(MemoryBudget::instance().snapshot().currentBytes == baseline);
    }
    auto elapsed = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - started).count();

    // Allocation failures do not retain source buffers or phantom budget.
    MemoryBudget::instance().configure(1024);
    // Same adopting owner used after AVPlayer's copyPixelBuffer call. If an
    // exception leaks that +1, this two-buffer pool exhausts on iteration 3.
    for (int failure = 0; failure < 1000; ++failure) {
      bool rejected = false;
      try {
        ScopedPixelBuffer copied(acquire(pool));
        auto frame = std::make_shared<VideoFrame>(copied.get(), 64, 32, 0, 20000);
      } catch (const std::runtime_error&) { rejected = true; }
      assert(rejected && NativeResourceStats::frameBuffers.current.load() == 0);
    }
    assert(MemoryBudget::instance().snapshot().currentBytes == baseline);
    MemoryBudget::instance().configure(256ULL * 1024 * 1024);
    CVPixelBufferPoolRelease(pool);

    std::cout << "{\"test\":\"ios-buffer-ownership\",\"cycles\":10000,"
              << "\"elapsedMs\":" << elapsed << ",\"retainedFrameBytes\":"
              << NativeResourceStats::frameBytes.current.load()
              << ",\"trackedCurrentBytes\":"
              << MemoryBudget::instance().snapshot().currentBytes << "}\n";
  }
}

#include "ExportHintSession.h"
#include <android/performance_hint.h>
#include <dlfcn.h>
#include <time.h>
#include <unistd.h>
#include <algorithm>
#include <type_traits>

namespace RNSkiaVideo {

namespace {
int64_t nanos(clockid_t clock) {
  timespec now{};
  clock_gettime(clock, &now);
  return static_cast<int64_t>(now.tv_sec) * 1'000'000'000 + now.tv_nsec;
}

/**
 * The NDK's performance hint functions, resolved at run time: the library
 * supports Android 9, hint sessions exist from Android 13, and work durations
 * with a GPU part from Android 15. Null where missing.
 */
struct Hints {
  APerformanceHintManager* (*getManager)() = nullptr;
  APerformanceHintSession* (*createSession)(APerformanceHintManager*,
                                            const int32_t*, size_t,
                                            int64_t) = nullptr;
  int (*reportActual)(APerformanceHintSession*, int64_t) = nullptr;
  void (*closeSession)(APerformanceHintSession*) = nullptr;
  AWorkDuration* (*createWork)() = nullptr;
  void (*releaseWork)(AWorkDuration*) = nullptr;
  void (*setWorkStart)(AWorkDuration*, int64_t) = nullptr;
  void (*setWorkTotal)(AWorkDuration*, int64_t) = nullptr;
  void (*setWorkCpu)(AWorkDuration*, int64_t) = nullptr;
  void (*setWorkGpu)(AWorkDuration*, int64_t) = nullptr;
  int (*reportWork)(APerformanceHintSession*, AWorkDuration*) = nullptr;

  bool sessions() const {
    return getManager && createSession && reportActual && closeSession;
  }
  bool workDurations() const {
    return createWork && releaseWork && setWorkStart && setWorkTotal &&
           setWorkCpu && setWorkGpu && reportWork;
  }
};

const Hints& hints() {
  static const Hints functions = [] {
    Hints found;
    void* library = dlopen("libandroid.so", RTLD_NOW);
    if (library == nullptr) return found;
    const auto resolve = [library](auto& function, const char* name) {
      function = reinterpret_cast<std::remove_reference_t<decltype(function)>>(
          dlsym(library, name));
    };
    resolve(found.getManager, "APerformanceHint_getManager");
    resolve(found.createSession, "APerformanceHint_createSession");
    resolve(found.reportActual, "APerformanceHint_reportActualWorkDuration");
    resolve(found.closeSession, "APerformanceHint_closeSession");
    resolve(found.createWork, "AWorkDuration_create");
    resolve(found.releaseWork, "AWorkDuration_release");
    resolve(found.setWorkStart, "AWorkDuration_setWorkPeriodStartTimestampNanos");
    resolve(found.setWorkTotal, "AWorkDuration_setActualTotalDurationNanos");
    resolve(found.setWorkCpu, "AWorkDuration_setActualCpuDurationNanos");
    resolve(found.setWorkGpu, "AWorkDuration_setActualGpuDurationNanos");
    resolve(found.reportWork, "APerformanceHint_reportActualWorkDuration2");
    return found;
  }();
  return functions;
}
} // namespace

ExportHintSession::ExportHintSession(int frameRate)
    : targetNanos(1'000'000'000LL / (std::max(frameRate, 1) * 4LL)) {}

ExportHintSession::~ExportHintSession() {
  if (session != nullptr) hints().closeSession(session);
}

void ExportHintSession::frameDone() {
  const auto& functions = hints();
  const auto now = nanos(CLOCK_MONOTONIC);
  const auto cpu = nanos(CLOCK_THREAD_CPUTIME_ID);
  if (session == nullptr) {
    if (unavailable) return;
    // The calling thread is the export's: it decodes, draws and encodes.
    auto* manager = functions.sessions() ? functions.getManager() : nullptr;
    const int32_t thread = gettid();
    session = manager != nullptr
                  ? functions.createSession(manager, &thread, 1, targetNanos)
                  : nullptr;
    unavailable = session == nullptr;
  } else if (functions.workDurations()) {
    const auto total = std::max<int64_t>(now - lastNanos, 1);
    const auto threadCpu = std::clamp<int64_t>(cpu - lastCpuNanos, 0, total);
    // The thread waits out the rest of the frame, mostly for the GPU: given
    // as GPU time, which lets Android raise the GPU clock as well.
    auto* work = functions.createWork();
    if (work != nullptr) {
      functions.setWorkStart(work, lastNanos);
      functions.setWorkTotal(work, total);
      functions.setWorkCpu(work, threadCpu);
      functions.setWorkGpu(work, total - threadCpu);
      functions.reportWork(session, work);
      functions.releaseWork(work);
    }
  } else {
    functions.reportActual(session, std::max<int64_t>(now - lastNanos, 1));
  }
  lastNanos = now;
  lastCpuNanos = cpu;
}

} // namespace RNSkiaVideo

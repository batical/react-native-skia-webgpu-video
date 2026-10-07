# Android memory retention — Skia 3.0.6

The eight-clip 4K montage completes, but substantial process memory remains after its resources close. A controlled diagnostic build shows that unused Graphite resources account for a reclaimable part of this retention. A separate source review also identifies an unbalanced reference in Skia's image-provider factory. Neither finding explains all remaining memory.

## Device experiment

The [sanitized evidence](../benchmark/android-cache-retention-306.json) records raw-file hashes, conditions, memory categories and cache counters. All runs use one identical arm64 Release APK, SHA-256 `5dda76b6609ccadbd0ac8b8abb597c6fe34664d6c0105c869de410a5ee1a61fd`, derived from commit `249e03b6fa8f0820dec032206952000b809f58d8`. This is an instrumented diagnostic binary, distinct from the qualified production checkpoint.

The physical Pixel 8a runs Android 17, RN 0.86.2, Skia 3.0.6 and WebGPU 0.12.1. Each cold process executes `4k-x8-lazy-direct`: eight sequential full-resolution H264/HEVC clips, playback, seeks, scrub, loop, a 360-frame 1080-square export, 25 churn cycles and 40 remounts. The quota stays at 512 MiB and the preview at 720 × 720 physical pixels. No forced GC or system setting changes are used.

The diagnostic invokes the probe after successful preview cleanup and export cleanup, on the recorder's owning thread. It locks the shared context. It records both budgeted and purgeable bytes; the configured 256 MiB budgets are ceilings, not actual allocations.

| Mode | Intervention |
| --- | --- |
| 0 | Observe only. |
| 1 | Snap/insert the current recorder, then checked synchronous context submission. No purge. |
| 3 | Same drain, followed by `freeGpuResources()` on the current recorder and shared context. |

There is one execution per mode. These are memory diagnostics, not a statistically repeated speed comparison. The intervention runs at each successful cleanup, not just once at the final measurement. Mode 2 (current recorder only) is available in the probe but was not run; this experiment does not separate recorder purging from context purging.

All three workloads passed. All **3,539 native samples** reported nominal thermal state, normal power mode and active foreground lifecycle; no samples were dropped. Every recorded settled owned-byte/resource count was zero. The application was stopped after collection to release KEEP_SCREEN_ON.

Memory after 60 seconds at rest, in MiB (PSS):

| Mode | Total | Native heap | Java heap | EGL mtrack | GL mtrack | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 715.07 | 90.30 | 3.44 | 58.65 | 413.77 | 74.29 |
| 1 | 708.21 | 92.03 | 3.43 | 58.65 | 404.54 | 74.33 |
| 3 | 540.03 | 92.37 | 3.44 | 58.65 | 235.71 | 74.59 |

The purge run is **175.04 MiB (24.48%) below observation-only** and **168.18 MiB below drain-only** in total PSS. GL mtrack decreases by 178.06 MiB versus observation-only; the other listed categories remain similar. These single-run differences support reclaimable GPU-cache retention, not a guaranteed savings target. The drain-only control does not reproduce the reduction.

In mode 0, the last UI-recorder probe reports **112.74 MiB budgeted and purgeable**, and the export recorder reports **63.30 MiB** at export completion. The shared context reports **4.55 MiB budgeted**, nearly all purgeable. These observations occur at their respective cleanup points; they are not a simultaneous heap snapshot. In mode 3 both observed recorder caches return to zero after each probe, with 4 KiB remaining budgeted in the context at the last probe. Per-view recorders and other GPU owners are not individually instrumented.

Even after the purge, **540 MiB total PSS** remains, including **235.71 MiB GL mtrack**, **58.65 MiB EGL mtrack**, **92.37 MiB native-heap PSS** and **74.59 MiB Unknown**. Therefore cache trimming alone does not close the memory investigation. GL/EGL mtrack labels do not identify individual allocation owners; native-heap PSS is not live allocated heap size. The evidence keeps `dumpsys TOTAL RSS` separate from the harness's `/proc/self/status VmRSS`.

## Separate reference-count defect

The installed Skia 3.0.6 `cpp/rnskia/RNImageProvider.h` factory returns `sk_ref_sp(new ImageProvider)`. In the same installed Skia headers, `SkRefCntBase` starts with one reference, and `sk_ref_sp` increments it. When the last smart pointer releases the provider, the construction reference remains. The appropriate ownership pattern for a newly allocated instance is `sk_make_sp<ImageProvider>()` (or an adopting `sk_sp`).

The [native reproducer](../benchmark/diagnostics/skia-provider-reference-count.cpp) uses the actual installed `SkRefCnt.h`, checks destruction after the final smart-pointer reset for both patterns, and passed with AddressSanitizer and UndefinedBehaviorSanitizer. It balances the orphaned reference before exiting. This proves the ownership error in the factory pattern; it does not measure the number or size of image providers retained in the app.

Each provider can retain up to 256 strong image references. Skia creates providers for thread-local recorders and for per-view recorders. This makes the defect relevant to repeated mounts, but attributing the measured per-cycle growth or the residual 540 MiB to this defect requires a separate corrected-build experiment. No such improvement is claimed here.

## Implementation decision and remaining qualification

Do not install the diagnostic purge as an unconditional production cleanup. The context and UI recorder are shared with other Skia consumers; repeatedly draining them and discarding reusable resources can affect rendering latency, 3D and ML work. Trimming these shared caches should use application-level control, respect recorder thread affinity and use an idle/session boundary, with simultaneous-video and other-GPU-consumer tests. The private export runtime permits a narrower policy without trimming those shared caches.

The [production follow-up](ANDROID_EXPORT_CACHE_306.md) now fixes the image-provider factory reference and trims only the dedicated export recorder after session cleanup, through the version/hash-guarded Skia patch workflow. It tests the factory correction independently before combining the changes. The broad diagnostic purge above is still excluded from production. The investigation makes no old-library performance claim, iOS cache claim, HDR/audio qualification or endurance guarantee.

## Reproducing the diagnostic

The [archived diagnostic patch](../benchmark/diagnostics/android-cache-probe-306.patch) contains the exact five-file instrumentation delta over the base commit and its already-applied production Skia patch. It is stored under `benchmark/`, excluded from the package's production patch installer, and was removed from active sources after building. Its context was checked with `git apply --check` against the restored sources. It is not a supported public API.

In an isolated checkout at that commit, install the locked dependencies and apply the normal guarded canvas patch first. Check/apply the diagnostic patch, build the Android arm64 Release example, sign and install the resulting APK. Select each mode through a distinct `RNSKV_BENCHMARK_RUN_ID` containing `cache-probe-mode0`, `cache-probe-mode1` or `cache-probe-mode3`. Select the full profile, one repetition, and only `4k-x8-lazy-direct`. Capture `VideoCacheProbe` logs for that process and `dumpsys meminfo -d com.skiawebgpuvideo.tests` during the run and at 0/10/30/60 seconds after completion. Keep the app in the foreground for the idle observation; stop it after collection. Never compare a newly built binary's identity with the frozen APK hash as if they were the same artifact.

Run the ownership reproducer from the repository root:

```sh
clang++ -std=c++17 -DNDEBUG -fsanitize=address,undefined -fno-omit-frame-pointer \
  -I node_modules/react-native-skia/cpp/skia \
  benchmark/diagnostics/skia-provider-reference-count.cpp \
  -o /tmp/skia-provider-reference-count
/tmp/skia-provider-reference-count
```

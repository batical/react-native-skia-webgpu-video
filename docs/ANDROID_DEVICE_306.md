# Android physical-device diagnostics — Skia 3.0.6

The current AHardwareBuffer Release checkpoint passed all 24 focused physical-device attempts on a Google Pixel 8a (Android 17, API 37): three repetitions of eight playback/export scenarios, including H264/HEVC full 4K in copy and direct modes. Tracked owned bytes and resource reservations returned to zero after each strict two-second cleanup. The earlier CPU failures are preserved below. This qualifies these focused operations, not the full instrumentation suite or permanent leak absence.

[Machine-readable evidence](../benchmark/android-device-306-verification.json) preserves per-attempt status, raw-file hashes, outstanding reservations and binary/source fingerprints. Raw reports stay local and ignored because they include device identifiers. This is a candidate-only diagnostic campaign, without a valid old-library A/B comparison or a cross-platform performance comparison.

## Current AHardwareBuffer checkpoint

Release APK SHA-256 `59afb795cfc9fe86d5bbbbaaa487cf0129130dd6538d0f5faf5d6bc11a6edbfa`; source snapshot `35c1f59a69c1a2d6cb04170fed083e3c6f81c51cd94efc35a490181cdd06ee43` over 123 preserved source files. The binary uses the same RN/Skia/WebGPU versions, fixtures, seed, original resolutions, 512 MiB quota, 720 × 720 physical-pixel preview and 640 × 360 exports as the diagnostic workload. The app was restarted for every attempt, producing 24 distinct processes. All 986 native samples reported nominal thermal state, normal power mode and active foreground lifecycle; zero samples were dropped. Before the additional repetitions, the phone was AC powered, at 100% battery and 31.1 °C.

| Case | Strict passes | Median peak RSS (MiB) | Median peak PSS (MiB) |
| --- | ---: | ---: | ---: |
| H264 1080p copy | 3/3 | 337.676 | 308.423 |
| H264 4K copy | 3/3 | 408.977 | 550.610 |
| HEVC 4K copy | 3/3 | 408.812 | 541.787 |
| H264 1080p direct | 3/3 | 337.691 | 307.981 |
| H264 4K direct | 3/3 | 409.098 | 553.601 |
| HEVC 4K direct | 3/3 | 408.762 | 511.776 |
| H264 export copy | 3/3 | 309.879 | 226.266 |
| H264 export direct | 3/3 | 309.641 | 226.619 |

RSS/PSS peaks are sampled independently. Owned bytes and reservations were zero in every final settled sample; decoder-count and in-flight-frame collectors remain unavailable. Settled physical memory, per-attempt peaks and raw hashes remain in the machine-readable report. Returning owned reservations to zero does not establish zero driver caches or the absence of leaks during longer use.

The 4K callback cadences were 45.442/s for H264 copy, 42.795/s for H264 direct, 44.578/s for HEVC copy and 43.352/s for HEVC direct. The 1080p values were 57.707/s and 58.088/s. All callback-duration p95 upper histogram bounds were ≤ 0.25 ms. These are CPU callback diagnostics, excluding preload/import and GPU completion; they are not decoded or presented FPS. Frame availability was present at every draw; decoder drops remain unknown.

All six exports produced 60 decoded frames at 640 × 360, H264, 30 fps, with exact monotonic presentation timestamps from zero through 59/30 seconds and progress 60/60. Median full pipeline time (`encodeMs`) was 2354.867 ms in copy mode and 2227.471 ms in direct mode; stat/probe time was 386.236/370.346 ms, and pipeline plus probe/removal (`exportMs`) was 2819.146/2767.245 ms. Generic export pixel/audio validators remain unavailable.

A separate functional CPU/AHB oracle passed 10/10 cases across padded dimensions, portrait, 90° rotation, H264 full 4K and HEVC full 4K, each in copy/direct mode. Two decoded timestamps per case compared 66,560 sampled RGBA channels with maximum error zero. The first raw frame remained readable and importable after later decode and producer teardown. Six targeted native AHB ownership, finish/abort, quota and read-validation tests passed with zero skips in 0.168 s; 43 JVM tests also passed. The oracle uses readback and is excluded from performance measurements. It validates sampled SDR patches, not whole-image fidelity, HDR or audio.

Decode renders the codec texture into immutable AHardwareBuffer storage, completes the producer GL fence synchronously, and imports it through the shared WebGPU device before an owned GPU snapshot. Normal AHB rendering performs no RGBA CPU readback or full-frame CPU copy. Export continues through CPU RGBA upload. End-to-end zero-copy, complete GPU memory, a 256 MiB quota and long-duration stability have not been qualified. The one-attempt CPU scoped-copy reference uses a different binary and is insufficient for a controlled A/B improvement claim.

## Current AHardwareBuffer lifecycle follow-up

Four additional existing catalog cases each passed once on the same frozen Release APK, including their strict cleanup criterion: `paused-clock-and-resume`, `closed-item-leaves-frame-map`, `held-image-survives-seek`, and `4k-x8-lazy-direct`. Their 1267 native samples were all nominal/normal/active with zero samples dropped. The paused clock moved by zero during the 250 ms pause and advanced by 0.425587 s after resume; frame-map pruning removed clips 0/1 and retained only clip 2.

The case named `held-image-survives-seek` performed a paused seek and 2.5 s wait followed by five seeks. It does not retain and compare an independent SkImage, and its immutability pixel validator remains unavailable. Its pass establishes operation completion and cleanup, while the separate CPU/AHB oracle above validates sampled pixels on a retained raw frame after producer teardown. Paused seeks use clock/visible-item-ID checks, with native presentation-timestamp identity unavailable.

The lazy/direct montage used eight sequential full-resolution H264/HEVC 4K clips and completed play, 10 seeks, 81 scrub requests, loop, export, 25 churn cycles, a callback diagnostic and 40 remount cycles in 144.242 s. Its export contained 360 decoded 1080 × 1080 H264 frames at 30 fps over 12 s, with exact monotonic PTS from zero through 359/30 s and progress 360/360. Generic montage pixel/audio validators were not supplied.

This montage had a substantially higher physical memory cost than the simple playback cases: peak RSS **800.250 MiB**, peak PSS **1037.908 MiB** and peak tracked owned bytes **257.080 MiB**. Final settled RSS remained **785.816 MiB**, although tracked owned bytes and reservations returned to zero. The physical retention is not attributed to a particular driver/cache/VM component. One completed set of 25 churn/40 remount cycles establishes neither a memory plateau nor endurance or leak absence. The 256 MiB quota and eager/concurrent pressure remain unqualified.

Five existing JNI CPU-fallback ownership/refusal tests passed again on the current instrumentation artifact with zero skips in 0.896 s, separately from the six AHB tests. The benchmark app was force-stopped after testing to release KEEP_SCREEN_ON; no system settings were changed, and no owned test runner or sampler remains active.

The subsequent [Android cache-retention investigation](ANDROID_MEMORY_RETENTION_306.md) separates process memory categories and measures Graphite caches with a diagnostic build. It identifies reclaimable cache retention and a separate upstream reference-count defect. These experiments do not change the production qualification above or establish that the remaining process memory is leak-free.

The [export-cache follow-up](ANDROID_EXPORT_CACHE_306.md) records the later production changes and their own binary identity, pixel checks and repeated montage results. Keep those measurements separate from this original AHB checkpoint.

## Historical CPU diagnostic checkpoint

The prior CPU implementation completed all six 1080p and six export operations, but its twelve full-resolution 4K attempts failed controlled ART allocation; every attempt failed strict cleanup. Neither quota nor cleanup thresholds were relaxed.

## Historical CPU workload and identity

- React Native 0.86.2, Skia 3.0.6, WebGPU 0.12.1; arm64-v8a Release on a physical Pixel 8a.
- Candidate APK SHA-256 `352f728d99ab6b69e75b732580c3cab12c8905bebe31f400f6afc8f399e7e08e`; bundle `fa577288aa58d4beecb8aa71ce8b51f14ceb1eee84f17942043461ea786d5c22`; source snapshot `82ef4f57aca124e1725649f314cdf7ee425442f261894ce54e89587c78cb9b97` (source bytes correspond to commit `2ab84c8`).
- Catalog `2026-10-07.1`, identical seed, eight cases with three independent cold processes each. Each raw one-case execution has repetition zero; the external campaign records repetitions zero through two separately.
- Preview: 720 × 720 physical pixels, four seconds, original uncapped 1080p or 4K H264/HEVC inputs, no seeks. Export: two seconds, 60 frames, 640 × 360 H264 at 30 fps and a requested 2 Mbit/s.
- Library memory budget: 512 MiB. All 911 native samples reported nominal thermal state, normal power mode and active foreground lifecycle. No collection samples were dropped. The phone was AC powered; battery temperature before the campaign was 37.7 °C.

Both requested copy and direct modes use the historical CPU RGBA readback/upload fallback. The label “direct” does not establish a zero-copy implementation. The Graphite import uses a reusable WebGPU texture and an owned GPU snapshot rather than creating a new cached raster upload for each frame.

## Recorded results

Peaks below are medians over three attempts. RSS and PSS are sampled independently, so their peak values must not be divided or interpreted as simultaneous memory categories.

| Case | Completed operations | Strict passes | Peak RSS (MiB) | Peak PSS (MiB) |
| --- | ---: | ---: | ---: | ---: |
| H264 1080p copy | 3/3 | 0/3 | 612.336 | 563.594 |
| H264 4K copy | 0/3 | 0/3 | 720.227 | 754.432 |
| HEVC 4K copy | 0/3 | 0/3 | 724.922 | 780.497 |
| H264 1080p direct | 3/3 | 0/3 | 607.219 | 567.692 |
| H264 4K direct | 0/3 | 0/3 | 744.273 | 768.242 |
| HEVC 4K direct | 0/3 | 0/3 | 744.051 | 754.546 |
| H264 export copy | 3/3 | 0/3 | 365.293 | 280.858 |
| H264 export direct | 3/3 | 0/3 | 363.887 | 279.066 |

Completed 1080p operations recorded median callback cadences of 56.885/s (copy) and 55.820/s (direct), with the callback-duration p95 in the ≤ 0.25 ms histogram bucket. These are callback diagnostics, not decoded-video FPS, presented FPS or GPU duration. Callback duration excludes frame preload/upload. Zero missing-frame availability does not establish zero dropped decoder frames; decoder drops and complete GPU timing remain unavailable.

All six exports produced 60 decoded frames at 640 × 360, H264, 30 fps, with exact monotonic presentation timestamps from zero through 59/30 seconds. Generic pixel and audio validation remain unavailable. Median full export pipeline time (`encodeMs`) was 2168.225 ms (copy) and 2100.074 ms (direct); the separate stat/probe time was 360.318/352.350 ms. Pipeline plus probe and output removal (`exportMs`) was 2612.350/2547.482 ms. `elapsedMs` additionally includes pre-export settling and is not an export-duration metric.

Outstanding native backing reservations remain visible in every settled record. The two-second cleanup failure alone cannot distinguish deferred Java/Hermes collection from a permanent leak. Decoder-count and in-flight-frame collectors are unavailable and are not reported as zero. Android native-heap PSS is not allocator heap size; complete process GPU allocation and iOS-style physical footprint are unavailable.

## Bounded allocation retry follow-up

A separate APK (`a883499979179fa6c17ae4887a6eafd4d411043ac40a4a5a75f689f2e39d8924`) retries only the backing allocation once after draining already queued dead phantom references, with the same owner and reservation. It never forces GC, recycles live aliases, increases the quota or reduces the decode resolution.

A single full-resolution H264 4K attempt still failed with a controlled allocation error after two attempts and failed strict cleanup. No repeated performance campaign was launched for that unsuccessful recovery. The corresponding 37 JVM tests and five physical JNI ownership/refusal tests passed. These unit results do not qualify 4K playback or whole-application cleanup.

The subsequent scoped-copy APK (`789735e095937cc168865986a353613d29f065feeff40bca8676ab0895b2ef0a`, source snapshot `0a842f1f6f02ca4bb6f274050adcb15897b2cbc78aa76770b1aa94171ccfca3f`) completed one attempt for each of the same eight cases without OOM, including all four full-resolution 4K copy/direct cases and both exports. All eight still failed strict two-second cleanup. Five JNI ownership tests passed again (0.572 s). This establishes completion of these bounded operations; it is not a complete memory qualification or a repeated performance comparison. The extra CPU copy and per-attempt physical memory remain visible in the machine-readable follow-up. The later AHardwareBuffer result above is a separate binary and campaign; these historical CPU failures remain unchanged.

## Native instrumentation scope

The current inventory contains the original 40 named cases / 86 parameterized executions plus ownership additions, for 52 named cases / 102 planned executions. The full current suite has not passed. Six AHB ownership tests passed on the current AHB checkpoint. The five CPU ownership/refusal tests passed on the earlier scoped-copy checkpoint. Before the ART guard change, 15 focused decode/export tests passed; a separate earlier full-suite attempt completed two passes, failed one lazy-4K cadence assertion and crashed during one eager eight-4K allocation, leaving 90 executions unrun. The record preserves these different source checkpoints.

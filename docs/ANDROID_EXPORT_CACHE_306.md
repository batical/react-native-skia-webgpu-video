# Export cache and provider ownership — Skia 3.0.6

Historical cache/provider-fix checkpoint (2026-10-07). The additional native/VM growth described below was subsequently investigated and substantially reduced by the [export-worklet fix](NATIVE_MEMORY_INVESTIGATION_306.md), measured on both physical platforms on October 8. This report preserves the earlier measurements; its iPhone validation and unresolved-growth statements describe that earlier checkpoint.

The library now adopts the initial reference of Skia's `ImageProvider` and releases unused resources from its dedicated export recorder when an export session closes. Public playback/export signatures are unchanged. Reapply the guarded Skia patch and rebuild the native application.

## Scope of the change

`ImageProvider::Make()` now uses `sk_make_sp<ImageProvider>()`. The original `sk_ref_sp(new ImageProvider)` increments the newly allocated object's initial reference and leaves it orphaned when its smart pointers close. The installed-factory ownership test uses the real Skia reference counter and verifies that an alias remains valid until its own final release.

Export cleanup first drains drawing and any frame processor, closes decoder/encoder/image/canvas/surface consumers, then invokes the private Skia recorder cleanup on the dedicated export runtime. The native method checks recording insertion and synchronous submission, drops the temporary recording and frees unused resources from that recorder only. Reservation release and successful promise settlement follow. Failure retains the existing quarantine and blocks reuse of the runtime. An old native binary is rejected before export allocations.

This policy does not trim the preview/UI recorder or the shared context, change their budgets, destroy the shared GPU device, force GC, or downscale video. It is not the broad experimental purge from the [earlier investigation](ANDROID_MEMORY_RETENTION_306.md). Preview, 3D and ML consumers can continue to retain their own resources; this is not a whole-process memory limit. Queue completion still uses the shared GPU queue, so this is not a promise of zero impact on concurrent GPU latency.

## Physical Android results

The [machine-readable evidence](../benchmark/android-memory-optimization-306.json) records binary/source fingerprints, raw-report hashes, sampled conditions, memory categories, export outputs, pixel comparisons and remount checkpoints. Reports are sanitized; raw device identifiers stay local.

The production candidate APK is `fd4f6f277207d809fe40203439fcfa62b34e1bfcaffe42ad51adaf48db9f6254`. All workloads use the physical Pixel 8a, Android 17, arm64 Release, Skia 3.0.6 / WebGPU 0.12.1. The montage uses the same eight full-resolution sequential H264/HEVC 4K clips, 512 MiB owned quota, 720-square preview, 360-frame 1080-square export, 25 churn cycles and 40 remount cycles per case.

One cold-process montage, total PSS after 60 seconds at rest:

| Build | Total PSS (MiB) | GL mtrack (MiB) |
| --- | ---: | ---: |
| Original production AHB checkpoint | 702.78 | 397.46 |
| Provider reference correction only | 692.97 | 397.40 |
| Provider correction + export recorder cleanup | 584.62 | 289.32 |

The combined candidate is 118.16 MiB below the original and 108.35 MiB below the provider-only run. These are observed differences from one run per build, not a statistical savings guarantee. The reference correction alone did not materially reduce the GL mtrack category. The process remains much larger than the roughly 164 MiB idle menu, and tracked owned resources returning to zero does not explain all retained memory.

Within the final 40-remount operation, `/proc/self/status VmRSS` increased by approximately 13.19 MiB in the baseline run, 12.87 MiB with the provider correction alone and 13.27 MiB with both corrections. This specific growth is not resolved by the changes. These RSS measurements must not be mixed with `dumpsys TOTAL RSS` or interpreted as exact live allocation counts.

Two successive montages were then run in one cold process for each binary, with the same protocol: 50 churn cycles, 80 remount cycles and two 360-frame exports per process. Both cases passed in both binaries. After the second montage and 60 seconds at rest, total PSS was **861.14 MiB for the original versus 737.83 MiB for the candidate**, an observed reduction of **123.31 MiB (14.32%)**.

The candidate nevertheless grows substantially across the two montages. Native-heap PSS and the Unknown category finish at approximately 142/137 MiB in both binaries, versus approximately 92/74 MiB after a single montage. The change reduces retained graphics memory; it does not resolve that additional native/VM growth. These categories include the benchmark process and its instrumentation, and do not yet attribute outstanding allocations to the library, framework, driver or collector. Two montages do not establish a plateau.

All seven montage cases represented in the evidence (including the earlier single baseline) passed, with nominal/normal/active conditions in every native sample, no dropped collection samples and zero owned bytes/resources in every settled sample. All seven exports decoded to 360 frames with exact monotonic PTS at 30 fps. The candidate's three montage cases and its pixel oracle passed. The corrected APK was restored on the Pixel after comparison, and the test application was stopped to release KEEP_SCREEN_ON.

The final candidate also passed the CPU/AHB pixel oracle: ten cases covering padded dimensions, portrait, 90-degree rotation, H264/HEVC full 4K and copy/direct modes. The 66,560 compared RGBA channels had maximum error zero, including the retained raw frame after producer teardown. This separate functional readback is excluded from memory/performance measurements. It checks sampled SDR regions, not whole-image fidelity, HDR or audio.

## Validation and limits

- 195 JavaScript tests pass, including cleanup ordering, refusal to purge after a failed surface drain, missing-native-patch preflight and quarantine after a failed cache drain.
- Five guarded-installer tests pass, including upgrade from the earlier canvas-only patch, repeat application and conflict refusal before mutation.
- Portable native policy/ownership tests pass with AddressSanitizer and UndefinedBehaviorSanitizer, including the installed provider factory.
- Android arm64 Release compilation, TypeScript, package build and strict package validation pass. The patched `JsiSkApi`/surface headers compile against the iOS simulator SDK; the new behavior has not been measured on a physical iPhone.

The result establishes a narrower production memory improvement and correct completion of these bounded operations. It does not establish a memory plateau, leak absence, full native-suite coverage, a 256 MiB quota, or faster presented video FPS. Remaining growth needs allocation-stack attribution separating recorder caches, Dawn/driver allocations, native heap and VM backing stores. Preserve the same workload and collectors for that investigation; do not mask growth by increasing quotas or forcing collection.

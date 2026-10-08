# Native memory investigation — Skia 3.0.6

Initial checkpoint: 2026-10-07; updated 2026-10-08. Base: `6c0c0556019b404e2601d85ee17dd876c1aad49a` (merged PR #3).

**The large export-related growth is reduced by reusing one frame worklet per export.** Clean physical-device comparisons and extended runs pass on both platforms. Memory still warms up and fluctuates; these bounded runs do not prove zero leaks in arbitrary long sessions. The provider ownership and export-recorder cache fixes were already on the baseline `main`; the change here addresses JavaScript-to-native worklet reconstruction.

## Baseline iPhone measurement — before the worklet fix

Physical iPhone 15 Pro, Release, Skia 3.0.6 / WebGPU 0.12.1. Two consecutive `4k-x8-lazy-direct` full workloads in one process, followed by 60 seconds idle. Each workload includes preview, seeks/scrubbing, looping, a 360-frame export, 25 churn cycles and 40 remounts.

Both cases passed. All 1,788 samples report nominal thermal state, normal power mode and an active app. Owned reservations, decoder and in-flight counters return to zero. These counters do not include every system/driver allocation.

| Checkpoint | Resident size (MiB) | Physical footprint (MiB) |
|---|---:|---:|
| After first workload | 207.05 | 310.53 |
| After second workload | 310.81 | 410.10 |
| After 60 seconds idle | 327.58 | 425.99 |

The idle measurement follows report serialization and is a different checkpoint from the workload's final sample. Memory stays nearly constant during that idle minute; it still grew between workloads. Most of the second workload's increase occurs around export. This is not proof of a leak in a particular component or of an eventual plateau.

Exports encode in 4.09 and 4.29 seconds, respectively. These are observations from this build, not a speed comparison. The workload's export has no audio track and does not establish audio correctness.

## Allocation tracing

Android tracing is opt-in for the standalone benchmark app:

```sh
cd example/android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -PprofileMemory=true
```

This enables the Android `profileable` manifest entry for that Release artifact. Ordinary builds omit it. Traced runs are for allocation attribution, not performance comparison with uninstrumented runs.

The first Android heapprofd capture (4 KiB sampling, 16 MiB client buffer) overflowed and disconnected at startup. Its attribution is invalid; do not use its partial allocations to explain workload growth. The retry uses 128 KiB sampling and a 64 MiB client buffer, without blocking the client. The retry also disconnected at startup (`heapprofd_client_error=2`); it is not a valid retained-allocation profile. Both full workload repetitions passed and the 60-second idle measurement finished (713.6 MiB total PSS, 858.2 MiB dumpsys total RSS), but this instrumented run is not a clean performance comparison.

The Android benchmark app was force-stopped after the final measurement. No benchmark app or owned Perfetto capture process remained. The investigation was paused at the user’s request on October 7 and resumed on October 8.

A separate iPhone Instruments Allocations recording is saved locally. Instruments emitted a duplicate dyld mapping warning during finalization. Statistics export succeeded; stack symbolication and attribution remain to be checked. Its totals must not be substituted for the clean measurement above.

Private raw traces, device identifiers, signed binaries and command logs remain in ignored benchmark results. Do not commit them.

## Investigation sequence and remaining limits

The Android heap captures were rejected as attribution evidence after their client errors were checked. The saved iPhone call tree then identified the worklet reconstruction path; a targeted fix and regression test were followed by clean Release measurements on both devices.

The fix is merged in [PR #4](https://github.com/batical/react-native-skia-webgpu-video/pull/4), commit `cd543506ab4fd3666350b3b2f632969d78447300`. The remaining qualification covers longer sessions, other devices and workloads, HDR/audio fidelity and application-specific 3D/ML resources. A valid Android allocation-stack capture remains unavailable; category PSS alone does not identify owners.

## 2026-10-08: export closure attribution and merged fix

The saved iPhone Allocations call tree attributes 32.44 MB (inclusive, as displayed by Instruments) on its heaviest persistent path to `RetainingSerializable<SerializableWorklet>::toJSValue`, followed by nested worklet/object reconstruction. These nested values must not be added together or equated with process footprint.

The export loop constructed its entire frame worklet inside the per-frame RN callback. Worklets 0.11.3 retains serialized worklets and caches serialization by function identity; constructing a fresh function for every image defeats that reuse. The corrected implementation creates one frame worklet per export and schedules that same function for subsequent frames. It preserves yielding between frames, progress delivery, cancellation, asynchronous processor waits and cleanup ordering. No global garbage collection or reduced video resolution is introduced.

A regression test submits two separate 360-frame exports, checks that each export reuses its frame closure while isolating the next export, and verifies resource disposal. All 196 Jest tests, TypeScript, package build and package validation pass. Android and iPhone Release builds succeed.

The first candidate iPhone run is excluded from the two-workload comparison: the first case failed during playback while the application became inactive/background, before export; the second case passed. The fresh comparison below replaces this interrupted attempt.

The Android profiler's error code 2 means `CLIENT_ERROR_INVALID_STACK_BOUNDS` in the [Perfetto protocol](https://github.com/google/perfetto/blob/main/protos/perfetto/trace/profiling/profile_packet.proto). The failed capture cannot attribute retained allocations. Clean Android memory comparisons can still run without that profiler.

### Candidate clean iPhone comparison

A fresh two-workload run passed both cases, with every memory sample nominal/normal/active. The native executable hash matches the baseline; the JavaScript bundle differs. This comparison uses the same full scenario, sampling period, fixtures, budget and physical device.

| Checkpoint | Before: physical footprint (MiB) | Candidate (MiB) |
|---|---:|---:|
| After first workload | 310.53 | 232.44 |
| After second workload | 410.10 | 258.36 |
| After report serialization and 60 s idle | 425.99 | 257.70 |

The second export no longer shows the large footprint increase: its surrounding settled checkpoints are 237.69 → 237.35 MiB. Full-workload growth is still 25.92 MiB between the first and second settled endpoints, so two successful cases do not establish an endurance plateau. The separate six-workload run below checks the longer trend.

### Candidate clean Android comparison

Two full workloads passed on the physical Pixel 8a. All 2,347 samples were nominal/normal/active. The candidate APK is a normal Release build without the allocation-profiling manifest flag. At 60 seconds idle, total PSS fell from 737.83 to 577.20 MiB (21.8%). Native Heap PSS fell from 142.26 to 79.51 MiB; Unknown PSS fell from 136.93 to 41.87 MiB. Category PSS is not live malloc size, and GL driver accounting is not a unique owner counter.

The two candidate exports encoded in 24.41 and 25.21 seconds, versus 28.81 and 29.40 seconds in the saved reference. This small sample is encouraging but does not establish a general speedup or presented FPS. The four-workload check below assesses the remaining growth.

### Six consecutive iPhone workloads

All six full workloads passed, each at nominal temperature, normal power and foreground execution. Settled physical footprint after each workload was **232.02, 252.81, 259.10, 268.41, 264.75 and 271.94 MiB**. After serializing the larger six-case report and waiting 60 seconds, footprint was **277.74 MiB**. This is consistent with a much flatter late-run trend (last three settled points span 7.19 MiB); it is not a proof of unlimited endurance or zero retention.

This run includes six 360-frame exports, 150 churn cycles and 240 remounts. No forced garbage collection, global cache purge, resolution reduction or larger memory quota was used. The iPhone application is stopped after the idle collector finishes.

### Four consecutive Android workloads

All four full workloads passed in nominal/normal/active conditions. Final settled PSS after each workload was **513.66, 566.49, 603.57 and 593.80 MiB**. Native Heap PSS readings at the same points were **55.70, 76.50, 92.92 and 82.16 MiB**, collected through `Debug.MemoryInfo.nativePss`; they are not live malloc allocation sizes. Both readings fall on the fourth workload, rather than growing every session.

The run includes four 360-frame exports, 100 churn cycles and 160 remounts. After 60 seconds idle, total PSS was **602.10 MiB**. The benchmark app was force-stopped after the final reading to release its screen-on request. Sanitized machine-readable comparisons and extended runs are in [stable-export-worklet-306.json](../benchmark/stable-export-worklet-306.json); raw device identifiers and traces remain private.

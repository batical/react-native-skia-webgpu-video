# Native memory investigation — Skia 3.0.6

Checkpoint: 2026-10-07. Base: `6c0c0556019b404e2601d85ee17dd876c1aad49a` (merged PR #3).

**Repeated-session native/VM memory growth remains unresolved.** The provider ownership and export-recorder cache fixes are already on `main`; this investigation does not introduce another production memory fix.

## Clean iPhone measurement

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

The Android benchmark app was force-stopped after the final measurement. No benchmark app or owned Perfetto capture process remained. The investigation is paused at the user’s request.

A separate iPhone Instruments Allocations recording is saved locally. Instruments emitted a duplicate dyld mapping warning during finalization. Statistics export succeeded; stack symbolication and attribution remain to be checked. Its totals must not be substituted for the clean measurement above.

Private raw traces, device identifiers, signed binaries and command logs remain in ignored benchmark results. Do not commit them.

## Resume

1. Validate the completed Android trace for dropped/truncated data; identify the actual workload PID separately from the idle reference process.
2. Attribute retained allocations by call stack and time across both exports; inspect Hermes, Skia/Dawn, codec and benchmark-harness contributions.
3. Compare iPhone allocation stacks with the clean per-phase growth. Distinguish live objects, allocator retention and driver caches.
4. Implement a fix only after attribution, add a targeted regression check, then repeat clean Release measurements on both physical devices.
5. Merge validated production changes through the protected-main workflow. No new production fix is claimed at this checkpoint.

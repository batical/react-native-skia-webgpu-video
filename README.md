<p align="center">
  <img src="docs/assets/banner.svg" alt="React Native Skia WebGPU Video — Play. Compose. Export." width="100%" />
</p>

<p align="center">
  <a href="https://github.com/batical/react-native-skia-webgpu-video/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/batical/react-native-skia-webgpu-video/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
  <a href="#status"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-f59e0b" /></a>
  <img alt="React Native Skia 3.6.1" src="https://img.shields.io/badge/Skia-3.6.1-38bdf8" />
  <img alt="React Native WebGPU 0.16.0" src="https://img.shields.io/badge/WebGPU-0.16.0-a78bfa" />
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-34d399" /></a>
</p>

# React Native Skia WebGPU Video

**Video playback, composition and export for React Native Skia 3 / Graphite.** Draw video frames with Skia, add your own overlays, and reuse your composition when exporting a file.

A new Skia 3 / WebGPU frame-interop layer, written from scratch with explicit resource ownership and configurable video memory reservations, while keeping a familiar Skia Video API.

**[Get started](#installation) · [Example](#one-composition-preview-and-export) · [Migration](docs/MIGRATION.md) · [Status](#status) · [Credits](#credits)**

## What you can build

- **Video players and editors** with play, pause, seek, looping, and frame drawing callbacks.
- **Compositions and overlays** driven by a timeline in seconds, using the same drawing function for preview and export.
- **H.264 / HEVC exports**, subject to device capabilities, with cancellation and bounded export queues.
- **Audio compositions** with clip audio, separate tracks, and per-item volume.
- **Custom GPU processing** through an export frame processor and an optional WebGPU resource scope.

> **Alpha software.** The current Skia 3.6.1 / WebGPU 0.16.0 build has run on an iPhone 15 Pro and a Pixel 8a (export speed, pixel checks). Long-session memory qualification of this build is still pending. See [status](#status) before adopting this in production.

## Installation

### Requirements

| Dependency | Current configuration |
| --- | --- |
| React Native | `0.86.2` tested; declared peer range `>=0.83 <0.87` |
| React | `19.2.3` tested |
| React Native Skia | **`react-native-skia@3.6.1`** |
| React Native WebGPU | **`react-native-webgpu@0.16.0`** (both resolve `react-native-webgpu-dawn@154.3.0`) |
| Reanimated / Worklets | **`4.5.3` / `0.11.3`** |
| Native runtime | New Architecture and Hermes |
| Android | API **28+** |

A native rebuild is required. Expo Go cannot load this module. Skia and WebGPU now share Dawn through the `react-native-webgpu-dawn` npm package: `node` must be on the `PATH` during `pod install` and Gradle builds, and both packages must resolve the same version of it. For iOS, use the deployment target required by your React Native and Skia versions; the example targets iOS 16.4 or later.

### Build the alpha from source

These instructions use a local package archive and do not depend on an npm release:

```sh
git clone https://github.com/batical/react-native-skia-webgpu-video.git
cd react-native-skia-webgpu-video
npm ci
npm run build
npm pack
```

Then, from your React Native application:

```sh
npm install --save-exact react-native-skia@3.6.1 react-native-webgpu@0.16.0 react-native-reanimated@4.5.3 react-native-worklets@0.11.3
npm install /path/to/react-native-skia-webgpu-video-0.1.0-alpha.0.tgz
```

Keep these versions pinned. If migrating an existing app, remove `@shopify/react-native-skia` and the previous Skia Video package before rebuilding. Follow the [migration guide](docs/MIGRATION.md) to avoid loading both generations in one native application.

Add `react-native-worklets/plugin` **last** in your Babel plugins:

```js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['react-native-worklets/plugin'],
};
```

### Apply the required Skia patch

This alpha includes a version-checked Skia patch for canvas/image-provider ownership, checked GPU submissions and cleanup of the dedicated export recorder cache. Apply it in the **application**, before compiling native code:

```sh
npx --no-install skia-video-patch-canvas
cd ios
pod install
```

Add `skia-video-patch-canvas` to your application's existing `postinstall` process so it runs after clean dependency installs. The script checks every target file before changing anything and is safe to run again. An unknown version or conflicting patch stops with an error. Review the [patch and upstream notes](docs/UPSTREAM_NOTES.md) when upgrading Skia, then rebuild the native app.

After an export closes its consumers, the library releases unused resources from its private export recorder. It preserves the shared Skia context cache and the preview/UI recorder cache. This reduces retained export resources without adding per-frame purges; it does not impose a limit on total process memory. Upgrading an already-patched application also requires rebuilding its native binary.

## One composition, preview and export

Use an app-accessible **absolute local file path** for each composition item. This example needs a source at least five seconds long; composition paths are not HTTP or `file://` URLs.

```tsx
import { useMemo } from 'react';
import { Button, View } from 'react-native';
import { Canvas, Image } from 'react-native-skia';
import {
  drawVideoFrame,
  exportVideoComposition,
  useVideoComposition,
} from 'react-native-skia-webgpu-video';
import type {
  FrameDrawer,
  VideoComposition,
} from 'react-native-skia-webgpu-video';

const drawFrame: FrameDrawer = ({ canvas, frames, width, height }) => {
  'worklet';
  const frame = frames.clip;
  if (frame) {
    drawVideoFrame(canvas, frame, { x: 0, y: 0, width, height }, {
      fit: 'contain',
    });
  }
  // Draw your Skia text, shapes, or overlays here.
};

export function VideoEditor({ inputPath, outputPath }: {
  inputPath: string;
  outputPath: string;
}) {
  const composition = useMemo<VideoComposition>(() => ({
    duration: 5,
    items: [{
      id: 'clip',
      path: inputPath,
      compositionStartTime: 0,
      startTime: 0,
      duration: 5,
      audio: true,
    }],
  }), [inputPath]);

  const { currentFrame } = useVideoComposition({
    composition,
    drawFrame,
    width: 320,
    height: 180,
    autoPlay: true,
  });

  const save = async () => {
    await exportVideoComposition({
      videoComposition: composition,
      drawFrame,
      outPath: outputPath,
      width: 1280,
      height: 720,
      frameRate: 30,
      bitRate: 5_000_000,
    });
  };

  return (
    <View>
      <Canvas style={{ width: 320, height: 180 }}>
        <Image image={currentFrame} x={0} y={0} width={320} height={180} />
      </Canvas>
      <Button title="Export video" onPress={() => {
        void save().catch(console.error);
      }} />
    </View>
  );
}
```

Choose a writable output path. Preview dimensions are layout points; drawing callbacks receive physical pixel dimensions. Export dimensions are pixels. The [`useVideoPlayback`](src/videoPlayer.ts) hook is also available for single-video playback.

### Export speed

- **Static images drawn on every frame** (logos, stickers, rasterized text): convert them once with `image.makeTextureImage()` (Skia 3.4+). A raster image drawn directly is uploaded once per recorder and kept in a cache of up to 256 images.
- **Finding the slow stage:** pass `onProfile` to `exportVideoComposition`. It receives cumulative milliseconds per stage (`decodeMs`, `importMs`, `prepareMs`, `targetMs`, `drawMs`, `gpuMs`, `encodeMs`, `yieldMs`), measured on the export runtime, once before the export resolves:

```ts
await exportVideoComposition({
  /* ... */
  onProfile: (profile) => console.log(profile),
});
```

### Audio

Composition clips are **silent by default**. Set `audio: true` to include the source track in playback and export, or `audio: { volume: 0.8 }` to set its volume. Add music or voice-over using a composition item with `kind: 'audio'` and `volume`.

Audio implementations are retained on iOS and Android, including AAC export. The latest device performance campaign did **not** validate audible output or audio/video synchronization. See the [typed API](src/types.ts) for the complete options.

## Migrating from Skia Video

Use `useVideoComposition` for timelines and `useVideoPlayback` for single videos. Rename the previous hook imports and calls; the old names are no longer exported. Composition structure, timeline units, drawing callbacks, and player/export controls are retained. Texture interop changes: replace `MakeImageFromNativeTextureUnstable(frame.texture)` with `drawVideoFrame` or `makeVideoFrameImage`.

**[Read the migration guide →](docs/MIGRATION.md)**

The `copy` and `direct` options remain available for compatibility and use the same transport: exports draw on the GPU into the encoder's buffers on both platforms, falling back to CPU readback where the interop is unavailable. Inspect `getVideoResourceStats().backend` for the transport actually used.

## Memory and GPU extensions

Configure the library's tracked reservations before creating players or export sessions:

```ts
import { configureVideoMemory } from 'react-native-skia-webgpu-video';

configureVideoMemory({ maxBytes: 256 * 1024 * 1024 });
```

This budget covers **tracked video resources**, not all memory held by codecs, Skia, or GPU drivers. Use lazy decoders for sequential compositions, keep preview resolution appropriate, and measure process memory on your target device. Images returned by the frame helpers belong to the library; do not dispose them independently.

### How frames move

| Step | iOS | Android |
| --- | --- | --- |
| Decode | AVFoundation, BGRA IOSurface-backed buffers, no extra copy (`alwaysCopiesSampleData = NO`) | API 29+, 8-bit SDR H.264/HEVC at the encoded size: `ImageReader` YUV buffers. Otherwise: EGL render into an RGBA AHardwareBuffer (or a CPU scoped-copy fallback) |
| Into Skia, preview | WebGPU blit into a reusable texture, then an owned Graphite snapshot | WebGPU blit (YUV→RGB, crop and rotation in one pass), then an owned Graphite snapshot |
| Into Skia, export | Sampled in place through the frame's IOSurface: no copy, no per-clip GPU wait | Same as preview |
| Export output | Skia draws into the encoder's CVPixelBuffer (IOSurface) | Skia draws into an AHardwareBuffer lent by the encoder; EGL samples it into the codec Surface after its sync-fd |
| Fallback | CPU readback, with a warning | CPU readback, with a warning |

Every path waits for checked GPU completion before releasing source frames or handing a buffer to the encoder. Scaled, HDR and 10-bit Android sources keep the EGL decode path.

For advanced exports, `createFrameProcessor` supports asynchronous preparation at each composition timestamp. The optional `react-native-skia-webgpu-video/gpu` entry point provides a resource scope whose asynchronous disposal waits for tracked work. See the [WebGPU cube example](examples/webgpu-overlay.ts).

These are integration building blocks. Three.js adapters, Core ML models, and automatic Neural Engine acceleration are not included. Browser video support is not provided by this native library.

## Benchmarks

Release builds, 3 repetitions per case, deterministic workloads from catalog `2026-10-07.1`, median export wall time. Raw evidence: [iOS device](benchmark/ios-device-361-ab.json), [Android device](benchmark/android-device-361-ab.json); protocol and limits in the [verification report](migration/skia-3.6.1/verification.md). Earlier campaigns: [3.4.4](migration/skia-3.4.4/verification.md).

**iPhone 15 Pro (iOS 27.0.1)**, four alternating series. The export path does not change on iOS, and the per-frame profile is the same in all four; differences between series come from encoder setup and finalization:

| Export case | 3.4.4 | 3.6.1 |
| --- | --- | --- |
| HEVC 1080p, rotated, 180 frames | 731–734 ms | 728–790 ms |
| H.264 640×360, 60 frames | 174–223 ms | 168–169 ms |
| 8 × 4K clips scaled to 1280, 360 frames | 2.72–2.79 s | 2.68–2.73 s |

**Pixel 8a (Android 17)**. In 3.6.1, decoded `ImageReader` frames are sampled in place during export, as on iOS:

| Export case | 3.4.4 | 3.6.1 |
| --- | --- | --- |
| HEVC 1080p, rotated, 180 frames | 3.80 s | **3.00 s** (−21%) |
| H.264 640×360, 60 frames | 1.25 s | **1.16 s** (−7%) |
| 8 × 4K clips at native size, 360 frames | 13.5 s | **10.0 s** (−26%) |
| 3 simultaneous 4K clips, 150 frames | 8.8 s | **5.8 s** (−35%) |
| 8 × 4K clips scaled to 1280 (EGL decode, unchanged path) | 12.0 s | 12.5 s |

Pass `onProfile` to an export to see where the time goes on your own compositions. On the Pixel, a native-size HEVC 1080p frame now spends about 2.8 ms decoding, 3.4 ms importing (down from 6.6), 1.8 ms waiting for the GPU and 4.3 ms encoding; on the iPhone the whole frame takes under 4 ms.

Reproduce on your devices with the example app: `node scripts/test-ios-device-ab-run.mjs` (iPhone) and `node scripts/test-android-device-run.mjs` (Android); see the [benchmark guide](docs/BENCHMARKS.md).

## Status

| Area | Current evidence |
| --- | --- |
| iOS | Simulator (Release): 50/50 native XCTests. iPhone 15 Pro: all export cases above passed in every run, with output sizes identical to 3.4.4 ([verification](migration/skia-3.6.1/verification.md)). |
| Android | Pixel 8a: CPU vs GPU decode comparison 10/10 cases (max channel error 1, including rotation, portrait and 4K); export checks of a color pattern and of a decoded rotated clip match CPU readback. WebGPU 0.15+ changed the colors of decoded YUV frames; this release keeps them as decoded ([audit](migration/skia-3.6.1/upstream-audit.md)). Instrumented tests were last run on 3.4.4 (97/102; the 5 failures predate it). |
| JavaScript / types | 217 tests in 10 suites, typecheck, package tests and 112 benchmark-harness tests pass; CI runs them on every pull request. |
| Image / audio fidelity | Sampled SDR pixels and an exported color pattern are checked on Android; iOS exported files have the same byte size as with 3.0.6. Whole-image fidelity, HDR, audible output and A/V synchronization remain unqualified. |
| Known issues | A 4K lazy composition seek times out in 1 of 3 runs on Pixel 8a, and three simultaneous 4K clips stop on the video memory budget during iPhone playback; both happen before and after this release. With `ImageReader`, 1:1 exports are 5–16% larger files for matching sampled pixels. |
| Long sessions | Not yet re-run on 3.4.4 or 3.6.1; the 3.0.6 results below are the latest. |

### Earlier results (Skia 3.0.6)

These were measured on the previous Skia 3.0.6 / WebGPU 0.12.1 builds and have not been repeated since.

- **Lifecycle:** 6/6 consecutive iPhone montages and 4/4 Android montages passed (240 and 160 remounts), with late memory readings flattening or decreasing.
- **Android AHardwareBuffer playback:** 24/24 focused Release attempts on Pixel 8a passed, including H.264/HEVC 4K and export, with tracked cleanup at zero at a 512 MiB budget ([device diagnostics](docs/ANDROID_DEVICE_306.md)).

On one iPhone 15 Pro, an earlier **3.0.6 before/after optimization** comparison observed roughly **11% less peak physical footprint during 4K playback**, with similar RSS. Small exports took **3.5–6% longer**. The phone was warm and used for tethering; these are descriptive results, not a general speed claim. [Protocol, measurements, and limitations](docs/PERFORMANCE_IPHONE_306_OPTIMIZATION.md).

The Android report preserves the earlier CPU checkpoints: **0/24 strict passes** in the original campaign, then **8/8 operations completed without OOM but 0/8 strict cleanup passes** with scoped-copy. That latter reference has one attempt per case and does not establish an A/B speed gain. The current AHB results cover the selected scenarios; zero tracked reservations do not prove zero driver memory or absence of leaks in longer use.

The eight-clip 4K lifecycle case remained memory intensive: sampled peaks reached **800 MiB RSS / 1,038 MiB PSS**, and RSS remained around **786 MiB after cleanup**, despite zero tracked reservations. RSS and PSS are separate process metrics; their sampled peaks occur independently. The [Android report](docs/ANDROID_DEVICE_306.md) retains these results and the limits of seek/pixel validation.

A subsequent export-worklet fix reduces repeated-session allocation overhead. In matched two-montage Release runs, memory after 60 seconds idle fell from **426 to 258 MiB physical footprint on iPhone 15 Pro**, and from **738 to 577 MiB PSS on Pixel 8a**. These are different platform metrics, not a cross-device comparison. Six consecutive iPhone workloads and four Android workloads passed with flatter or decreasing late-run readings; bounded tests do not prove zero leaks. See the [native memory investigation](docs/NATIVE_MEMORY_INVESTIGATION_306.md) for checkpoints and limits.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run test:package
npm run benchmark:test
npm run build
npm run check-package
```

Native validation: [iPhone](docs/IOS_DEVICE_TESTS.md), [iOS simulator](docs/IOS_SIMULATOR_TESTS.md), [Android](android/BUILD_VALIDATION.md). The [benchmark guide](docs/BENCHMARKS.md) explains workloads and measured versus unavailable metrics. Upgrading Skia or WebGPU: follow the [upstream notes](docs/UPSTREAM_NOTES.md) and the [3.6.1 migration audit](migration/skia-3.6.1/upstream-audit.md), and re-run the Pixel `interop` pixel check, which caught a color regression in WebGPU 0.15.

Contributions are welcome through pull requests. Read the [contribution guide](.github/CONTRIBUTING.md) for the checks and native validation expected for a change.

## Credits

The **Skia 3 / WebGPU frame-interop layer was written from scratch** for this project. Its API takes inspiration from **[batical/react-native-skia-video](https://github.com/batical/react-native-skia-video)**, Sebastien Hecart's fork extending Skia Video with additional capabilities, including HDR source handling, HEVC export, and the `direct` frame mode.

That fork originated from **[AzzappApp/react-native-skia-video](https://github.com/AzzappApp/react-native-skia-video)**.

Maintained by **[Sebastien Hecart (@batical)](https://github.com/batical)**, who contributed to the initial development of the original library's iOS implementation.

Thanks to the original Skia Video authors and contributors, and to the teams behind [React Native Skia](https://github.com/Shopify/react-native-skia) and [React Native WebGPU](https://github.com/wcandillon/react-native-webgpu).

## License

[MIT](LICENSE). Copyright (c) 2026 Sebastien Hecart. See the license for notices applicable to portions originating in earlier work.

<p align="center">
  <img src="docs/assets/banner.svg" alt="React Native Skia WebGPU Video — Play. Compose. Export." width="100%" />
</p>

<p align="center">
  <a href="https://github.com/batical/react-native-skia-webgpu-video/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/batical/react-native-skia-webgpu-video/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
  <a href="#status"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-f59e0b" /></a>
  <img alt="React Native Skia 3.0.6" src="https://img.shields.io/badge/Skia-3.0.6-38bdf8" />
  <img alt="React Native WebGPU 0.12.1" src="https://img.shields.io/badge/WebGPU-0.12.1-a78bfa" />
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

> **Alpha software.** iOS and focused Android tests have run on physical devices. Android memory and performance qualification is still incomplete. See [status](#status) before adopting this in production.

## Installation

### Requirements

| Dependency | Current configuration |
| --- | --- |
| React Native | `0.86.2` tested; declared peer range `>=0.83 <0.87` |
| React | `19.2.3` tested |
| React Native Skia | **`react-native-skia@3.0.6`** |
| React Native WebGPU | **`react-native-webgpu@0.12.1`** |
| Reanimated / Worklets | **`4.5.3` / `0.11.3`** |
| Native runtime | New Architecture and Hermes |
| Android | API **28+** |

A native rebuild is required. Expo Go cannot load this module. For iOS, use the deployment target required by your React Native and Skia versions; the example targets iOS 16.4 or later.

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
npm install --save-exact react-native-skia@3.0.6 react-native-webgpu@0.12.1 react-native-reanimated@4.5.3 react-native-worklets@0.11.3
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

### Audio

Composition clips are **silent by default**. Set `audio: true` to include the source track in playback and export, or `audio: { volume: 0.8 }` to set its volume. Add music or voice-over using a composition item with `kind: 'audio'` and `volume`.

Audio implementations are retained on iOS and Android, including AAC export. The latest device performance campaign did **not** validate audible output or audio/video synchronization. See the [typed API](src/types.ts) for the complete options.

## Migrating from Skia Video

Use `useVideoComposition` for timelines and `useVideoPlayback` for single videos. Rename the previous hook imports and calls; the old names are no longer exported. Composition structure, timeline units, drawing callbacks, and player/export controls are retained. Texture interop changes: replace `MakeImageFromNativeTextureUnstable(frame.texture)` with `drawVideoFrame` or `makeVideoFrameImage`.

**[Read the migration guide →](docs/MIGRATION.md)**

The `copy` and `direct` options remain available for compatibility. Both export modes currently read rendered pixels back to the CPU; `direct` does not yet mean a GPU-only export.

## Memory and GPU extensions

Configure the library's tracked reservations before creating players or export sessions:

```ts
import { configureVideoMemory } from 'react-native-skia-webgpu-video';

configureVideoMemory({ maxBytes: 256 * 1024 * 1024 });
```

This budget covers **tracked video resources**, not all memory held by codecs, Skia, or GPU drivers. Use lazy decoders for sequential compositions, keep preview resolution appropriate, and measure process memory on your target device. Images returned by the frame helpers belong to the library; do not dispose them independently.

On capable Android devices, decoded frames render into immutable AHardwareBuffers and pass through WebGPU into independent Graphite snapshots. Normal playback avoids the RGBA CPU readback/upload; this path passed the focused Pixel 8a tests below. Capability selection happens before decoder preparation, with a scoped-copy CPU fallback for unsupported devices. Both paths keep checked GPU completion before releasing source frames. Export still reads composed pixels back to the CPU; the pipeline is not end-to-end zero-copy.

For advanced exports, `createFrameProcessor` supports asynchronous preparation at each composition timestamp. The optional `react-native-skia-webgpu-video/gpu` entry point provides a resource scope whose asynchronous disposal waits for tracked work. See the [WebGPU cube example](examples/webgpu-overlay.ts).

These are integration building blocks. Three.js adapters, Core ML models, and automatic Neural Engine acceleration are not included. Browser video support is not provided by this native library.

## Status

| Area | Current evidence |
| --- | --- |
| iOS | Initial 3.0.6 build: 50 native XCTest passes. Optimized build: 5 device smoke cases passed; before/after comparison: 96 executions passed across both builds. |
| JavaScript / types | 191 tests passed in 8 suites; typecheck passed. The benchmark harness passed 112 tests. |
| Android | AHardwareBuffer Release on Pixel 8a: 24/24 focused attempts passed, including H264/HEVC 4K and export, with tracked cleanup zero at a 512 MiB budget. Six AHB and five CPU ownership tests passed on device; 43 host JVM tests passed. [Device diagnostics](docs/ANDROID_DEVICE_306.md). |
| Audio / image fidelity | Android CPU/AHB comparison passed 10/10 cases with identical sampled SDR pixels. Whole-image fidelity, HDR, audible output and synchronization remain unqualified. |
| Lifecycle / long sessions | Four additional Android cases passed, including eight lazy-decoded 4K clips, 25 short cycles and 40 remounts. Sustained memory stability and absence of leaks are not established. |

On one iPhone 15 Pro, an earlier **3.0.6 before/after optimization** comparison observed roughly **11% less peak physical footprint during 4K playback**, with similar RSS. Small exports took **3.5–6% longer**. The phone was warm and used for tethering; these are descriptive results, not a general speed claim. [Protocol, measurements, and limitations](docs/PERFORMANCE_IPHONE_306_OPTIMIZATION.md).

The Android report preserves the earlier CPU checkpoints: **0/24 strict passes** in the original campaign, then **8/8 operations completed without OOM but 0/8 strict cleanup passes** with scoped-copy. That latter reference has one attempt per case and does not establish an A/B speed gain. The current AHB results cover the selected scenarios; zero tracked reservations do not prove zero driver memory or absence of leaks in longer use.

The eight-clip 4K lifecycle case remained memory intensive: sampled peaks reached **800 MiB RSS / 1,038 MiB PSS**, and RSS remained around **786 MiB after cleanup**, despite zero tracked reservations. RSS and PSS are separate process metrics; their sampled peaks occur independently. The [Android report](docs/ANDROID_DEVICE_306.md) retains these results and the limits of seek/pixel validation.

A subsequent export-worklet fix reduces repeated-session allocation overhead. In matched two-montage Release runs, memory after 60 seconds idle fell from **426 to 258 MiB physical footprint on iPhone 15 Pro**, and from **738 to 577 MiB PSS on Pixel 8a**. These are different platform metrics, not a cross-device comparison. Six consecutive iPhone workloads passed with a much flatter late-run trend; bounded tests do not prove zero leaks. See the [native memory investigation](docs/NATIVE_MEMORY_INVESTIGATION_306.md) for checkpoints and limits.

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

Native validation: [iPhone](docs/IOS_DEVICE_TESTS.md), [iOS simulator](docs/IOS_SIMULATOR_TESTS.md), [Android](android/BUILD_VALIDATION.md). The [benchmark guide](docs/BENCHMARKS.md) explains workloads and measured versus unavailable metrics.

Contributions are welcome through pull requests. Read the [contribution guide](.github/CONTRIBUTING.md) for the checks and native validation expected for a change.

## Credits

The **Skia 3 / WebGPU frame-interop layer was written from scratch** for this project. Its API takes inspiration from **[batical/react-native-skia-video](https://github.com/batical/react-native-skia-video)**, Sebastien Hecart's fork extending Skia Video with additional capabilities, including HDR source handling, HEVC export, and the `direct` frame mode.

That fork originated from **[AzzappApp/react-native-skia-video](https://github.com/AzzappApp/react-native-skia-video)**.

Maintained by **[Sebastien Hecart (@batical)](https://github.com/batical)**, who contributed to the initial development of the original library's iOS implementation.

Thanks to the original Skia Video authors and contributors, and to the teams behind [React Native Skia](https://github.com/Shopify/react-native-skia) and [React Native WebGPU](https://github.com/wcandillon/react-native-webgpu).

## License

[MIT](LICENSE). Copyright (c) 2026 Sebastien Hecart. See the license for notices applicable to portions originating in earlier work.

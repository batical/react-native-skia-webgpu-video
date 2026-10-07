# Migrating from React Native Skia Video

This alpha builds on the API of `@azzapp/react-native-skia-video` and its `batical` fork. Most composition and drawing concepts remain, while frame ownership and Skia texture interop change.

## Dependencies and native rebuild

Follow the [installation instructions](../README.md#installation) with the exact tested Skia, WebGPU, Reanimated, and Worklets versions. Remove the old Skia and Skia Video packages from the application before installing their replacements. Two native modules with the old and new video implementations must not coexist.

Replace imports:

| Previous package | New package |
| --- | --- |
| `@shopify/react-native-skia` | `react-native-skia` |
| `@azzapp/react-native-skia-video` or your fork's package name | `react-native-skia-webgpu-video` |

Apply the required Skia patch in the consuming app, install pods on iOS, and rebuild native binaries. A JavaScript-only update cannot apply the native changes. See [upstream notes](UPSTREAM_NOTES.md) before changing the pinned Skia version.

## Frame drawing

New code uses `useVideoComposition` for a timeline and `useVideoPlayback` for a single video. The previous names `useVideoCompositionPlayer` and `useVideoPlayer` remain deprecated aliases with the same options, return values, and function identity. You can update imports independently from the texture migration.

A native Metal or OpenGL texture handle is not a Dawn texture. Replace calls to `Skia.Image.MakeImageFromNativeTextureUnstable(frame.texture, ...)` with the library helper:

```ts
import { drawVideoFrame } from 'react-native-skia-webgpu-video';
import type { FrameDrawer } from 'react-native-skia-webgpu-video';

const drawFrame: FrameDrawer = ({ canvas, frames, width, height }) => {
  'worklet';
  const frame = frames.clip;
  if (frame) {
    drawVideoFrame(canvas, frame, { x: 0, y: 0, width, height }, {
      fit: 'contain',
    });
  }
};
```

Use `makeVideoFrameImage(frame)` if you need the image for another Skia operation. The library owns the returned image: do not independently call `dispose()` on it, change its native descriptor, or keep using it after its producer releases it. Application-owned synthetic frames need their own explicit ownership and cleanup.

The hooks still expose familiar play, pause, seek, looping, and readiness/error events. Compositions use seconds. `beforeDrawFrame` and `afterDrawFrame` run **per frame**; they are not session initialization/finalization callbacks.

## Preview and export

`useVideoComposition` renders a composition to a shared current image. Reuse the composition and `drawFrame` in `exportVideoComposition`. The [README example](../README.md#one-composition-preview-and-export) shows both.

- Composition sources use app-accessible local filesystem paths.
- Preview width/height are layout points; the drawing callback receives pixel dimensions. Export width/height are pixels.
- Use `lazyDecoders` for sequential timelines. A preview decode limit such as `maxLongSide` also limits source detail if reused during export; use separate settings when necessary.
- `copy` and `direct` remain API options. Both currently export through CPU readback. Inspect `getVideoResourceStats().backend` for the actual transport instead of inferring it from the requested mode.
- Private APIs are retained for compatibility, but their frames use the new ownership protocol. Code that directly consumes native textures needs a dedicated review.

## Audio

Audio options retain their existing meaning. A video composition item is silent by default; use `audio: true` or `audio: { volume: 0.8 }` to include its audio during playback and export. Separate `kind: 'audio'` items support music or voice-over. `useVideoPlayback` has its own `volume` option.

Audio is implemented on both native platforms, but the current 3.0.6 device performance runs did not exercise audible output or validate audio synchronization. Test these paths with your application's actual sources before shipping.

## Memory and extensions

Set `configureVideoMemory({ maxBytes })` before allocating sessions. The budget covers tracked resources only; codecs and drivers can retain additional memory. A budget rejection does not silently reduce export dimensions.

The optional `createFrameProcessor` export factory creates a processor once per export. Its asynchronous `prepareFrame` runs at the requested composition timestamp and its `dispose` must finish all frame readers. Drive animated effects from that timestamp, not an independent display animation loop.

For GPU work, create `createVideoGpuScope` on the runtime that uses it. The Skia device is shared: do not destroy it or pass command encoders across runtimes. Track asynchronous work before starting it, remove images from consumers, and await `scope.dispose()`. CPU/ML inference needs its own tracked completion; a graphics fence does not finish unrelated inference.

If completion cannot be established after an error, the library can retain the affected state and reject later work to avoid releasing resources still in use. Zero tracked reservations alone is not proof that all process or GPU memory has been returned.

## Application validation

Check orientation, seek/loop behavior, source audio and added tracks, export dimensions and timestamps, cancellation, and repeated mount/export/unmount cycles on both platforms. Existing Skia patches, custom texture loaders, Skottie integrations, and application-specific effects require their own migration review.

See the [benchmark guide](BENCHMARKS.md) and [current iPhone comparison](PERFORMANCE_IPHONE_306_OPTIMIZATION.md) for what has actually been measured. Performance results are specific to their workloads and conditions.

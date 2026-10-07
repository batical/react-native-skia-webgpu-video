import { Platform } from "react-native";
import type { RNSkiaVideoModule } from "./types";
import NativeReactNativeSkiaVideo from "./NativeReactNativeSkiaVideo";

if (!NativeReactNativeSkiaVideo) {
  throw new Error(
    `The package 'react-native-skia-webgpu-video' doesn't seem to be linked. Make sure: \n\n` +
      Platform.select({ ios: "- You have run 'pod install'\n", default: "" }) +
      "- You rebuilt the app after installing the package\n" +
      "- You are not using Expo Go\n",
  );
}

const installed = NativeReactNativeSkiaVideo.install();
if (!installed || (global as any).RNSkiaVideo == null) {
  throw new Error(
    "The package 'react-native-skia-webgpu-video' failed to install its JSI bindings.",
  );
}

const module = (global as any).RNSkiaVideo as RNSkiaVideoModule;
if (module.frameProtocolVersion !== 1) {
  throw new Error(
    "Skia 3 video native bindings are outdated. Rebuild the native app and remove the legacy Skia Video package.",
  );
}
export default module;

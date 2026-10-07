/// <reference types="@webgpu/types" />
import { Platform } from "react-native";
import { Skia } from "react-native-skia";
import {
  GPUTextureUsage,
  importDevice,
  installWebGPU,
} from "react-native-webgpu";
import type { NativeVideoFrame } from "react-native-webgpu";
import RNSkiaVideoModule from "./RNSkiaVideoModule";

// Evaluate on the RN runtime. NativeObject serializers carry these objects to
// each consuming worklet; installWebGPU does not install RNWebGPU there.
// Never destroy the shared Graphite device or call methods across runtimes on
// a command encoder. Each caller owns its own per-runtime import resources.
const sharedDevice = importDevice(Skia.getNativeDevice());
const nativeWebGPU = globalThis.RNWebGPU;

// Negotiate before any Android decoder is prepared. The native side starts in
// CPU mode and probes EGL/AHB setup only when this shared Dawn device can
// import and end access to AHBs. Missing capability is a clean CPU fallback;
// budget failures, OOM and unrelated setup errors must remain visible.
if (
  Platform.OS === "android" &&
  RNSkiaVideoModule.configureNativeBufferInterop
) {
  const features = sharedDevice.features as ReadonlySet<string> | undefined;
  const supported = Boolean(
    typeof nativeWebGPU?.createVideoFrameFromNativeBuffer === "function" &&
    typeof features?.has === "function" &&
    features.has("shared-texture-memory-ahardware-buffer") &&
    features.has("shared-fence-sync-fd"),
  );
  try {
    RNSkiaVideoModule.configureNativeBufferInterop(supported);
  } catch (error) {
    if (
      !supported ||
      !(error instanceof Error) ||
      !error.message.includes("Android native buffer interop unavailable:")
    )
      throw error;
    RNSkiaVideoModule.configureNativeBufferInterop(false);
  }
}

export const getVideoGpuDevice = (): GPUDevice => {
  "worklet";
  installWebGPU();
  return sharedDevice;
};

export const createNativeVideoGpuFrame = (
  pointer: bigint,
): NativeVideoFrame => {
  "worklet";
  if (!nativeWebGPU)
    throw new Error("React Native WebGPU is missing from the native app");
  return nativeWebGPU.createVideoFrameFromNativeBuffer(pointer);
};

export const nativeVideoTextureUsage =
  GPUTextureUsage.RENDER_ATTACHMENT |
  GPUTextureUsage.TEXTURE_BINDING |
  GPUTextureUsage.COPY_SRC;

// CPU RGBA uploads additionally need COPY_DST. Keep the native-buffer blit's
// descriptor unchanged: that path renders into its destination attachment.
export const rgbaVideoTextureUsage =
  nativeVideoTextureUsage | GPUTextureUsage.COPY_DST;

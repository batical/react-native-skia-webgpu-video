/// <reference types="@webgpu/types" />
import { Skia } from "react-native-skia";
import {
  GPUTextureUsage,
  importDevice,
  installWebGPU,
} from "react-native-webgpu";
import type { NativeVideoFrame } from "react-native-webgpu";

// Evaluate on the RN runtime. NativeObject serializers carry these objects to
// each consuming worklet; installWebGPU does not install RNWebGPU there.
// Never destroy the shared Graphite device or call methods across runtimes on
// a command encoder. Each caller owns its own per-runtime import resources.
const sharedDevice = importDevice(Skia.getNativeDevice());
const nativeWebGPU = globalThis.RNWebGPU;

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

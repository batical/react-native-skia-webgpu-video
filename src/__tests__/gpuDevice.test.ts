import { importDevice, installWebGPU } from "react-native-webgpu";

const mockDevice = { destroy: jest.fn() };
jest.mock("react-native-skia", () => ({
  Skia: { getNativeDevice: jest.fn(() => 55n) },
}));
jest.mock("react-native-webgpu", () => ({
  importDevice: jest.fn(() => mockDevice),
  installWebGPU: jest.fn(),
  GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 },
}));

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).RNWebGPU;
  jest.clearAllMocks();
});

describe("shared video GPU runtime inputs", () => {
  it("keeps the RN native object captured even when the consuming runtime has no RNWebGPU global", () => {
    const source = { release: jest.fn() };
    const bridge = { createVideoFrameFromNativeBuffer: jest.fn(() => source) };
    (globalThis as unknown as Record<string, unknown>).RNWebGPU = bridge;
    jest.isolateModules(() => {
      const gpu = require("../gpuDevice") as typeof import("../gpuDevice");
      delete (globalThis as unknown as Record<string, unknown>).RNWebGPU;
      expect(gpu.createNativeVideoGpuFrame(123n)).toBe(source);
      expect(bridge.createVideoFrameFromNativeBuffer).toHaveBeenCalledWith(
        123n,
      );
      expect(gpu.getVideoGpuDevice()).toBe(mockDevice);
      expect(gpu.nativeVideoTextureUsage).toBe(20);
      expect(importDevice).toHaveBeenCalledWith(55n);
      expect(installWebGPU).toHaveBeenCalledTimes(1);
      expect(mockDevice.destroy).not.toHaveBeenCalled();
    });
    // This checks JS capture only; native Worklets boxing/prototype restoration
    // still requires an actual app runtime and is not claimed by this test.
  });

  it("fails clearly when the native wrapper bridge was unavailable at initialization", () => {
    delete (globalThis as unknown as Record<string, unknown>).RNWebGPU;
    jest.isolateModules(() => {
      const gpu = require("../gpuDevice") as typeof import("../gpuDevice");
      expect(() => gpu.createNativeVideoGpuFrame(123n)).toThrow(
        "React Native WebGPU is missing from the native app",
      );
    });
  });
});

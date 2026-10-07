import { importDevice, installWebGPU } from "react-native-webgpu";
import { Platform } from "react-native";

const mockDevice = { features: new Set<string>(), destroy: jest.fn() };
const mockConfigureInterop = jest.fn();
const mockNativeModule: { configureNativeBufferInterop?: jest.Mock } = {
  configureNativeBufferInterop: mockConfigureInterop,
};
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: mockNativeModule,
}));
jest.mock("react-native-skia", () => ({
  Skia: { getNativeDevice: jest.fn(() => 55n) },
}));
jest.mock("react-native-webgpu", () => ({
  importDevice: jest.fn(() => mockDevice),
  installWebGPU: jest.fn(),
  GPUTextureUsage: {
    RENDER_ATTACHMENT: 16,
    TEXTURE_BINDING: 4,
    COPY_SRC: 1,
    COPY_DST: 2,
  },
}));

beforeEach(() => {
  (Platform as unknown as { OS: string }).OS = "ios";
  mockDevice.features.clear();
  mockConfigureInterop.mockReset();
  mockNativeModule.configureNativeBufferInterop = mockConfigureInterop;
});

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
      expect(gpu.nativeVideoTextureUsage).toBe(21);
      expect(gpu.rgbaVideoTextureUsage).toBe(23);
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

  it("enables Android AHB setup only when the shared device supports import and the returned sync-fd fence", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    (globalThis as unknown as Record<string, unknown>).RNWebGPU = {
      createVideoFrameFromNativeBuffer: jest.fn(),
    };
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop).toHaveBeenCalledTimes(1);
      expect(mockConfigureInterop).toHaveBeenCalledWith(true);
      expect(
        (importDevice as jest.Mock).mock.invocationCallOrder[0]!,
      ).toBeLessThan(mockConfigureInterop.mock.invocationCallOrder[0]!);
      expect(mockDevice.destroy).not.toHaveBeenCalled();
    });
  });

  it("selects CPU before decoder setup if either required Dawn feature is absent", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    (globalThis as unknown as Record<string, unknown>).RNWebGPU = {
      createVideoFrameFromNativeBuffer: jest.fn(),
    };
    for (const feature of [
      "shared-texture-memory-ahardware-buffer",
      "shared-fence-sync-fd",
    ]) {
      mockDevice.features.clear();
      mockDevice.features.add(feature);
      mockConfigureInterop.mockClear();
      jest.isolateModules(() => {
        require("../gpuDevice");
        expect(mockConfigureInterop).toHaveBeenCalledTimes(1);
        expect(mockConfigureInterop).toHaveBeenCalledWith(false);
      });
    }
  });

  it("selects CPU if the native frame wrapper was not installed", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop).toHaveBeenCalledWith(false);
    });
  });

  it("keeps the native CPU default when an older binding has no negotiation method", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    delete mockNativeModule.configureNativeBufferInterop;
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop).not.toHaveBeenCalled();
    });
  });

  it("falls back before decoding only for the controlled native capability refusal", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    (globalThis as unknown as Record<string, unknown>).RNWebGPU = {
      createVideoFrameFromNativeBuffer: jest.fn(),
    };
    mockConfigureInterop.mockImplementationOnce(() => {
      throw new Error(
        "Exception in HostFunction: Android native buffer interop unavailable: EGL extension missing",
      );
    });
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop.mock.calls).toEqual([[true], [false]]);
    });
  });

  it("preserves allocation and unexpected setup failures instead of disguising them as a CPU fallback", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    (globalThis as unknown as Record<string, unknown>).RNWebGPU = {
      createVideoFrameFromNativeBuffer: jest.fn(),
    };
    const failure = new Error("Native AHB memory budget exhausted");
    mockConfigureInterop.mockImplementationOnce(() => {
      throw failure;
    });
    jest.isolateModules(() => {
      expect(() => require("../gpuDevice")).toThrow(failure);
      expect(mockConfigureInterop.mock.calls).toEqual([[true]]);
    });
  });

  it("does not retry a failed disable operation even if its error contains the capability prefix", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    const failure = new Error(
      "Android native buffer interop unavailable: cannot disable",
    );
    mockConfigureInterop.mockImplementationOnce(() => {
      throw failure;
    });
    jest.isolateModules(() => {
      expect(() => require("../gpuDevice")).toThrow(failure);
      expect(mockConfigureInterop.mock.calls).toEqual([[false]]);
    });
  });

  it("does not configure Android buffer interop on iOS", () => {
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    (globalThis as unknown as Record<string, unknown>).RNWebGPU = {
      createVideoFrameFromNativeBuffer: jest.fn(),
    };
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop).not.toHaveBeenCalled();
    });
  });
});

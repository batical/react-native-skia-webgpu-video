const mockRuntimeTasks: Array<() => void> = [];
const mockCalls: string[] = [];
const mockImport = jest.fn();
const mockNativeFrame = jest.fn();
// The YUV conversion of decoded ImageReader frames (see yuvBlit.ts).
const mockYuvWrappers: { destroy: jest.Mock }[] = [];
const mockDevice = {
  importSharedTextureMemory: mockImport,
  createTexture: jest.fn((descriptor: { size: object }) => ({
    ...descriptor.size,
    format: "rgba8unorm",
    createView: jest.fn(() => ({})),
    destroy: jest.fn(() => mockCalls.push("source.destroy")),
  })),
  createBindGroupLayout: jest.fn(() => ({})),
  createPipelineLayout: jest.fn(() => ({})),
  createSampler: jest.fn(() => ({})),
  createShaderModule: jest.fn(() => ({})),
  createRenderPipeline: jest.fn(() => ({})),
  createNativeBufferExternalTexture: jest.fn(() => {
    const wrapper = {
      externalTexture: {},
      beginAccess: jest.fn(),
      endAccess: jest.fn(() => null),
      destroy: jest.fn(() => mockCalls.push("yuv.destroy")),
    };
    mockYuvWrappers.push(wrapper);
    return wrapper;
  }),
  createBuffer: jest.fn(() => ({ destroy: jest.fn() })),
  createBindGroup: jest.fn(() => ({})),
  createCommandEncoder: jest.fn(() => ({
    beginRenderPass: jest.fn(() => ({
      setPipeline: jest.fn(),
      setBindGroup: jest.fn(),
      draw: jest.fn(),
      end: jest.fn(),
    })),
    finish: jest.fn(() => ({})),
  })),
  queue: {
    writeBuffer: jest.fn(),
    submit: jest.fn(() => mockCalls.push("convert")),
  },
};
jest.mock("../gpuDevice", () => ({
  getVideoGpuDevice: jest.fn(() => mockDevice),
  createNativeVideoGpuFrame: (handle: bigint) => mockNativeFrame(handle),
  nativeVideoTextureUsage: 20,
  videoShaderStages: { vertex: 1, fragment: 2 },
  videoUniformBufferUsage: 72,
}));
jest.mock("react-native-worklets", () => ({
  createWorkletRuntime: jest.fn(() => ({ name: "export" })),
  runOnRuntime: jest.fn((_runtime: unknown, fn: () => void) => () => {
    mockRuntimeTasks.push(fn);
  }),
  scheduleOnRN: jest.fn(
    (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
  ),
  createSynchronizable: jest.fn((initial: boolean) => {
    let value = initial;
    return {
      getBlocking: () => value,
      setBlocking: (next: boolean) => {
        value = next;
      },
    };
  }),
}));
jest.mock("../runtimeYield", () => ({
  yieldToRuntime: jest.fn((fn: () => void) => {
    mockRuntimeTasks.push(fn);
  }),
}));
jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
// The copying importer is covered by frameInterop.test.ts.
jest.mock("../frameInterop", () => ({
  ownVideoFrames: jest.fn((frames: Record<string, { id?: number }>) => {
    const owned: Record<string, unknown> = {};
    for (const [key, frame] of Object.entries(frames))
      owned[key] = { ...frame, texture: { kind: "skia-image", image: {} } };
    return owned;
  }),
  releaseVideoFrameImage: jest.fn(),
  clearVideoFrameImages: jest.fn(),
}));
const mockSurface = (label: string) => {
  const canvas = {
    drawColor: jest.fn(),
    readPixels: jest.fn(
      (_x: number, _y: number, _info: unknown, destination: Uint8Array) =>
        destination,
    ),
    dispose: jest.fn(() => mockCalls.push(`${label}.canvas.dispose`)),
  };
  return {
    canvas,
    enableCheckedSubmissions: jest.fn(),
    getCanvas: jest.fn(() => canvas),
    flush: jest.fn(() => mockCalls.push(`${label}.flush`)),
    dispose: jest.fn(() => mockCalls.push(`${label}.dispose`)),
  };
};
jest.mock("react-native-skia", () => ({
  Skia: {
    __rnskvTrimRecorderCache: jest.fn(),
    Surface: {
      MakeOffscreen: jest.fn(() => mockSurface("offscreen")),
      MakeFromGPUTexture: jest.fn(() => mockSurface("target")),
    },
    Image: { MakeImageFromGPUTexture: jest.fn() },
    Color: jest.fn(() => 0),
  },
  BlendMode: { Clear: 0 },
  ColorType: { RGBA_8888: 4, BGRA_8888: 6 },
  AlphaType: { Premul: 1, Opaque: 0 },
}));
jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: {
    createVideoEncoder: jest.fn(),
    createVideoCompositionFramesExtractorSync: jest.fn(),
    reserveMemory: jest.fn(() => 42),
    releaseMemory: jest.fn(),
    getBackendInfo: jest.fn(() => ({ gpuDirectExport: true })),
  },
}));

import { Skia } from "react-native-skia";
import RNSkiaVideoModule from "../RNSkiaVideoModule";
import type { VideoFrame } from "../types";
import { exportVideoComposition } from "../exportVideoComposition";
import { ownVideoFrames } from "../frameInterop";

const createVideoEncoder = RNSkiaVideoModule.createVideoEncoder as jest.Mock;
const createExtractor =
  RNSkiaVideoModule.createVideoCompositionFramesExtractorSync as jest.Mock;
const makeOffscreen = Skia.Surface.MakeOffscreen as jest.Mock;
const makeFromTexture = (
  Skia.Surface as unknown as { MakeFromGPUTexture: jest.Mock }
).MakeFromGPUTexture;

let nextFence = 70n;
const sharedMemory = ({
  format = "rgba8unorm",
  fenceType = "sync-fd",
}: { format?: string; fenceType?: string } = {}) => ({
  createTexture: jest.fn(() => ({
    width: 640,
    height: 360,
    format,
    destroy: jest.fn(() => mockCalls.push("texture.destroy")),
  })),
  beginAccess: jest.fn(() => mockCalls.push("beginAccess")),
  endAccess: jest.fn(() => {
    mockCalls.push("endAccess");
    return {
      initialized: true,
      fences: [
        {
          fence: {
            export: jest.fn(() => {
              mockCalls.push("fence.export");
              return { type: fenceType, handle: nextFence++ };
            }),
            destroy: jest.fn(() => mockCalls.push("fence.destroy")),
          },
          signaledValue: 1n,
        },
      ],
    };
  }),
  destroy: jest.fn(() => mockCalls.push("memory.destroy")),
});

const prepare = (decode: () => Record<string, unknown> = () => ({})) => {
  let next = 1n;
  const encoder = {
    prepare: jest.fn(),
    acquireFrameBuffer: jest.fn(() => next++),
    releaseFrameBuffer: jest.fn(() => mockCalls.push("releaseFrameBuffer")),
    encodeFrame: jest.fn((_frame: unknown, _time: number) => {
      mockCalls.push("encode");
    }),
    finishWriting: jest.fn(),
    dispose: jest.fn(),
  };
  createVideoEncoder.mockReturnValueOnce(encoder);
  createExtractor.mockReturnValueOnce({
    start: jest.fn(),
    decodeCompositionFrames: jest.fn(decode),
    dispose: jest.fn(),
  });
  const promise = exportVideoComposition({
    videoComposition: { duration: 1, items: [] },
    outPath: "/tmp/out.mp4",
    width: 640,
    height: 360,
    frameRate: 3,
    bitRate: 1_000_000,
    drawFrame: jest.fn(() => mockCalls.push("draw")),
  });
  void promise.catch(() => undefined);
  return { encoder, promise };
};

const pumpAll = async () => {
  for (let i = 0; i < 200; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    const task = mockRuntimeTasks.shift();
    if (!task) return;
    task();
  }
  throw new Error("Export did not settle");
};

beforeEach(() => {
  delete (globalThis as { __rnskwgpuExport?: unknown }).__rnskwgpuExport;
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockRuntimeTasks.length = 0;
  nextFence = 70n;
  mockYuvWrappers.length = 0;
  mockImport.mockReset().mockImplementation(() => sharedMemory());
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("Android GPU export", () => {
  it("renders into lent AHardwareBuffers and hands their sync-fds to the encoder", async () => {
    const { encoder, promise } = prepare();
    await pumpAll();
    await promise;
    // The AHardwareBuffer pointer is the import handle: no NativeVideoFrame.
    expect(mockNativeFrame).not.toHaveBeenCalled();
    expect(mockImport.mock.calls.map(([d]) => d.handle)).toEqual([
      1n,
      2n,
      3n,
      4n,
    ]);
    expect(makeOffscreen).not.toHaveBeenCalled();
    // The probe's access ends without a fence to hand over.
    expect(encoder.encodeFrame.mock.calls).toEqual([
      [{ kind: "native-buffer", nativeBuffer: 2n, fences: [70n] }, 0],
      [{ kind: "native-buffer", nativeBuffer: 3n, fences: [71n] }, 1 / 3],
      [{ kind: "native-buffer", nativeBuffer: 4n, fences: [72n] }, 2 / 3],
    ]);
    const frame = [
      "beginAccess",
      "draw",
      "target.flush",
      "target.canvas.dispose",
      "target.dispose",
      "endAccess",
      "fence.export",
      "fence.destroy",
      "texture.destroy",
      "memory.destroy",
      "encode",
    ];
    const probe = [
      "beginAccess",
      "target.flush",
      "target.canvas.dispose",
      "target.dispose",
      "endAccess",
      "fence.destroy",
      "texture.destroy",
      "memory.destroy",
      "releaseFrameBuffer",
    ];
    expect(mockCalls).toEqual([...probe, ...frame, ...frame, ...frame]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("falls back to CPU readback when the lent buffer is not RGBA", async () => {
    mockImport.mockImplementation(() => sharedMemory({ format: "bgra8unorm" }));
    const { encoder, promise } = prepare();
    await pumpAll();
    await promise;
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(jest.mocked(console.warn).mock.calls[0]![1])).toContain(
      "RGBA layout mismatch",
    );
    expect(encoder.releaseFrameBuffer).toHaveBeenCalledTimes(1);
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
    for (const [pixels] of encoder.encodeFrame.mock.calls)
      expect(pixels).toMatchObject({ kind: "rgba", width: 640, height: 360 });
  });

  it("fails the frame on a fence the encoder cannot wait on", async () => {
    let imports = 0;
    mockImport.mockImplementation(() =>
      // The probe passes; the first encoded frame gets an opaque-fd fence.
      sharedMemory(
        ++imports > 1 ? { fenceType: "vk-semaphore-opaque-fd" } : {},
      ),
    );
    const { encoder, promise } = prepare();
    await pumpAll();
    await expect(promise).rejects.toThrow("GPU export needs sync-fd fences");
    expect(encoder.encodeFrame).not.toHaveBeenCalled();
    const failed = makeFromTexture.mock.results[1]!.value;
    expect(failed.flush).toHaveBeenCalledWith(true);
    // The fence wrapper and the import still close.
    for (const memory of mockImport.mock.results.map((r) => r.value))
      expect(memory.destroy).toHaveBeenCalledTimes(1);
    expect(encoder.dispose).toHaveBeenCalledTimes(1);
  });

  it("samples ImageReader frames in place once converted, without snapshots or waits", async () => {
    const makeImage = Skia.Image.MakeImageFromGPUTexture as jest.Mock;
    makeImage.mockImplementation(() => ({
      dispose: jest.fn(() => mockCalls.push("image.dispose")),
    }));
    mockNativeFrame.mockImplementation((handle: bigint) => ({
      handle,
      width: 648,
      height: 368,
      pixelFormat: "bgra8",
      release: jest.fn(() => mockCalls.push(`frame${handle}.release`)),
    }));
    const frames: VideoFrame[] = [];
    let id = 0;
    const { promise } = prepare(() => {
      const frameId = ++id;
      const frame: VideoFrame = {
        id: frameId,
        producerId: 7,
        width: 640,
        height: 360,
        rotation: 0,
        // The ImageReader cycles through its buffers.
        texture: {
          kind: "native-buffer",
          nativeBuffer: frameId === 2 ? 501n : 500n,
          region: { x: 0, y: 0, width: 640, height: 360 },
          rotation: 0,
        },
        dispose: jest.fn(() => mockCalls.push(`lease${frameId}.dispose`)),
      };
      frames.push(frame);
      return { clip: frame };
    });
    await pumpAll();
    await promise;
    expect(jest.mocked(console.warn).mock.calls).toEqual([]);
    // No copy through frameInterop, no snapshot, no wait of its own.
    expect(ownVideoFrames).not.toHaveBeenCalled();
    expect(mockDevice.createTexture).toHaveBeenCalledTimes(1);
    const source = mockDevice.createTexture.mock.results[0]!.value;
    expect(makeImage.mock.calls).toEqual([[source], [source], [source]]);
    // Two buffers, each imported once.
    expect(mockDevice.createNativeBufferExternalTexture).toHaveBeenCalledTimes(
      2,
    );
    const exported = mockCalls.slice(
      mockCalls.indexOf("releaseFrameBuffer") + 1,
    );
    // The conversion precedes the drawing; a lease is given back after the
    // next frame's conversion, once its own frame's checked flush returned.
    expect(exported.slice(0, 3)).toEqual(["convert", "beginAccess", "draw"]);
    const second = exported.indexOf("convert", 3);
    expect(exported.indexOf("lease1.dispose")).toBeGreaterThan(second);
    expect(exported.lastIndexOf("target.flush")).toBeLessThan(
      exported.indexOf("lease3.dispose"),
    );
    for (const frame of frames) expect(frame.dispose).toHaveBeenCalledTimes(1);
    // Everything is released once the export ends.
    for (const wrapper of mockYuvWrappers)
      expect(wrapper.destroy).toHaveBeenCalledTimes(1);
    expect(source.destroy).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).toHaveBeenCalledWith(42);
    makeImage.mockReset();
    mockNativeFrame.mockReset();
  });

  it("closes the fresh lease Android hands out for a picture a clip holds", async () => {
    const makeImage = Skia.Image.MakeImageFromGPUTexture as jest.Mock;
    makeImage.mockImplementation(() => ({ dispose: jest.fn() }));
    mockNativeFrame.mockImplementation((handle: bigint) => ({
      handle,
      width: 640,
      height: 360,
      pixelFormat: "bgra8",
      release: jest.fn(),
    }));
    // The first picture is held over two export frames: each decode leases
    // it again.
    const ids = [1, 1, 2];
    const frames: VideoFrame[] = [];
    const { promise } = prepare(() => {
      const frame: VideoFrame = {
        id: ids[frames.length]!,
        producerId: 7,
        width: 640,
        height: 360,
        rotation: 0,
        texture: {
          kind: "native-buffer",
          nativeBuffer: 500n,
          region: { x: 0, y: 0, width: 640, height: 360 },
          rotation: 0,
        },
        dispose: jest.fn(),
      };
      frames.push(frame);
      return { clip: frame };
    });
    await pumpAll();
    await promise;
    expect(console.warn).not.toHaveBeenCalled();
    // Two pictures, two conversions; every lease closes exactly once.
    expect(makeImage).toHaveBeenCalledTimes(2);
    for (const frame of frames) expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).toHaveBeenCalledWith(42);
    makeImage.mockReset();
    mockNativeFrame.mockReset();
  });

  it("keeps copying decoded frames: only the output is GPU-direct", async () => {
    let id = 0;
    const { promise } = prepare(() => ({
      clip: {
        id: ++id,
        producerId: 7,
        width: 640,
        height: 360,
        rotation: 0,
        texture: { kind: "native-buffer", nativeBuffer: 500n },
        dispose: jest.fn(),
      },
    }));
    await pumpAll();
    await promise;
    expect(ownVideoFrames).toHaveBeenCalledTimes(3);
    expect(
      mockImport.mock.calls.filter(
        ([d]) => d.label === "video export source frame",
      ),
    ).toHaveLength(0);
  });
});

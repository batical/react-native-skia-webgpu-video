const mockRuntimeTasks: Array<() => void> = [];
const mockCalls: string[] = [];
const mockImport = jest.fn();
jest.mock("../gpuDevice", () => ({
  getVideoGpuDevice: jest.fn(() => ({ importSharedTextureMemory: mockImport })),
  createNativeVideoGpuFrame: jest.fn((pointer: bigint) => ({
    handle: pointer + 1000n,
    width: 640,
    height: 360,
    pixelFormat: "bgra8",
    release: jest.fn(() => mockCalls.push("frame.release")),
  })),
  nativeVideoTextureUsage: 20,
}));
jest.mock("react-native-worklets", () => ({
  createWorkletRuntime: jest.fn(() => ({ name: "export" })),
  runOnRuntime: jest.fn((_runtime: unknown, fn: () => void) => () => {
    mockRuntimeTasks.push(fn);
  }),
  scheduleOnRN: jest.fn((fn: (...args: unknown[]) => void, ...args: unknown[]) =>
    fn(...args),
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
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
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
    runWithAutoreleasePool: jest.fn((fn: () => unknown) => fn()),
    getBackendInfo: jest.fn(() => ({ gpuDirectExport: true })),
  },
}));

import { Skia } from "react-native-skia";
import RNSkiaVideoModule from "../RNSkiaVideoModule";
import { exportVideoComposition } from "../exportVideoComposition";

const createVideoEncoder = RNSkiaVideoModule.createVideoEncoder as jest.Mock;
const createExtractor =
  RNSkiaVideoModule.createVideoCompositionFramesExtractorSync as jest.Mock;
const reserveMemory = RNSkiaVideoModule.reserveMemory as jest.Mock;
const makeOffscreen = Skia.Surface.MakeOffscreen as jest.Mock;
const makeFromTexture = (
  Skia.Surface as unknown as { MakeFromGPUTexture: jest.Mock }
).MakeFromGPUTexture;

const sharedMemory = () => ({
  createTexture: jest.fn(() => ({
    destroy: jest.fn(() => mockCalls.push("texture.destroy")),
  })),
  beginAccess: jest.fn(() => mockCalls.push("beginAccess")),
  endAccess: jest.fn(() => {
    mockCalls.push("endAccess");
    return { initialized: true, fences: [] };
  }),
});

const prepare = (
  drawFrame: jest.Mock = jest.fn(() => {
    mockCalls.push("draw");
  }),
) => {
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
  const extractor = {
    start: jest.fn(),
    decodeCompositionFrames: jest.fn(() => ({})),
    dispose: jest.fn(),
  };
  createVideoEncoder.mockReturnValueOnce(encoder);
  createExtractor.mockReturnValueOnce(extractor);
  const promise = exportVideoComposition({
    videoComposition: { duration: 1, items: [] },
    outPath: "/tmp/out.mp4",
    width: 640,
    height: 360,
    frameRate: 3,
    bitRate: 1_000_000,
    drawFrame,
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
  mockImport.mockReset().mockImplementation(() => sharedMemory());
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("iOS GPU export", () => {
  it("draws into lent encoder buffers and encodes them without readback", async () => {
    const { encoder, promise } = prepare();
    await pumpAll();
    await promise;
    expect(makeOffscreen).not.toHaveBeenCalled();
    expect(reserveMemory).not.toHaveBeenCalled();
    // The probe returns its buffer; every frame then encodes its own.
    expect(encoder.acquireFrameBuffer).toHaveBeenCalledTimes(4);
    expect(encoder.releaseFrameBuffer).toHaveBeenCalledTimes(1);
    expect(encoder.encodeFrame.mock.calls).toEqual([
      [{ kind: "native-buffer", nativeBuffer: 2n }, 0],
      [{ kind: "native-buffer", nativeBuffer: 3n }, 1 / 3],
      [{ kind: "native-buffer", nativeBuffer: 4n }, 2 / 3],
    ]);
    expect(mockImport).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 1002n }),
    );
    const frame = [
      "beginAccess",
      "draw",
      "target.flush",
      "target.canvas.dispose",
      "target.dispose",
      "endAccess",
      "texture.destroy",
      "frame.release",
      "encode",
    ];
    const probe = [
      "beginAccess",
      "target.flush",
      "target.canvas.dispose",
      "target.dispose",
      "endAccess",
      "texture.destroy",
      "frame.release",
      "releaseFrameBuffer",
    ];
    expect(mockCalls).toEqual([...probe, ...frame, ...frame, ...frame]);
    for (const result of makeFromTexture.mock.results)
      expect(result.value.canvas.readPixels).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("falls back to CPU readback when the device cannot import the buffer", async () => {
    mockImport.mockImplementation(() => {
      throw new Error("no IOSurface interop");
    });
    const { encoder, promise } = prepare();
    await pumpAll();
    await promise;
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(encoder.releaseFrameBuffer).toHaveBeenCalledTimes(1);
    expect(encoder.acquireFrameBuffer).toHaveBeenCalledTimes(1);
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
    expect(encoder.encodeFrame).toHaveBeenCalledTimes(3);
    for (const [pixels] of encoder.encodeFrame.mock.calls)
      expect(pixels).toMatchObject({ kind: "bgra", width: 640, height: 360 });
  });

  it("ends GPU access and returns nothing to encode when drawing fails", async () => {
    let calls = 0;
    const drawFrame = jest.fn(() => {
      if (++calls === 2) throw new Error("draw failed");
    });
    const { encoder, promise } = prepare(drawFrame);
    await pumpAll();
    await expect(promise).rejects.toThrow("draw failed");
    expect(encoder.encodeFrame).toHaveBeenCalledTimes(1);
    const memories = mockImport.mock.results.map((r) => r.value);
    expect(memories).toHaveLength(3);
    for (const memory of memories) {
      expect(memory.endAccess).toHaveBeenCalledTimes(1);
      const texture = memory.createTexture.mock.results[0].value;
      expect(texture.destroy).toHaveBeenCalledTimes(1);
    }
    const failed = makeFromTexture.mock.results[2]!.value;
    expect(failed.flush).toHaveBeenCalledWith(true);
    expect(failed.dispose).toHaveBeenCalledTimes(1);
    expect(encoder.dispose).toHaveBeenCalledTimes(1);
  });
});

import { Skia } from "react-native-skia";
import RNSkiaVideoModule from "../RNSkiaVideoModule";
import {
  imageFromVideoFrame,
  releaseVideoFrameImage,
  clearVideoFrameImages,
  ownVideoFrames,
} from "../frameInterop";
import type { VideoFrame } from "../types";

const mockCanvas = {
  drawColor: jest.fn(),
  drawImage: jest.fn(),
  dispose: jest.fn(),
};
const mockSurface = {
  enableCheckedSubmissions: jest.fn(),
  getCanvas: jest.fn(() => mockCanvas),
  makeImageSnapshot: jest.fn(() => ({ dispose: jest.fn() })),
  flush: jest.fn(),
  dispose: jest.fn(),
};
const mockUploadTexture = { nativePointer: 456n, destroy: jest.fn() };
const mockNativeSource = {
  width: 4,
  height: 2,
  pixelFormat: "bgra8",
  release: jest.fn(),
};
const mockCopy = jest.fn();
const mockWriteTexture = jest.fn();
const mockCreateTexture = jest.fn(
  (_descriptor: GPUTextureDescriptor) => mockUploadTexture,
);
const mockWrapNative = jest.fn((_pointer: bigint) => mockNativeSource);
jest.mock("../gpuDevice", () => ({
  getVideoGpuDevice: () => ({
    createTexture: mockCreateTexture,
    limits: { maxTextureDimension2D: 4096 },
    queue: {
      copyExternalImageToTexture: mockCopy,
      writeTexture: mockWriteTexture,
    },
  }),
  createNativeVideoGpuFrame: (pointer: bigint) => mockWrapNative(pointer),
  nativeVideoTextureUsage: 21,
  rgbaVideoTextureUsage: 23,
}));
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("react-native-skia", () => ({
  Skia: {
    Surface: {
      MakeOffscreen: jest.fn(),
      MakeFromGPUTexture: jest.fn(() => ({ ...mockSurface })),
    },
    Color: jest.fn(() => 0),
    Data: { fromBytes: jest.fn(() => ({ dispose: jest.fn() })) },
    Image: {
      MakeImage: jest.fn(() => ({ dispose: jest.fn() })),
      MakeImageFromGPUTexture: jest.fn(),
    },
  },
  BlendMode: { Clear: 0 },
  ColorType: { RGBA_8888: 4 },
  AlphaType: { Opaque: 0 },
}));
jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: {
    frameProtocolVersion: 1,
    reserveMemory: jest.fn(() => 17),
    releaseMemory: jest.fn(),
  },
}));

const reserve = RNSkiaVideoModule.reserveMemory as jest.Mock;
const release = RNSkiaVideoModule.releaseMemory as jest.Mock;
const makeImage = Skia.Image.MakeImage as jest.Mock;
const rgbaFrame = (id = 1, producerId = 1): VideoFrame => ({
  id,
  producerId,
  width: 4,
  height: 2,
  rotation: 0,
  texture: { kind: "rgba", data: new ArrayBuffer(32), bytesPerRow: 16 },
  dispose: jest.fn(),
});

beforeEach(() => {
  clearVideoFrameImages(true);
  jest.clearAllMocks();
  reserve.mockImplementation(() => 17);
});
afterEach(() => clearVideoFrameImages(true));

const withAndroidInterop = (
  check: (context: {
    interop: typeof import("../frameInterop");
    skia: typeof Skia;
    reserve: jest.Mock;
    release: jest.Mock;
  }) => void,
) => {
  jest.isolateModules(() => {
    const rn = require("react-native") as { Platform: { OS: string } };
    rn.Platform.OS = "android";
    const interop =
      require("../frameInterop") as typeof import("../frameInterop");
    const skia = (require("react-native-skia") as { Skia: typeof Skia }).Skia;
    const native = (
      require("../RNSkiaVideoModule") as { default: typeof RNSkiaVideoModule }
    ).default;
    try {
      check({
        interop,
        skia,
        reserve: native.reserveMemory as jest.Mock,
        release: native.releaseMemory as jest.Mock,
      });
    } finally {
      interop.clearVideoFrameImages(true);
    }
  });
};

describe("Android RGBA Graphite upload", () => {
  it("uploads into a bounded RGBA texture without creating a raster image and fences before closing pixels", () => {
    withAndroidInterop(
      ({ interop, skia, reserve: androidReserve, release: androidRelease }) => {
        const frame = rgbaFrame();
        const image = interop.imageFromVideoFrame(frame)!;
        expect(mockCreateTexture).toHaveBeenCalledWith({
          size: { width: 4, height: 2 },
          format: "rgba8unorm",
          usage: 23,
          label: "video RGBA frame upload",
        });
        expect(mockWriteTexture).toHaveBeenCalledWith(
          { texture: mockUploadTexture },
          expect.any(Uint8Array),
          { offset: 0, bytesPerRow: 16, rowsPerImage: 2 },
          { width: 4, height: 2, depthOrArrayLayers: 1 },
        );
        expect(skia.Data.fromBytes).not.toHaveBeenCalled();
        expect(skia.Image.MakeImage).not.toHaveBeenCalled();
        expect(mockCopy).not.toHaveBeenCalled();
        expect(mockWrapNative).not.toHaveBeenCalled();
        expect(mockSurface.enableCheckedSubmissions).toHaveBeenCalledTimes(1);
        const write = mockWriteTexture.mock.invocationCallOrder[0]!;
        const snapshot =
          mockSurface.makeImageSnapshot.mock.invocationCallOrder[0]!;
        const fence = mockSurface.flush.mock.invocationCallOrder[0]!;
        expect(androidReserve.mock.invocationCallOrder[1]!).toBeLessThan(
          mockCreateTexture.mock.invocationCallOrder[0]!,
        );
        expect(write).toBeLessThan(snapshot);
        expect(snapshot).toBeLessThan(fence);
        expect(fence).toBeLessThan(
          (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
        );
        expect(
          androidReserve.mock.calls.map((call) => call.slice(0, 2)),
        ).toEqual([
          [32, "owned video image"],
          [32, "RGBA frame WebGPU upload texture"],
        ]);
        interop.releaseVideoFrameImage(frame);
        expect(image.dispose).toHaveBeenCalledTimes(1);
        expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
        expect(androidRelease).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("uploads odd widths and padded rows through a bounded zero-offset view, excluding trailing storage", () => {
    withAndroidInterop(({ interop, reserve: androidReserve }) => {
      const storage = new ArrayBuffer(80);
      const pixels = new Uint8Array(storage);
      pixels.set([1, 2, 3, 255]);
      pixels.set([4, 5, 6, 255], 16);
      const frame = {
        ...rgbaFrame(),
        width: 3,
        texture: { kind: "rgba", data: storage, bytesPerRow: 16 },
      };
      interop.imageFromVideoFrame(frame);
      const view = mockWriteTexture.mock.calls[0]![1] as Uint8Array;
      expect(view.buffer).toBe(storage);
      expect(view.byteOffset).toBe(0);
      expect(view.byteLength).toBe(32);
      expect(Array.from(view.slice(0, 4))).toEqual([1, 2, 3, 255]);
      expect(Array.from(view.slice(16, 20))).toEqual([4, 5, 6, 255]);
      expect(mockWriteTexture.mock.calls[0]![2]).toEqual({
        offset: 0,
        bytesPerRow: 16,
        rowsPerImage: 2,
      });
      expect(androidReserve.mock.calls.map((call) => call[0])).toEqual([
        24, 24,
      ]);
    });
  });

  it("rejects misaligned, oversized or truncated layouts and unsupported extents before allocation", () => {
    withAndroidInterop(({ interop, reserve: androidReserve }) => {
      for (const bytesPerRow of [18, 16.5, NaN, Infinity, 0x100000000]) {
        const frame = {
          ...rgbaFrame(),
          texture: { kind: "rgba", data: new ArrayBuffer(48), bytesPerRow },
        };
        expect(() => interop.imageFromVideoFrame(frame)).toThrow(
          "Invalid RGBA",
        );
        expect(frame.dispose).toHaveBeenCalledTimes(1);
      }
      const short = {
        ...rgbaFrame(),
        texture: { kind: "rgba", data: new ArrayBuffer(31), bytesPerRow: 16 },
      };
      expect(() => interop.imageFromVideoFrame(short)).toThrow("Invalid RGBA");
      const tooWide = {
        ...rgbaFrame(),
        width: 4097,
        height: 1,
        texture: {
          kind: "rgba",
          data: new ArrayBuffer(4097 * 4),
          bytesPerRow: 4097 * 4,
        },
      };
      expect(() => interop.imageFromVideoFrame(tooWide)).toThrow(
        "texture extent limit",
      );
      expect(tooWide.dispose).toHaveBeenCalledTimes(1);
      expect(androidReserve).not.toHaveBeenCalled();
      expect(mockCreateTexture).not.toHaveBeenCalled();
      expect(mockWriteTexture).not.toHaveBeenCalled();
    });
  });

  it("reuses scratch storage but wraps a fresh surface so later writes cannot return an old snapshot", () => {
    withAndroidInterop(({ interop }) => {
      let version = 0;
      const views: Array<{
        snapshot: { version: number; dispose: jest.Mock } | null;
        dispose: jest.Mock;
      }> = [];
      const wrap = () => {
        const view = {
          snapshot: null as (typeof views)[number]["snapshot"],
          dispose: jest.fn(),
        };
        views.push(view);
        return {
          ...mockSurface,
          dispose: view.dispose,
          makeImageSnapshot: () => {
            view.snapshot ??= { version, dispose: jest.fn() };
            return view.snapshot;
          },
        };
      };
      const localSkia = (require("react-native-skia") as { Skia: typeof Skia })
        .Skia;
      (localSkia.Surface.MakeFromGPUTexture as jest.Mock)
        .mockImplementationOnce(wrap)
        .mockImplementationOnce(wrap);
      mockWriteTexture
        .mockImplementationOnce(() => {
          version = 1;
        })
        .mockImplementationOnce(() => {
          version = 2;
        });
      const firstFrame = rgbaFrame(1, 1);
      const secondFrame = rgbaFrame(2, 2);
      const first = interop.imageFromVideoFrame(firstFrame)!;
      const second = interop.imageFromVideoFrame(secondFrame)!;
      expect(first).toMatchObject({ version: 1 });
      expect(second).toMatchObject({ version: 2 });
      expect(first).not.toBe(second);
      expect(interop.imageFromVideoFrame(firstFrame)).toBe(first);
      expect(first.dispose).not.toHaveBeenCalled();
      expect(mockWriteTexture).toHaveBeenCalledTimes(2);
      expect(mockCreateTexture).toHaveBeenCalledTimes(1);
      expect(views.every((view) => view.dispose.mock.calls.length === 1)).toBe(
        true,
      );
    });
  });

  it("reallocates scratch on a format change without invalidating another producer's owned image", () => {
    withAndroidInterop(({ interop }) => {
      const rgbaTexture = { nativePointer: 456n, destroy: jest.fn() };
      const bgraTexture = { nativePointer: 789n, destroy: jest.fn() };
      mockCreateTexture
        .mockReturnValueOnce(rgbaTexture)
        .mockReturnValueOnce(bgraTexture);
      const rgba = interop.imageFromVideoFrame(rgbaFrame(1, 1))!;
      const native: VideoFrame = {
        ...rgbaFrame(2, 2),
        texture: { kind: "native-buffer", nativeBuffer: 123n },
      };
      interop.imageFromVideoFrame(native);
      expect(
        mockCreateTexture.mock.calls.map((call) => call[0].format),
      ).toEqual(["rgba8unorm", "bgra8unorm"]);
      expect(mockCreateTexture.mock.calls.map((call) => call[0].usage)).toEqual(
        [23, 21],
      );
      expect(rgbaTexture.destroy).toHaveBeenCalledTimes(1);
      expect(rgba.dispose).not.toHaveBeenCalled();
      expect(mockCopy.mock.calls[0]![1].texture).toBe(bgraTexture);
    });
  });

  it("retains the RGBA source and both reservations when a write throws after enqueue and its drain fails", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      const failure = new Error("Write failed after enqueue");
      mockWriteTexture.mockImplementationOnce(() => {
        throw failure;
      });
      mockSurface.flush.mockImplementationOnce(() => {
        throw new Error("Drain failed");
      });
      const pending = rgbaFrame();
      expect(() => interop.ownVideoFrames({ pending })).toThrow(failure);
      expect(pending.dispose).not.toHaveBeenCalled();
      expect(mockSurface.dispose).not.toHaveBeenCalled();
      expect(mockUploadTexture.destroy).not.toHaveBeenCalled();
      expect(androidRelease).not.toHaveBeenCalled();
      expect(() => interop.imageFromVideoFrame(pending)).toThrow(
        "could not drain",
      );
      expect(pending.dispose).not.toHaveBeenCalled();
      const incoming = rgbaFrame(2, 2);
      expect(() => interop.imageFromVideoFrame(incoming)).toThrow(
        "could not drain",
      );
      expect(incoming.dispose).toHaveBeenCalledTimes(1);
      interop.clearVideoFrameImages(true);
      const fence = mockSurface.flush.mock.invocationCallOrder[1]!;
      expect(fence).toBeLessThan(
        (pending.dispose as jest.Mock).mock.invocationCallOrder[0]!,
      );
      expect(pending.dispose).toHaveBeenCalledTimes(1);
      expect(androidRelease).toHaveBeenCalledTimes(2);
      expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the previous producer image if replacement snapshot allocation fails", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      const previousFrame = rgbaFrame(1, 1);
      const previous = interop.imageFromVideoFrame(previousFrame)!;
      mockSurface.makeImageSnapshot.mockReturnValueOnce(null as never);
      const replacement = rgbaFrame(2, 1);
      expect(() => interop.imageFromVideoFrame(replacement)).toThrow(
        "Cannot create a video frame image",
      );
      expect(replacement.dispose).toHaveBeenCalledTimes(1);
      expect(previous.dispose).not.toHaveBeenCalled();
      expect(interop.imageFromVideoFrame(previousFrame)).toBe(previous);
      expect(androidRelease).toHaveBeenCalledTimes(1);
    });
  });

  it("releases a reserved image if the scratch allocation is refused before any write", () => {
    withAndroidInterop(
      ({ interop, reserve: androidReserve, release: androidRelease }) => {
        androidReserve.mockReturnValueOnce(17).mockImplementationOnce(() => {
          throw new Error("Scratch budget exceeded");
        });
        const frame = rgbaFrame();
        expect(() => interop.imageFromVideoFrame(frame)).toThrow(
          "Scratch budget exceeded",
        );
        expect(frame.dispose).toHaveBeenCalledTimes(1);
        expect(androidRelease).toHaveBeenCalledTimes(1);
        expect(mockWriteTexture).not.toHaveBeenCalled();
        expect(mockCreateTexture).not.toHaveBeenCalled();
      },
    );
  });
});

describe("owned video frame transport", () => {
  it("caches immutable pixels after releasing the native source exactly once", () => {
    const frame = rgbaFrame();
    const image = imageFromVideoFrame(frame)!;
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(32, "owned video image");
    frame.texture = undefined;
    expect(imageFromVideoFrame(frame)).toBe(image);
    expect(makeImage).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    releaseVideoFrameImage(frame);
    expect(image.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(17);
  });

  it("replaces one producer image and preserves another paused producer", () => {
    const first = imageFromVideoFrame(rgbaFrame(1, 1))!;
    const pausedFrame = rgbaFrame(2, 2);
    const paused = imageFromVideoFrame(pausedFrame)!;
    imageFromVideoFrame(rgbaFrame(3, 1));
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(paused.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(pausedFrame)).toBe(paused);
  });

  it("waits for native-buffer snapshot rendering before releasing its borrowed pixels", () => {
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    const image = imageFromVideoFrame(frame);
    expect(image).not.toBeNull();
    expect(mockWrapNative).toHaveBeenCalledWith(123n);
    expect(mockCopy).toHaveBeenCalledWith(
      { source: mockNativeSource, rotation: 0, mirrored: false, flipY: false },
      { texture: mockUploadTexture, premultipliedAlpha: false },
      { width: 4, height: 2 },
    );
    expect(Skia.Surface.MakeFromGPUTexture).toHaveBeenCalledWith(
      mockUploadTexture,
    );
    expect(Skia.Surface.MakeOffscreen).not.toHaveBeenCalled();
    expect(mockCanvas.drawImage).not.toHaveBeenCalled();
    expect(mockCanvas.drawColor).not.toHaveBeenCalled();
    expect(mockSurface.flush).toHaveBeenCalledWith(true);
    const flushOrder = mockSurface.flush.mock.invocationCallOrder[0]!;
    expect(mockCopy.mock.invocationCallOrder[0]!).toBeLessThan(flushOrder);
    expect(flushOrder).toBeLessThan(
      mockNativeSource.release.mock.invocationCallOrder[0]!,
    );
    expect(flushOrder).toBeLessThan(
      mockSurface.dispose.mock.invocationCallOrder[0]!,
    );
    expect(flushOrder).toBeLessThan(
      (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
    );
    releaseVideoFrameImage(frame);
    expect(mockCanvas.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects short RGBA storage before reserving memory and releases its native lease", () => {
    const frame = {
      ...rgbaFrame(),
      texture: { kind: "rgba", data: new ArrayBuffer(8), bytesPerRow: 16 },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Invalid RGBA");
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(makeImage).not.toHaveBeenCalled();
  });

  it("bounds cached producer images and fails without evicting a paused image", () => {
    const firstFrame = rgbaFrame(1, 1);
    const first = imageFromVideoFrame(firstFrame)!;
    for (let i = 2; i <= 32; i++) imageFromVideoFrame(rgbaFrame(i, i));
    const overflow = rgbaFrame(33, 33);
    expect(() => imageFromVideoFrame(overflow)).toThrow("Too many cached");
    expect(overflow.dispose).toHaveBeenCalledTimes(1);
    expect(imageFromVideoFrame(firstFrame)).toBe(first);
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it("releases a native lease when its image reservation exceeds the memory budget", () => {
    reserve.mockImplementationOnce(() => {
      throw new Error("Memory budget exceeded");
    });
    const frame = rgbaFrame();
    expect(() => imageFromVideoFrame(frame)).toThrow("Memory budget exceeded");
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it("releases an owned-image reservation if the upload texture exceeds the budget", () => {
    reserve
      .mockImplementationOnce(() => 17)
      .mockImplementationOnce(() => {
        throw new Error("Upload budget exceeded");
      });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Upload budget exceeded");
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(Skia.Surface.MakeFromGPUTexture).not.toHaveBeenCalled();
  });

  it("releases failed image creation storage, reservation, and native lease", () => {
    makeImage.mockReturnValueOnce(null);
    const frame = rgbaFrame();
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "Cannot create a video frame image",
    );
    expect(Skia.Data.fromBytes).toHaveBeenCalledTimes(1);
    expect(
      (Skia.Data.fromBytes as jest.Mock).mock.results[0]?.value.dispose,
    ).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cleans already imported images and untouched native leases after a partial composition import fails", () => {
    const first = rgbaFrame(1, 1);
    const invalid = {
      ...rgbaFrame(2, 2),
      texture: { kind: "rgba", data: new ArrayBuffer(8), bytesPerRow: 16 },
    };
    const untouched = rgbaFrame(3, 3);
    expect(() => ownVideoFrames({ first, invalid, untouched })).toThrow(
      "Invalid RGBA",
    );
    const firstImage = makeImage.mock.results[0]?.value;
    expect(firstImage.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalled();
    expect(invalid.dispose).toHaveBeenCalled();
    expect(untouched.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps published paused pixels when replacement reservation or image creation fails", () => {
    const previousFrame = rgbaFrame(1, 1);
    const previous = imageFromVideoFrame(previousFrame)!;
    reserve.mockImplementationOnce(() => {
      throw new Error("Replacement budget exceeded");
    });
    const replacement = rgbaFrame(2, 1);
    expect(() => imageFromVideoFrame(replacement)).toThrow(
      "Replacement budget exceeded",
    );
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(previousFrame)).toBe(previous);
    makeImage.mockReturnValueOnce(null);
    expect(() => imageFromVideoFrame(rgbaFrame(3, 1))).toThrow(
      "Cannot create a video frame image",
    );
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(previousFrame)).toBe(previous);
  });

  it("releases malformed and missing frame transport leases even before allocating an image", () => {
    const unsupported = { ...rgbaFrame(), texture: { kind: "legacy-gl" } };
    expect(() => imageFromVideoFrame(unsupported)).toThrow(
      "Unsupported frame transport",
    );
    expect(unsupported.dispose).toHaveBeenCalledTimes(1);
    const missing = { ...rgbaFrame(), texture: undefined };
    expect(imageFromVideoFrame(missing)).toBeNull();
    expect(missing.dispose).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("cleans a partially created staging surface if its canvas cannot be created", () => {
    mockSurface.getCanvas.mockImplementationOnce(() => {
      throw new Error("Canvas creation failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Canvas creation failed");
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("drains a recording left by snapshot failure before releasing borrowed decoder pixels", () => {
    mockSurface.makeImageSnapshot.mockImplementationOnce(() => {
      throw new Error("Snapshot failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Snapshot failed");
    expect(mockSurface.flush).toHaveBeenCalledWith(true);
    expect(mockSurface.flush.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSurface.dispose.mock.invocationCallOrder[0]!,
    );
    expect(mockSurface.flush.mock.invocationCallOrder[0]!).toBeLessThan(
      (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains native leases after failed GPU fences, rejects new imports, and releases only after successful retry", () => {
    mockSurface.flush
      .mockImplementationOnce(() => {
        throw new Error("GPU fence failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("GPU retry failed");
      });
    const pending: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => ownVideoFrames({ pending })).toThrow("GPU fence failed");
    const snapshot = mockSurface.makeImageSnapshot.mock.results[0]?.value;
    expect(pending.dispose).not.toHaveBeenCalled();
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(mockSurface.dispose).not.toHaveBeenCalled();
    expect(snapshot.dispose).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    const incoming = rgbaFrame(2, 2);
    expect(() => imageFromVideoFrame(incoming)).toThrow("could not drain");
    expect(incoming.dispose).toHaveBeenCalledTimes(1);
    expect(pending.dispose).not.toHaveBeenCalled();
    // Rejecting another import must not close the view used by pending work.
    expect(mockSurface.dispose).not.toHaveBeenCalled();
    expect(mockCanvas.dispose).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(pending.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(snapshot.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
    const successfulFence = mockSurface.flush.mock.invocationCallOrder[2]!;
    expect(successfulFence).toBeLessThan(
      (pending.dispose as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(pending.dispose).toHaveBeenCalledTimes(1);
  });

  it("accounts the entire RGBA storage copied by Skia, including padding and trailing bytes", () => {
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "rgba", data: new ArrayBuffer(128), bytesPerRow: 32 },
    };
    imageFromVideoFrame(frame);
    expect(reserve).toHaveBeenCalledWith(128, "owned video image");
    const copied = (Skia.Data.fromBytes as jest.Mock).mock
      .calls[0]?.[0] as Uint8Array;
    expect(copied.byteLength).toBe(128);
    expect(copied.byteOffset).toBe(0);
    expect(copied.buffer.byteLength).toBe(128);
  });

  it("rejects non-finite, fractional and unsafe row strides before reserving or invoking Skia", () => {
    for (const bytesPerRow of [NaN, Infinity, 16.5, Number.MAX_SAFE_INTEGER]) {
      const frame: VideoFrame = {
        ...rgbaFrame(),
        texture: { kind: "rgba", data: new ArrayBuffer(32), bytesPerRow },
      };
      expect(() => imageFromVideoFrame(frame)).toThrow("Invalid RGBA");
      expect(frame.dispose).toHaveBeenCalledTimes(1);
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(Skia.Data.fromBytes).not.toHaveBeenCalled();
  });

  it("retains only unfinished staging cleanup after allocation teardown throws", () => {
    mockSurface.getCanvas.mockImplementationOnce(() => {
      throw new Error("Canvas creation failed");
    });
    mockSurface.dispose.mockImplementationOnce(() => {
      throw new Error("Stage destruction failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Canvas creation failed");
    // Cleanup is retained intact when the surface view cannot be closed.
    expect(frame.dispose).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not dispose an image twice when releasing its reservation needs a retry", () => {
    const frame = rgbaFrame();
    const image = imageFromVideoFrame(frame)!;
    release.mockImplementationOnce(() => {
      throw new Error("Reservation release failed");
    });
    expect(() => releaseVideoFrameImage(frame)).toThrow(
      "Reservation release failed",
    );
    expect(image.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(image.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("preserves the published image when replacement native close fails before the handoff completes", () => {
    const first = rgbaFrame(1, 5);
    const previous = imageFromVideoFrame(first)!;
    const replacement = rgbaFrame(2, 5);
    const failure = new Error("Replacement native close failed");
    (replacement.dispose as jest.Mock).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => imageFromVideoFrame(replacement)).toThrow(failure);
    const rejectedImage = (Skia.Image.MakeImage as jest.Mock).mock.results[1]
      ?.value;
    expect(rejectedImage.dispose).toHaveBeenCalledTimes(1);
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(first)).toBe(previous);
    expect(release).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(previous.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("attempts every untouched native close and preserves the primary import failure", () => {
    const invalid: VideoFrame = {
      ...rgbaFrame(1, 1),
      texture: { kind: "rgba", data: new ArrayBuffer(8), bytesPerRow: 16 },
    };
    const failedClose = rgbaFrame(2, 2);
    (failedClose.dispose as jest.Mock).mockImplementationOnce(() => {
      throw new Error("Native close failed");
    });
    const untouched = rgbaFrame(3, 3);
    expect(() => ownVideoFrames({ invalid, failedClose, untouched })).toThrow(
      "Invalid RGBA",
    );
    expect(untouched.dispose).toHaveBeenCalledTimes(1);
    expect(failedClose.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(failedClose.dispose).toHaveBeenCalledTimes(2);
  });

  it("provides a releasable cache identity for a single anonymous raw frame", () => {
    const frame = { ...rgbaFrame(), id: undefined, producerId: undefined };
    const owned = ownVideoFrames({ clip: frame }).clip!;
    const image = (owned.texture as { image: { dispose: jest.Mock } }).image;
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    releaseVideoFrameImage(owned);
    expect(image.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting pictures of one producer before either can invalidate the other", () => {
    const first = rgbaFrame(1, 1);
    const conflict = rgbaFrame(2, 1);
    expect(() => ownVideoFrames({ first, conflict })).toThrow(
      "different frames for one producer",
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(conflict.dispose).toHaveBeenCalledTimes(1);
    const alias = rgbaFrame(3, 3);
    const owned = ownVideoFrames({ first: alias, second: alias });
    expect((owned.first!.texture as { image: unknown }).image).toBe(
      (owned.second!.texture as { image: unknown }).image,
    );
    expect(alias.dispose).toHaveBeenCalledTimes(1);
  });

  it("reuses one bounded GPU upload target and preserves the previous immutable snapshot", () => {
    const nativeFrame = (id: number): VideoFrame => ({
      ...rgbaFrame(id),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    });
    const first = imageFromVideoFrame(nativeFrame(1))!;
    imageFromVideoFrame(nativeFrame(2));
    expect(mockCreateTexture).toHaveBeenCalledTimes(1);
    expect(mockCreateTexture).toHaveBeenCalledWith({
      size: { width: 4, height: 2 },
      format: "bgra8unorm",
      usage: 21,
      label: "video native frame upload",
    });
    expect(
      reserve.mock.calls.filter(
        (call) => call[1] === "native frame WebGPU upload texture",
      ),
    ).toEqual([[32, "native frame WebGPU upload texture"]]);
    expect(mockCopy).toHaveBeenCalledTimes(2);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(mockUploadTexture.destroy).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
  });

  it("releases the extra wrapper and original lease if a native copy throws after submission", () => {
    const failure = new Error("Native blit failed");
    mockCopy.mockImplementationOnce(() => {
      throw failure;
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(failure);
    expect(mockSurface.flush).toHaveBeenCalledWith(true);
    const fence = mockSurface.flush.mock.invocationCallOrder[0]!;
    expect(fence).toBeLessThan(
      mockNativeSource.release.mock.invocationCallOrder[0]!,
    );
    expect(fence).toBeLessThan(
      (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect(mockNativeSource.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains both native leases if a failed copy also cannot drain", () => {
    mockCopy.mockImplementationOnce(() => {
      throw new Error("Native blit failed");
    });
    mockSurface.flush.mockImplementationOnce(() => {
      throw new Error("Drain failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Native blit failed");
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(frame.dispose).not.toHaveBeenCalled();
    expect(mockUploadTexture.destroy).not.toHaveBeenCalled();
    expect(() => imageFromVideoFrame(rgbaFrame(2))).toThrow("could not drain");
    clearVideoFrameImages(true);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched native frame before submitting any copy and closes its wrapper", () => {
    const mismatch = { ...mockNativeSource, width: 8, release: jest.fn() };
    mockWrapNative.mockReturnValueOnce(mismatch);
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "dimensions or BGRA layout mismatch",
    );
    expect(mockCopy).not.toHaveBeenCalled();
    expect(mismatch.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains an unsuccessfully closed native wrapper without re-disposing its Skia image", () => {
    const failure = new Error("Native wrapper release failed");
    mockNativeSource.release
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockImplementationOnce(() => {
        throw failure;
      });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(failure);
    expect(frame.dispose).not.toHaveBeenCalled();
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(3);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
  });

  it("cleans staging allocations and the original lease if the upload texture allocation fails", () => {
    mockCreateTexture.mockImplementationOnce(() => {
      throw new Error("Texture allocation failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "Texture allocation failed",
    );
    expect(mockWrapNative).not.toHaveBeenCalled();
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).not.toHaveBeenCalled();
    expect(mockCanvas.dispose).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("retries only unfinished scratch texture teardown when destroy fails", () => {
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    imageFromVideoFrame(frame);
    mockUploadTexture.destroy.mockImplementationOnce(() => {
      throw new Error("Texture destroy failed");
    });
    expect(() => clearVideoFrameImages(true)).toThrow("Texture destroy failed");
    expect(release).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
  });

  it("submits a Skia marker before the failure fence if native copying throws before any draw", () => {
    mockCopy.mockImplementationOnce(() => {
      throw new Error("Copy failed before drawing");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "Copy failed before drawing",
    );
    expect(mockCanvas.drawImage).not.toHaveBeenCalled();
    expect(mockCanvas.drawColor).toHaveBeenCalledTimes(1);
    const marker = mockCanvas.drawColor.mock.invocationCallOrder[0]!;
    const fence = mockSurface.flush.mock.invocationCallOrder[0]!;
    expect(mockCopy.mock.invocationCallOrder[0]!).toBeLessThan(marker);
    expect(marker).toBeLessThan(fence);
    expect(fence).toBeLessThan(
      mockNativeSource.release.mock.invocationCallOrder[0]!,
    );
  });

  it("retains native leases if both the snapshot and the explicit drain marker fail", () => {
    const failure = new Error("Snapshot failed");
    mockSurface.makeImageSnapshot.mockImplementationOnce(() => {
      throw failure;
    });
    mockCanvas.drawColor.mockImplementationOnce(() => {
      throw new Error("Drain marker failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(failure);
    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(mockSurface.flush).not.toHaveBeenCalled();
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(frame.dispose).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not close either lease when the same pending native frame is imported again", () => {
    mockSurface.flush
      .mockImplementationOnce(() => {
        throw new Error("GPU fence failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("GPU retry failed");
      });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("GPU fence failed");
    expect(() => imageFromVideoFrame(frame)).toThrow("could not drain");
    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(frame.dispose).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("uses fresh surface views so external writes cannot reuse a cached snapshot", () => {
    let pixels = 0;
    const views: Array<{
      snapshot: { pixelVersion: number; dispose: jest.Mock } | null;
      dispose: jest.Mock;
    }> = [];
    const wrap = () => {
      const view = {
        snapshot: null as (typeof views)[number]["snapshot"],
        dispose: jest.fn(),
      };
      views.push(view);
      return {
        ...mockSurface,
        dispose: view.dispose,
        // Model SkSurface::refCachedImage: external writes alone do not
        // invalidate this surface's snapshot, even if its texture changed.
        makeImageSnapshot: () => {
          view.snapshot ??= { pixelVersion: pixels, dispose: jest.fn() };
          return view.snapshot;
        },
      };
    };
    (Skia.Surface.MakeFromGPUTexture as jest.Mock)
      .mockImplementationOnce(wrap)
      .mockImplementationOnce(wrap);
    mockCopy
      .mockImplementationOnce(() => {
        pixels = 11;
      })
      .mockImplementationOnce(() => {
        pixels = 22;
      });
    const firstFrame: VideoFrame = {
      ...rgbaFrame(1, 1),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    const secondFrame: VideoFrame = {
      ...rgbaFrame(2, 2),
      texture: { kind: "native-buffer", nativeBuffer: 124n },
    };
    const first = imageFromVideoFrame(firstFrame);
    const second = imageFromVideoFrame(secondFrame);
    expect(views).toHaveLength(2);
    expect(first).toMatchObject({ pixelVersion: 11 });
    expect(second).toMatchObject({ pixelVersion: 22 });
    expect(first).not.toBe(second);
    expect(imageFromVideoFrame(firstFrame)).toBe(first);
    expect(first!.dispose).not.toHaveBeenCalled();
    expect(mockCreateTexture).toHaveBeenCalledTimes(1);
    expect(Skia.Surface.MakeOffscreen).not.toHaveBeenCalled();
    expect(mockCanvas.drawColor).not.toHaveBeenCalled();
    expect(mockCanvas.drawImage).not.toHaveBeenCalled();
    expect(views.every((view) => view.dispose.mock.calls.length === 1)).toBe(
      true,
    );
    expect(reserve.mock.calls.map((call) => call[1])).toEqual([
      "owned video image",
      "native frame WebGPU upload texture",
      "owned video image",
    ]);
    clearVideoFrameImages(true);
    expect(first!.dispose).toHaveBeenCalledTimes(1);
    expect(second!.dispose).toHaveBeenCalledTimes(1);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
  });

  it("replaces only scratch storage on resize while preserving another producer's image", () => {
    const firstFrame: VideoFrame = {
      ...rgbaFrame(1, 1),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    const first = imageFromVideoFrame(firstFrame)!;
    const largerTexture = { nativePointer: 789n, destroy: jest.fn() };
    mockCreateTexture.mockReturnValueOnce(largerTexture);
    mockWrapNative.mockReturnValueOnce({ ...mockNativeSource, width: 8 });
    const secondFrame: VideoFrame = {
      ...rgbaFrame(2, 2),
      width: 8,
      texture: { kind: "native-buffer", nativeBuffer: 124n },
    };
    imageFromVideoFrame(secondFrame);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose.mock.invocationCallOrder[0]!).toBeLessThan(
      mockUploadTexture.destroy.mock.invocationCallOrder[0]!,
    );
    expect(mockSurface.flush.mock.invocationCallOrder[0]!).toBeLessThan(
      mockUploadTexture.destroy.mock.invocationCallOrder[0]!,
    );
    expect(first.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(firstFrame)).toBe(first);
    expect(
      reserve.mock.calls.filter((call) => call[1].includes("upload")),
    ).toEqual([
      [32, "native frame WebGPU upload texture"],
      [64, "native frame WebGPU upload texture"],
    ]);
    clearVideoFrameImages(true);
    expect(largerTexture.destroy).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed surface wrap from submitting or claiming a completed GPU copy", () => {
    (Skia.Surface.MakeFromGPUTexture as jest.Mock).mockReturnValueOnce(null);
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "Cannot wrap video upload texture",
    );
    expect(mockCopy).not.toHaveBeenCalled();
    expect(mockWrapNative).not.toHaveBeenCalled();
    expect(mockSurface.flush).not.toHaveBeenCalled();
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });
});

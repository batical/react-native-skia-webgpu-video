import type { SkSurface } from "react-native-skia";
import { getVideoCanvas } from "../canvas";

const asSurface = (value: unknown) => value as SkSurface;

describe("video surface checked submission contract", () => {
  it("activates checked submissions before handing out a video canvas", () => {
    const canvas = { dispose: jest.fn() };
    const surface = {
      enableCheckedSubmissions: jest.fn(),
      getCanvas: jest.fn(() => canvas),
    };
    expect(getVideoCanvas(asSurface(surface))).toBe(canvas);
    expect(
      surface.enableCheckedSubmissions.mock.invocationCallOrder[0]!,
    ).toBeLessThan(surface.getCanvas.mock.invocationCallOrder[0]!);
  });

  it("rejects an old native binary before obtaining any canvas", () => {
    const surface = { getCanvas: jest.fn() };
    expect(() => getVideoCanvas(asSurface(surface))).toThrow(
      "Skia checked submission patch is missing from the native binary",
    );
    expect(surface.getCanvas).not.toHaveBeenCalled();
  });

  it("propagates a failed native opt-in without falling back to unchecked rendering", () => {
    const failure = new Error(
      "Checked GPU submissions require a Graphite surface",
    );
    const surface = {
      enableCheckedSubmissions: jest.fn(() => {
        throw failure;
      }),
      getCanvas: jest.fn(),
    };
    expect(() => getVideoCanvas(asSurface(surface))).toThrow(failure);
    expect(surface.getCanvas).not.toHaveBeenCalled();
  });

  it("also rejects a canvas whose native deterministic disposal method is absent", () => {
    const surface = {
      enableCheckedSubmissions: jest.fn(),
      getCanvas: jest.fn(() => ({})),
    };
    expect(() => getVideoCanvas(asSurface(surface))).toThrow(
      "Skia canvas lifecycle patch is missing from the native binary",
    );
  });
});

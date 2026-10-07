import type { SkCanvas, SkSurface } from "react-native-skia";

/** Fail early when JS was patched but the installed native binary was not rebuilt. */
export const getVideoCanvas = (surface: SkSurface): SkCanvas => {
  "worklet";
  const checked = surface as SkSurface & {
    enableCheckedSubmissions?: () => void;
  };
  if (typeof checked.enableCheckedSubmissions !== "function") {
    throw new Error(
      "Skia checked submission patch is missing from the native binary. Apply the patch and rebuild the native app.",
    );
  }
  checked.enableCheckedSubmissions();
  const canvas = surface.getCanvas();
  if (typeof canvas.dispose !== "function") {
    throw new Error(
      "Skia canvas lifecycle patch is missing from the native binary. Apply the patch and rebuild the native app.",
    );
  }
  return canvas;
};

import { Skia } from "react-native-skia";

/** Private contract, used only on this library's dedicated export runtime. */
export const assertExportRecorderCacheSupport = () => {
  "worklet";
  if (
    typeof (
      Skia as typeof Skia & {
        __rnskvTrimRecorderCache?: () => void;
      }
    ).__rnskvTrimRecorderCache !== "function"
  ) {
    throw new Error(
      "Skia export cache patch is missing from the native binary. Apply the patch and rebuild the native app.",
    );
  }
};

/** Close all export consumers first. Never call this from preview/UI cleanup:
 * that recorder can also cache resources for unrelated application views. */
export const trimExportRecorderCache = () => {
  "worklet";
  assertExportRecorderCacheSupport();
  (
    Skia as typeof Skia & { __rnskvTrimRecorderCache: () => void }
  ).__rnskvTrimRecorderCache();
};

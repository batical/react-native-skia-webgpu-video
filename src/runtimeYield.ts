/** Continues on the calling worklet runtime's own event loop, so promise and
 * native callbacks run between frames without a hop through the RN thread. */
export const yieldToRuntime = (fn: () => void): void => {
  "worklet";
  setTimeout(fn, 0);
};

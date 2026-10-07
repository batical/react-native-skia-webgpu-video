type Job = {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort: () => void;
};
const waiting: Job[] = [];
let running = false;

export const exportAbortError = (signal?: AbortSignal): unknown => {
  const reason = (signal as { reason?: unknown } | undefined)?.reason;
  if (reason !== undefined) return reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
};

const pump = () => {
  if (running) return;
  const job = waiting.shift();
  if (!job) return;
  job.signal?.removeEventListener("abort", job.onAbort);
  running = true;
  Promise.resolve()
    .then(job.run)
    .then(job.resolve, job.reject)
    .finally(() => {
      running = false;
      pump();
    });
};

/** One active export and at most three waiting jobs. A queued abort releases
 * its captured composition immediately, without allocating native resources. */
export const enqueueExport = (
  run: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(exportAbortError(signal));
      return;
    }
    if (waiting.length >= 3) {
      reject(new Error("Video export queue is full"));
      return;
    }
    const job: Job = {
      run,
      resolve,
      reject,
      signal,
      onAbort: () => {
        const index = waiting.indexOf(job);
        if (index < 0) return;
        waiting.splice(index, 1);
        signal?.removeEventListener("abort", job.onAbort);
        reject(exportAbortError(signal));
      },
    };
    signal?.addEventListener("abort", job.onAbort);
    waiting.push(job);
    pump();
  });

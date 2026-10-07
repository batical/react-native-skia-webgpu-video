/** Wait before starting workload clocks. Later lifecycle interruptions remain
 * visible in the normal per-sample operating-condition collector. */
export async function waitForBenchmarkForeground({ readOperatingConditions, now, sleep,
  timeoutMs = 30000, stableMs = 1000, pollMs = 100 }) {
  if (typeof readOperatingConditions !== 'function' || typeof now !== 'function' || typeof sleep !== 'function' ||
      !Number.isFinite(timeoutMs) || !Number.isFinite(stableMs) || !Number.isFinite(pollMs) ||
      timeoutMs <= 0 || stableMs <= 0 || pollMs <= 0 || stableMs > timeoutMs)
    throw new Error('Invalid benchmark foreground gate configuration');
  const started = now();
  let activeSince = null;
  let lastObservation = null;
  let observations = 0;
  let initialState = null;
  let cancelled = false;
  let timer;
  const timeoutError = () => new Error(`Benchmark foreground readiness timed out after ${timeoutMs} ms; keep the app active`);
  const poll = async () => {
    while (!cancelled) {
      if (now() - started >= timeoutMs) throw timeoutError();
      const conditions = await readOperatingConditions();
      if (cancelled) throw timeoutError();
      const observedAt = now();
      observations++;
      const state = conditions?.applicationState ?? 'unknown';
      initialState ??= state;
      if (observedAt - started >= timeoutMs) throw timeoutError();
      // A long collector/JS pause cannot stand in for regularly observed
      // foreground stability. Restart the window after such a gap.
      if (lastObservation !== null && observedAt - lastObservation > Math.max(250, pollMs * 2.5)) activeSince = null;
      lastObservation = observedAt;
      if (state !== 'active') activeSince = null;
      else {
        activeSince ??= observedAt;
        if (observedAt - activeSince >= stableMs) return { status: 'passed', applicationState: 'active',
          stableMs: observedAt - activeSince, waitedMs: observedAt - started,
          observations, initialState, pollMs, timeoutMs,
          source: conditions.source ?? 'Injected native operating condition collector' };
      }
      await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (now() - started))));
    }
    throw timeoutError();
  };
  try {
    // Bound the wait even if a native conditions promise never resolves.
    return await Promise.race([poll(), new Promise((_, reject) => {
      timer = setTimeout(() => { cancelled = true; reject(timeoutError()); }, timeoutMs);
    })]);
  } finally { cancelled = true; clearTimeout(timer); }
}

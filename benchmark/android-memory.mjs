import { unavailable } from './metrics.mjs';

/** Parse KiB from Android diagnostics; each source keeps its accounting meaning. */
export function parseAndroidMemory(meminfo, processStatus = '') {
  const reading = (pattern, text, source) => {
    const match = text.match(pattern);
    return match ? { value: Number(match[1].replaceAll(',', '')) * 1024, source, reason: null } : unavailable(`Field absent from ${source}; device may restrict process accounting`);
  };
  const result = {
    rssBytes: reading(/^VmRSS:\s+([\d,]+)\s+kB/m, processStatus, '/proc/PID/status VmRSS'),
    pssBytes: reading(/^\s*TOTAL\s+(?!PSS)([\d,]+)\s/m, meminfo, 'dumpsys meminfo TOTAL PSS'),
    nativeHeapBytes: reading(/^\s*Native Heap\s+([\d,]+)\s/m, meminfo, 'dumpsys meminfo Native Heap PSS'),
    gpuBytes: unavailable('dumpsys graphics mtrack is partial accounting; not total GPU allocation'),
  };
  // Modern Android often replaces the total row with an App Summary key.
  if (result.pssBytes.value == null) result.pssBytes = reading(/TOTAL PSS:\s*([\d,]+)/, meminfo, 'dumpsys meminfo TOTAL PSS');
  if (result.rssBytes.value == null) result.rssBytes = reading(/TOTAL RSS:\s*([\d,]+)/, meminfo, 'dumpsys meminfo TOTAL RSS');
  const gl = reading(/^\s*GL mtrack\s+([\d,]+)\s/m, meminfo, 'dumpsys meminfo GL mtrack PSS');
  const egl = reading(/^\s*EGL mtrack\s+([\d,]+)\s/m, meminfo, 'dumpsys meminfo EGL mtrack PSS');
  // Expose partial graphics separately; never label this total native WebGPU memory.
  result.graphicsMtrackBytes = gl.value != null || egl.value != null ? { value: (gl.value ?? 0) + (egl.value ?? 0), source: 'dumpsys meminfo GL/EGL mtrack PSS (partial graphics accounting)', reason: null } : unavailable('Graphics mtrack is unavailable');
  return result;
}

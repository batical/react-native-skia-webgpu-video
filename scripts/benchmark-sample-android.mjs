#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';
import { parseAndroidMemory } from '../benchmark/android-memory.mjs';

const [serial, packageName, outputPath, period = '1000'] = process.argv.slice(2);
const periodMs = Number(period);
const execute = promisify(execFile);
if (!serial || !packageName || !outputPath || !/^[a-zA-Z0-9_.]+$/.test(packageName) || !Number.isFinite(periodMs) || periodMs < 500) {
  console.error('Usage: node scripts/benchmark-sample-android.mjs <adb serial> <package> <samples.jsonl> [periodMs >= 500]');
  process.exitCode = 2;
} else {
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  process.on('SIGTERM', () => { stop = true; });
  const started = performance.now();
  const adb = async (...args) => (await execute('adb', ['-s', serial, ...args], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
  while (!stop) {
    const begin = performance.now();
    const requestedAtWallTime = new Date().toISOString();
    try {
      const pid = (await adb('shell', 'pidof', packageName)).trim().split(/\s+/)[0];
      if (!/^\d+$/.test(pid)) throw new Error('App process is absent');
      const [meminfo, status] = await Promise.allSettled([adb('shell', 'dumpsys', 'meminfo', pid), adb('shell', 'cat', `/proc/${pid}/status`)]);
      await appendFile(outputPath, `${JSON.stringify({ wallTime: requestedAtWallTime, requestedAtWallTime,
        completedAtWallTime: new Date().toISOString(), hostElapsedMs: begin - started,
        collectionMs: performance.now() - begin, pid,
        memory: parseAndroidMemory(meminfo.status === 'fulfilled' ? meminfo.value : '', status.status === 'fulfilled' ? status.value : '') })}\n`);
    } catch (error) { await appendFile(outputPath, `${JSON.stringify({ wallTime: requestedAtWallTime, requestedAtWallTime,
      completedAtWallTime: new Date().toISOString(), hostElapsedMs: begin - started,
      collectionMs: performance.now() - begin, error: String(error.message), memory: parseAndroidMemory('') })}\n`); }
    if (!stop) await new Promise((resolve) => setTimeout(resolve, Math.max(0, periodMs - (performance.now() - begin))));
  }
}

#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { mergeMemorySamples } from '../benchmark/merge-memory.mjs';

const [resultPath, samplesPath, outputPath, offset] = process.argv.slice(2);
if (!resultPath || !samplesPath || !outputPath || offset == null || !Number.isFinite(Number(offset))) {
  console.error('Usage: node scripts/benchmark-merge-memory.mjs result.json samples.jsonl merged.json <measured device-minus-host clockOffsetMs>');
  process.exitCode = 2;
} else {
  try {
    const [result, lines] = await Promise.all([readFile(resultPath, 'utf8'), readFile(samplesPath, 'utf8')]);
    const output = mergeMemorySamples(JSON.parse(result), lines.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)), { clockOffsetMs: Number(offset) });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}

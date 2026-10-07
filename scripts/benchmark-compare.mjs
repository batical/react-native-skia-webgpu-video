#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { compareResults } from '../benchmark/compare.mjs';

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  console.error('Usage: node scripts/benchmark-compare.mjs baseline.json candidate.json [report.json]');
  process.exitCode = 2;
} else {
  try {
    const [baseline, candidate] = await Promise.all([baselinePath, candidatePath].map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
    const report = compareResults(baseline, candidate);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) await writeFile(outputPath, json);
    else process.stdout.write(json);
    console.error(`${report.assessment}: ${report.cases.length} cases compared`);
    process.exitCode = report.assessment === 'failed' ? 1 : report.assessment === 'incomplete' ? 3 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}

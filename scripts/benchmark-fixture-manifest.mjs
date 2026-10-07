#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURES, FIXTURE_SCHEMA } from '../benchmark/fixtures.mjs';

const [directory, output] = process.argv.slice(2);
if (!directory || !output) { console.error('Usage: node scripts/benchmark-fixture-manifest.mjs <media directory> <manifest.json>'); process.exitCode = 2; }
else {
  const manifest = { schema: FIXTURE_SCHEMA, files: [], unavailable: [] };
  for (const fixture of FIXTURES) {
    const path = join(directory, fixture.file);
    try {
      const info = await stat(path);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      manifest.files.push({ ...fixture, bytes: info.size, sha256: hash.digest('hex') });
    } catch (error) { manifest.unavailable.push({ id: fixture.id, reason: error.code ?? error.message }); }
  }
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`${manifest.files.length} hashed fixtures, ${manifest.unavailable.length} unavailable; cases remain listed and explicitly skip missing media`);
}

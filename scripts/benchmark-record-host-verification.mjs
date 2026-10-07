import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dependencyFingerprint } from './benchmark-verification.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [jestPath] = process.argv.slice(2);
if (!jestPath) throw new Error('Usage: node scripts/benchmark-record-host-verification.mjs PASSED_JEST_JSON');
const jest = JSON.parse(await readFile(jestPath, 'utf8'));
if (!jest.success || jest.numFailedTests !== 0 || !jest.testResults?.length) throw new Error('The Jest JSON must record a complete successful run');
const capturedAt = (await stat(jestPath)).mtimeMs;
async function requireFreshJest(path) {
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const file = `${path}/${entry.name}`;
    if (entry.isDirectory()) await requireFreshJest(file);
    else if (/\.[jt]sx?$/.test(entry.name) && (await stat(join(root, file))).mtimeMs > capturedAt) {
      throw new Error(`JS source changed after the recorded Jest run: ${file}`);
    }
  }
}
await requireFreshJest('src');
await requireFreshJest('test/utils');
const files = {};
const passedAssertions = [];
for (const suite of jest.testResults) {
  const file = relative(root, suite.name);
  if (!file.startsWith('src/__tests__/')) throw new Error(`Jest suite is outside this checkout: ${suite.name}`);
  if ((await stat(suite.name)).mtimeMs > capturedAt) throw new Error(`Jest source changed after the recorded run: ${file}`);
  files[file] = createHash('sha256').update(await readFile(suite.name)).digest('hex');
  for (const assertion of suite.assertionResults) {
    if (assertion.status !== 'passed') throw new Error(`Jest assertion did not run successfully: ${assertion.fullName}`);
    passedAssertions.push(`${file}:${assertion.title}`);
  }
}
const before = await dependencyFingerprint(root);
const commands = [['scripts/test-native.mjs', '--pure-only', '--asan'], ['scripts/test-jvm-host.mjs']];
const evidence = [];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 180000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr}\n${result.stdout}`);
  evidence.push({ command: ['node', ...args].join(' '), stdout: result.stdout.trim() });
}
if (before !== await dependencyFingerprint(root)) throw new Error('Sources changed during native host verification; rerun on stable sources');
const inventory = JSON.parse(await readFile(join(root, 'benchmark/baseline-test-inventory.json'), 'utf8'));
for (const entry of inventory.cases.filter(entry => ['cpp-host', 'android-host'].includes(entry.kind))) {
  const { file, name } = entry.candidateAssertion;
  files[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
  passedAssertions.push(`${file}:${name}`);
}
const report = { schema: 1, completedAt: new Date().toISOString(), dependencies: before,
  files, passedAssertions, jest: { path: jestPath, passedAssertions: jest.numPassedTests },
  evidence, deviceExecution: 'pending' };
await writeFile(join(root, 'benchmark/host-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ hostAssertionEvidence: passedAssertions.length, output: 'benchmark/host-verification.json', deviceExecution: 'pending' }));

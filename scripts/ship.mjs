#!/usr/bin/env node
// One command for a release: bump the version in a pull request, wait for CI,
// merge it, then hand over to release.mjs (tag, GitHub release with generated
// notes, npm). Run it from a clean, up-to-date main. Run again after a
// failure: a version already bumped on main but not released is picked up
// where it stopped.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseNotes } from './release-notes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.on('uncaughtException', (error) => { console.error(`\nship: ${error.message}`); process.exit(1); });
const usage = `npm run ship -- [VERSION] [--summary TEXT] [--dry-run] [--otp CODE]

  VERSION     defaults to the next prerelease (0.1.0-beta.1 -> 0.1.0-beta.2) or patch
  --summary   the release title's summary, after "vX.Y.Z — "
  --dry-run   print the version and the release notes; change nothing
  --otp       forwarded to npm, if it asks for a one-time password`;

const options = { dryRun: false, release: [] };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0); }
  if (arg === '--dry-run') { options.dryRun = true; continue; }
  if (arg === '--summary' || arg === '--otp') {
    const value = process.argv[++i];
    if (!value) throw new Error(`Missing value for ${arg}\n${usage}`);
    if (arg === '--summary') options.summary = value;
    options.release.push(arg, value);
    continue;
  }
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(arg) && !options.version) { options.version = arg; continue; }
  throw new Error(`Unknown argument: ${arg}\n${usage}`);
}

const env = { ...process.env, npm_config_loglevel: 'notice' };
const capture = (command, args, extraEnv = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...env, ...extraEnv } });
  if (result.error) throw result.error;
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
};
const output = (command, args, extraEnv) => {
  const result = capture(command, args, extraEnv);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
};
const run = (command, args, cwd = root, extraEnv = {}) => {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...env, ...extraEnv } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
};
const version = () => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const name = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name;

const nextVersion = (current) => {
  const pre = /^(\d+\.\d+\.\d+)-([A-Za-z]+)\.(\d+)$/.exec(current);
  if (pre) return `${pre[1]}-${pre[2]}.${Number(pre[3]) + 1}`;
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
};
const isReleased = (v) =>
  capture('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/v${v}`]).status === 0 &&
  capture('npm', ['view', `${name}@${v}`, 'version', '--prefer-online']).stdout === v;

// Accounts and a clean main first.
if (capture('gh', ['auth', 'status']).status !== 0) throw new Error('The GitHub CLI is not logged in: run `gh auth login` first.');
if (!options.dryRun && capture('npm', ['whoami']).status !== 0) throw new Error('Not logged in to npm: run `npm login` first.');
output('git', ['fetch', '--quiet', 'origin', 'main', '--tags']);
if (!options.dryRun) {
  if (output('git', ['branch', '--show-current']) !== 'main') throw new Error('Run it from main: `git switch main`.');
  if (output('git', ['status', '--porcelain'])) throw new Error('The working tree has uncommitted changes.');
  if (output('git', ['rev-parse', 'HEAD']) !== output('git', ['rev-parse', 'origin/main'])) {
    run('git', ['pull', '--ff-only', '--quiet']);
  }
}

const current = version();
const resuming = !isReleased(current);
const target = resuming ? current : (options.version ?? nextVersion(current));
if (resuming && options.version && options.version !== current) {
  throw new Error(`main is at ${current}, bumped but not released yet: release it first (npm run ship).`);
}
console.log(resuming
  ? `${current} is on main but not released yet: releasing it.`
  : `${current} is released; next: ${target}.`);

if (options.dryRun) {
  // The notes as release.mjs will build them once the version is bumped.
  const notes = buildReleaseNotes({ summary: options.summary, version: target });
  console.log(`\n# ${notes.title}\n\n${notes.body}\n\n--- X post ---\n${notes.post}`);
  console.log('\nDry run: nothing was changed.');
  process.exit(0);
}

if (!resuming) {
  // Fails before any branch exists when there is nothing to release.
  buildReleaseNotes({ version: target });
  const branch = `release/v${target}`;
  run('git', ['switch', '-c', branch]);
  try {
    run('npm', ['version', target, '--no-git-tag-version', '--ignore-scripts']);
    // The example app's Podfile.lock records the library's version. pod lives
    // under rbenv's Ruby 3.2.0 on the maintainer's Mac.
    run('pod', ['install'], path.join(root, 'example', 'ios'), { RBENV_VERSION: process.env.RBENV_VERSION ?? '3.2.0' });
    run('git', ['add', 'package.json', 'package-lock.json', 'example/ios/Podfile.lock']);
    run('git', ['commit', '-m', `Release ${target}`]);
    run('git', ['push', '--set-upstream', 'origin', branch]);
    run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', `Release ${target}`,
      '--body', `Version bump for ${target}. \`npm run ship\` merges it once CI passes, then tags and publishes it.`]);
    // The required check has to start before --watch can wait on it.
    for (let attempt = 0; attempt < 30 && capture('gh', ['pr', 'checks', branch]).stdout === ''; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    run('gh', ['pr', 'checks', branch, '--watch', '--fail-fast', '--interval', '15']);
    run('gh', ['pr', 'merge', branch, '--squash']);
  } finally {
    if (output('git', ['branch', '--show-current']) !== 'main') run('git', ['switch', 'main']);
  }
  run('git', ['pull', '--ff-only', '--quiet']);
  run('git', ['branch', '-D', branch]);
  if (version() !== target) throw new Error(`main is not at ${target} after the merge.`);
}

// Tag, GitHub release and npm. npm asks for the passkey or a code here.
run('node', [path.join('scripts', 'release.mjs'), ...options.release]);

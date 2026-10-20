#!/usr/bin/env node
// Release notes for the version in package.json, in the form of the earlier
// GitHub releases: install block, every pull request merged since the last
// tag with its summary and author, what is not yet qualified, and the
// archive's SHA-256 (added by release.mjs once the archive exists).
//
//   node scripts/release-notes.mjs [--summary TEXT] [--out FILE]
//
// Without --out the notes are printed, to read them before a release.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoUrl = 'https://github.com/batical/react-native-skia-webgpu-video';

const output = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
};

/** The latest version tag on HEAD's history other than this version's own,
 * which release.mjs creates before the notes; null for a first release. */
export const previousTag = (version) => {
  const result = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*',
    ...(version ? ['--exclude', `v${version}`] : []), 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

/** Pull requests squash-merged since the tag, oldest first. */
export const pullRequestsSince = (tag) => {
  const subjects = output('git', ['log', '--reverse', '--format=%s', ...(tag ? [`${tag}..HEAD`] : ['HEAD'])]);
  const numbers = [...subjects.matchAll(/\(#(\d+)\)$/gm)].map((match) => Number(match[1]));
  return [...new Set(numbers)].map((number) =>
    JSON.parse(output('gh', ['pr', 'view', String(number), '--json', 'number,title,body,author,url'])));
};

/** The part of a PR description a reader of the release needs: its first
 * section (Summary, Changes or the opening paragraphs), without the test log,
 * the attribution line or the PR's own headings. */
const summaryOf = (body) => {
  const lines = (body ?? '').replace(/\r\n/g, '\n').split('\n')
    .filter((line) => !/Generated with \[Claude Code\]/.test(line));
  const sections = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      sections.push(current);
      current = { heading: heading[1].trim(), lines: [] };
    } else current.lines.push(line);
  }
  sections.push(current);
  const wanted = sections.find((section) => /^(summary|changes|what changes)/i.test(section.heading ?? ''))
    ?? sections.find((section) => section.heading === null && section.lines.join('').trim());
  // Only its list: the prose around it is often addressed to the reviewer.
  const items = [];
  for (const line of wanted?.lines ?? []) {
    if (/^\s*[-*]\s+/.test(line)) items.push(line);
    else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += `\n${line}`;
  }
  if (items.length) return items.join('\n');
  const paragraph = (wanted?.lines ?? []).join('\n').trim().split(/\n\s*\n/)[0] ?? '';
  return paragraph.replace(/^#{3,}\s+(.*)$/gm, '**$1**');
};

/** `version` names a version not yet bumped in package.json (ship.mjs's dry run). */
export const buildReleaseNotes = ({ summary, version: next } = {}) => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = next ?? pkg.version;
  const tag = previousTag(version);
  const pulls = pullRequestsSince(tag);
  if (!pulls.length) throw new Error(`No pull request merged since ${tag ?? 'the first commit'}: nothing to release.`);
  const maintainer = output('gh', ['repo', 'view', '--json', 'owner', '-q', '.owner.login']);
  const peers = pkg.peerDependencies;
  const pinned = ['react-native-skia', 'react-native-webgpu', 'react-native-reanimated', 'react-native-worklets']
    .map((peer) => `${peer}@${peers[peer]}`).join(' ');
  const status = readFileSync(path.join(root, '.github', 'release-status.md'), 'utf8').trim();

  const title = `v${version} — ${summary ?? (pulls.length === 1 ? pulls[0].title : `${pulls.length} changes since ${tag}`)}`;
  const changes = pulls.map((pull) => {
    const credit = pull.author.login === maintainer ? '' : `, by @${pull.author.login}`;
    const text = summaryOf(pull.body);
    return `### ${pull.title} (#${pull.number}${credit})\n\n${text || `See ${pull.url}.`}`;
  }).join('\n\n');
  const thanks = [...new Set(pulls.map((pull) => pull.author.login).filter((login) => login !== maintainer))];

  const body = [
    `Requires **\`react-native-skia@${peers['react-native-skia']}\`** and **\`react-native-webgpu@${peers['react-native-webgpu']}\`**.`
      + (thanks.length ? ` Thanks to ${thanks.map((login) => `@${login}`).join(', ')} for contributing.` : ''),
    '## Install',
    ['```sh', `npm install --save-exact ${pinned}`, `npm install --save-exact ${pkg.name}@${version}`,
      'npx --no-install skia-video-patch-canvas', '```'].join('\n'),
    `Add the last command to your app's \`postinstall\`, then rebuild the native app; see the [README](${repoUrl}/tree/v${version}#installation). The archive attached here is the same package, installable by URL.`,
    `## Changes since ${tag ?? 'the start'}`,
    changes,
    status,
    tag ? `**Full changelog**: ${repoUrl}/compare/${tag}...v${version}` : '',
  ].filter(Boolean).join('\n\n');

  // An X post: the version, up to three pull request titles, the install line.
  const install = `npm i ${pkg.name}@${/-([A-Za-z]+)/.exec(version)?.[1] ?? 'latest'}`;
  const bullets = pulls.slice(0, 3).map((pull) => `• ${pull.title}`);
  let post = [`${pkg.name} ${version} is out 🎬`, '', ...bullets, '', install].join('\n');
  while (post.length > 280 && bullets.length > 1) {
    bullets.pop();
    post = [`${pkg.name} ${version} is out 🎬`, '', ...bullets, '', install].join('\n');
  }
  return { version, previousTag: tag, title, body, post };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const notes = buildReleaseNotes({ summary: option('--summary') });
  const out = option('--out');
  if (out) {
    writeFileSync(out, `${notes.body}\n`);
    console.log(`${notes.title}\n→ ${out}`);
  } else {
    console.log(`# ${notes.title}\n\n${notes.body}\n\n--- X post ---\n${notes.post}`);
  }
}

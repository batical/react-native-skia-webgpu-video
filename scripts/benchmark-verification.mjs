import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Conservative dependency identity: any source/test change invalidates the
// recorded host result rather than keeping a stale "passed" inventory label.
export async function dependencyFingerprint(root) {
  const entries = [];
  const visit = async (path) => {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const relative = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(relative);
      else if (/\.(?:[cm]?[jt]sx?|[hc](?:pp)?|mm|java)$/.test(entry.name)) entries.push(relative);
    }
  };
  for (const path of ['src', 'cpp', 'ios', 'android/src/main', 'android/src/test']) await visit(path);
  entries.push('package.json', 'package-lock.json', 'test/utils/serializedUiRuntime.ts');
  const digest = createHash('sha256');
  for (const path of entries.sort()) digest.update(path).update('\0').update(await readFile(join(root, path))).update('\0');
  return digest.digest('hex');
}

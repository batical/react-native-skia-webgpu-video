#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

// A version/hash check prevents applying the patch blindly after an upgrade.
// All files are validated before any mutation; a repeated install is a no-op.
const require = createRequire(import.meta.url);
const patch = JSON.parse(
  readFileSync(new URL("./skia-canvas-patch.json", import.meta.url)),
);
const packagePath = require.resolve("react-native-skia/package.json");
const packageRoot = dirname(packagePath);
const installed = JSON.parse(readFileSync(packagePath));
if (installed.version !== patch.version) {
  throw new Error(
    `Review the Skia canvas lifecycle patch for ${installed.version}; expected ${patch.version}. See docs/UPSTREAM_NOTES.md.`,
  );
}
const changes = [];
for (const [path, definition] of Object.entries(patch.files)) {
  const destination = join(packageRoot, path);
  const source = readFileSync(destination, "utf8");
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash === definition.after) continue;
  if (hash !== definition.before) {
    throw new Error(
      `Skia file changed: ${path}. Review other patches before applying this canvas lifecycle patch.`,
    );
  }
  let patched = source;
  for (const edit of definition.edits) {
    if (patched.split(edit.before).length !== 2)
      throw new Error(`Ambiguous patch: ${path}`);
    patched = patched.replace(edit.before, edit.after);
  }
  if (createHash("sha256").update(patched).digest("hex") !== definition.after) {
    throw new Error(`Patch verification failed: ${path}`);
  }
  changes.push([destination, patched]);
}
for (const [path, content] of changes) writeFileSync(path, content);
console.log(
  changes.length
    ? "Skia canvas lifecycle patch applied; rebuild the native app."
    : "Skia canvas lifecycle patch already applied.",
);

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../../", import.meta.url));
const definition = JSON.parse(
  readFileSync(join(root, "scripts/skia-canvas-patch.json")),
);
const hash = (source) => createHash("sha256").update(source).digest("hex");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rnskv-patch-"));
  const peer = join(dir, "node_modules/react-native-skia");
  mkdirSync(peer, { recursive: true });
  mkdirSync(join(dir, "scripts"));
  writeFileSync(
    join(peer, "package.json"),
    JSON.stringify({ name: "react-native-skia", version: definition.version }),
  );
  for (const file of [
    "apply-skia-canvas-patch.mjs",
    "skia-canvas-patch.json",
  ]) {
    copyFileSync(join(root, "scripts", file), join(dir, "scripts", file));
  }
  for (const [path, change] of Object.entries(definition.files)) {
    let source = readFileSync(
      join(root, "node_modules/react-native-skia", path),
      "utf8",
    );
    if (hash(source) === change.after) {
      for (const edit of [...change.edits].reverse())
        source = source.replace(edit.after, edit.before);
    }
    assert.equal(hash(source), change.before, `Source fixture drift: ${path}`);
    mkdirSync(dirname(join(peer, path)), { recursive: true });
    writeFileSync(join(peer, path), source);
  }
  const run = () =>
    spawnSync(
      process.execPath,
      [join(dir, "scripts/apply-skia-canvas-patch.mjs")],
      { encoding: "utf8" },
    );
  const verify = (key) => {
    for (const [path, change] of Object.entries(definition.files))
      assert.equal(hash(readFileSync(join(peer, path))), change[key]);
  };
  return {
    dir,
    peer,
    run,
    verify,
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("applies the exact native/type patch and repeats without modifying it", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    f.verify("after");
    const rerun = f.run();
    assert.equal(rerun.status, 0);
    assert.match(rerun.stdout, /already applied/);
    f.verify("after");
  } finally {
    f.clean();
  }
});
test("refuses an upstream version change before modifying any file", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.peer, "package.json"),
      JSON.stringify({ name: "react-native-skia", version: "3.0.4" }),
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Review the Skia/);
    f.verify("before");
  } finally {
    f.clean();
  }
});
test("validates all files before changing any when another patch conflicts", () => {
  const f = fixture();
  try {
    const paths = Object.keys(definition.files);
    const conflict = paths.at(-1);
    writeFileSync(
      join(f.peer, conflict),
      readFileSync(join(f.peer, conflict), "utf8") + "\n// Other patch\n",
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Skia file changed/);
    for (const path of paths.slice(0, -1))
      assert.equal(
        hash(readFileSync(join(f.peer, path))),
        definition.files[path].before,
      );
  } finally {
    f.clean();
  }
});
test("recovers a partially applied patch after an interrupted installation", () => {
  const f = fixture();
  try {
    const path = Object.keys(definition.files)[0];
    let source = readFileSync(join(f.peer, path), "utf8");
    for (const edit of definition.files[path].edits)
      source = source.replace(edit.before, edit.after);
    writeFileSync(join(f.peer, path), source);
    assert.equal(f.run().status, 0);
    f.verify("after");
  } finally {
    f.clean();
  }
});

test("upgrades the previously installed canvas patch with the ownership/cache fixes", () => {
  const f = fixture();
  try {
    const additions = new Set([
      "cpp/rnskia/RNImageProvider.h",
      "cpp/api/JsiSkApi.h",
    ]);
    for (const [path, change] of Object.entries(definition.files)) {
      if (additions.has(path)) continue;
      let source = readFileSync(join(f.peer, path), "utf8");
      for (const edit of change.edits) source = source.replace(edit.before, edit.after);
      writeFileSync(join(f.peer, path), source);
    }
    assert.equal(f.run().status, 0);
    f.verify("after");
  } finally {
    f.clean();
  }
});

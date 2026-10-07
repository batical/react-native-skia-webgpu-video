import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Compile the actual patched Skia 3 header against its Graphite/Dawn headers
// and Apple's simulator SDK. No downloaded framework or linked GPU build.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skia = join(root, 'node_modules/react-native-skia');
const metadata = JSON.parse(readFileSync(join(root, 'scripts/skia-canvas-patch.json')));
const hashes = {};
for (const file of ['cpp/api/JsiSkCanvas.h', 'cpp/api/JsiSkSurface.h', 'cpp/rnskia/RNDawnContext.h']) {
  const hash = createHash('sha256').update(readFileSync(join(skia, file))).digest('hex');
  if (hash !== metadata.files[file].after) throw new Error(`Installed ${file} does not match the verified patch`);
  hashes[file] = hash;
}
const output = mkdtempSync(join(tmpdir(), 'rnskv-skia-patch-syntax-'));
try {
  const unit = join(output, 'canvas.mm');
  writeFileSync(unit, '#include "api/JsiSkSurface.h"\n');
  const args = ['--sdk', 'iphonesimulator', 'clang++', '-std=c++20',
    '-target', 'arm64-apple-ios16.4-simulator', '-fobjc-arc', '-fsyntax-only',
    '-Wno-deprecated-declarations', '-DSK_GRAPHITE=1',
    '-DSK_IMAGE_READ_PIXELS_DISABLE_LEGACY_API=1',
    '-DSK_DISABLE_LEGACY_SHAPER_FACTORY=1'];
  for (const path of ['cpp', 'cpp/api', 'cpp/jsi', 'cpp/rnskia', 'cpp/utils',
    'cpp/skia', 'cpp/dawn/include']) args.push('-I', join(skia, path));
  args.push('-I', 'node_modules/react-native/ReactCommon/jsi',
    '-I', 'node_modules/react-native/ReactCommon/callinvoker', unit);
  const result = spawnSync('xcrun', args, { cwd: root, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Skia canvas header compilation exited with ${result.status ?? result.signal}`);
  console.log(JSON.stringify({ skiaCanvasPatch: 'syntax-passed',
    target: 'arm64-apple-ios16.4-simulator', sha256: hashes,
    gpuExecution: 'pending' }));
} finally {
  rmSync(output, { recursive: true, force: true });
}

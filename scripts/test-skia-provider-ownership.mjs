import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Skia 3.7.3 fixed the leak upstream (#4277); this guards the installed
// factory against a regression rather than checking a local patch.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skia = join(root, 'node_modules/react-native-skia');
const source = readFileSync(join(skia, 'cpp/rnskia/RNImageProvider.h'), 'utf8');
const factory = source.match(/static sk_sp<ImageProvider> Make\(Uploader uploader, uint64_t generation\)\s*\{([^}]+)\}/);
if (!factory) throw new Error('Review the changed ImageProvider factory before testing');
const output = mkdtempSync(join(tmpdir(), 'rnskv-provider-ownership-'));
const asan = process.argv.includes('--asan');
try {
  const unit = join(output, 'provider.cpp');
  const executable = join(output, 'provider');
  writeFileSync(unit, readFileSync(join(root, 'test/native/SkiaProviderOwnershipTest.cpp'), 'utf8')
    .replace('/* INSTALLED_FACTORY_BODY */', factory[1]));
  const compile = spawnSync(process.env.CXX || 'clang++', [
    '-std=c++17', '-DNDEBUG',
    ...(asan ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : []),
    '-I', join(skia, 'cpp/skia'), unit, '-o', executable,
  ], { stdio: 'inherit', timeout: 60000 });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) throw new Error('Provider ownership test compilation failed');
  const run = spawnSync(executable, [], { stdio: 'inherit', timeout: 10000 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error('ImageProvider factory did not release its construction reference');
  console.log(JSON.stringify({ skiaProviderFactoryOwnership: 'passed', sanitizers: asan }));
} finally {
  rmSync(output, { recursive: true, force: true });
}

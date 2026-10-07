import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Validate all 50 XCTest methods with Apple's real simulator headers. This
// compiles assertions; it does not claim the simulator/device executed them.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const xcode = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' });
if (xcode.status !== 0) throw new Error('Xcode with an iPhoneSimulator SDK is required');
const frameworks = join(xcode.stdout.trim(), 'Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks');
const args = ['--sdk', 'iphonesimulator', 'clang++', '-std=c++20',
  '-target', 'arm64-apple-ios16.4-simulator', '-fobjc-arc', '-fsyntax-only',
  '-Wno-deprecated-declarations', '-F', frameworks,
  '-I', 'ios', '-I', 'cpp',
  '-I', 'node_modules/react-native/ReactCommon/jsi',
  '-I', 'node_modules/react-native/ReactCommon/callinvoker'];
if (process.env.RNSV_HERMES_INCLUDE) args.push('-I', process.env.RNSV_HERMES_INCLUDE);
else args.push('-DRNSV_TEST_JSC', '-I', 'node_modules/react-native/ReactCommon/jsc');
args.push('ios/tests/LegacyParityTests.mm');
const result = spawnSync('xcrun', args, { cwd: root, stdio: 'inherit', timeout: 120000 });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(JSON.stringify({ iosLegacyAssertions: 50, target: 'arm64-apple-ios16.4-simulator', syntax: 'passed', deviceExecution: 'pending' }));

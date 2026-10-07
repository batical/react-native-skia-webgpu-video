# Contributing

Open a pull request against `main`. Describe the problem, resulting behavior and relevant verification. Keep native resource ownership, cancellation and frame timestamps explicit when changing the video pipeline.

The CI check is **Host checks**. It runs on Ubuntu 24.04 with Node.js 24, installs the committed npm lockfile, applies the version/hash guarded Skia patch, and checks the API, types, patch installer, benchmark harness, portable C++ policies and package output. It has read-only repository permissions and does not publish packages.

To reproduce its checks from the repository root:

```sh
npm ci --ignore-scripts
node scripts/apply-skia-canvas-patch.mjs
npm test -- --ci
npm run typecheck
npm run test:package
npm run benchmark:test
node scripts/test-native.mjs --pure-only --asan
npm run build
npm run check-package
npm pack --dry-run --ignore-scripts
```

The portable C++ step requires Clang with AddressSanitizer/UndefinedBehaviorSanitizer support. The CI checks do not execute iOS/Android media pipelines or qualify GPU performance, audio, pixels or physical memory. For native changes, record the platform, exact tested revision and results from the [iPhone guide](../docs/IOS_DEVICE_TESTS.md) or [Android guide](../android/BUILD_VALIDATION.md). Preserve failed cases and unavailable measurements. Do not commit device identifiers, signing material, app containers, private recordings or `*.local.json` results.

For a single-maintainer repository, the proposed `main` protection requires a pull request, the unique **Host checks** check from GitHub Actions, an up-to-date branch and resolved conversations. Apply restrictions to administrators, disable force pushes/deletion and configure no bypass. Start with **zero required approvals**; requiring approval from another person would prevent the sole maintainer from merging their own changes. Requiring a second reviewer can be enabled when one is available. Verify the emitted check name after the first GitHub run before configuring protection; adding this workflow does not itself protect the branch. See [GitHub branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

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

The public repository's `main` branch requires a pull request, the **Host checks** check from the GitHub Actions app, an up-to-date branch and resolved conversations. These restrictions also apply to administrators. Force pushes and branch deletion are disabled. There are **zero required approvals** while there is one maintainer; another person's approval would otherwise be required to merge that maintainer's own changes. Required reviews can be added when another reviewer is available. The configuration is recorded in [main-protection.json](main-protection.json); changing that file alone does not change the server-side rule. See [GitHub branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

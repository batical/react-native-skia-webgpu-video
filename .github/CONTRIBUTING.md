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

The portable C++ step requires Clang with AddressSanitizer/UndefinedBehaviorSanitizer support. The CI checks do not execute iOS/Android media pipelines or qualify GPU performance, audio, pixels or physical memory. For native changes, record the platform, exact tested revision and results from the [iPhone guide](../docs/IOS_DEVICE_TESTS.md) or [Android guide](../android/BUILD_VALIDATION.md); `scripts/test-ios-device-ab-run.mjs` and `scripts/test-android-device-run.mjs` run benchmark cases on a connected device. For an export change, pass `onProfile` or read `exportProfile` in the results to compare per-stage timings. Preserve failed cases and unavailable measurements. Do not commit device identifiers, signing material, app containers, private recordings or `*.local.json` results.

The public repository's `main` branch requires a pull request, the **Host checks** check from the GitHub Actions app, an up-to-date branch and resolved conversations. These restrictions also apply to administrators. Force pushes and branch deletion are disabled. There are **zero required approvals** while there is one maintainer; another person's approval would otherwise be required to merge that maintainer's own changes. Required reviews can be added when another reviewer is available. The configuration is recorded in [main-protection.json](main-protection.json); changing that file alone does not change the server-side rule. See [GitHub branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Releasing

A release publishes the version in `package.json` as a git tag, a GitHub release with the package archive, and an npm package. From a clean `main`, one command does all of it:

```sh
npm run ship -- --dry-run                   # the next version and its release notes; changes nothing
npm run ship -- --summary "what it brings"  # bump PR, CI, merge, tag, GitHub release, npm
```

`scripts/ship.mjs` picks the next prerelease (`0.1.0-beta.1` → `0.1.0-beta.2`) or patch unless given a version. It bumps `package.json`, `package-lock.json` and the example's `Podfile.lock` in a `release/vX` pull request, waits for the **Host checks**, squash-merges it, then runs `scripts/release.mjs`. Only the GitHub CLI needs to be logged in: npm is published from GitHub Actions, without an npm login or passkey. Run it again after a failure: a version bumped on `main` but not released is released where it stopped.

The release notes come from `scripts/release-notes.mjs` (`npm run release:notes` prints them): the install block from the pinned peers, every pull request merged since the last tag with the list of its Summary or Changes section and its author, then `.github/release-status.md`, which says what is not yet qualified; keep that file current. `release.mjs` adds the archive's SHA-256 and prints a post for X. A pull request description is release material: write its list for the library's users.

`npm run release` alone does the tag, GitHub release and npm steps for a version already bumped on `main`:

```sh
npm run release -- --dry-run   # checks and archive only
npm run release
```

`scripts/release.mjs` refuses to run unless the GitHub CLI is logged in and the version is not on npm yet. A new tag is cut only from a clean `main` equal to `origin/main`, after the host checks pass. Publishing the GitHub release starts the **Publish to npm** workflow (`.github/workflows/release.yml`); the script follows that run until it ends, then prints the dist-tags. The workflow publishes the archive attached to the release, so both carry the same bytes. A prerelease such as `0.2.0-beta.0` goes to the dist-tag named after it (`beta`). It also becomes `latest`, what a bare `npm install` or `pnpm add` gets, as long as no stable version exists; a tag never moves back to an older version. Pass `--notes-file` to replace the generated release notes and `--summary` for the title. A run that stops after the tag or the GitHub release can be started again: the steps already done are skipped, and an existing release gets a new workflow run. `gh workflow run release.yml -f tag=vX.Y.Z` does the same by hand; for a version already on npm, it only sets the dist-tags.

The workflow authenticates to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), with no token. The package's settings on npmjs.com hold its trusted publisher: GitHub Actions, organization or user `batical`, repository `react-native-skia-webgpu-video`, workflow filename `release.yml`, no environment, and **Allow npm dist-tag** checked. Each field must match exactly; npm only checks them at publish time, and a mismatch fails the run with a 404 or `ENEEDAUTH`. `npm view` can show a cached package for a while; add `--prefer-online` to check.

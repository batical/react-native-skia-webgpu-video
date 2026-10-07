#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_tmp="$(mktemp -d "${TMPDIR:-/tmp}/rnskv-frame-lease.XXXXXX")"
trap 'rm -rf "$task_tmp"' EXIT

"${CXX:-clang++}" -std=c++20 -Wall -Wextra -Werror \
  -fsanitize=address,undefined -g \
  "$task_root/android/tests/RgbaFrameLeaseTest.cpp" \
  -o "$task_tmp/frame-lease-test"
"$task_tmp/frame-lease-test"

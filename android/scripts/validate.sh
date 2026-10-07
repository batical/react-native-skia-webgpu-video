#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
android_project="$repo_dir/example/android"
mode="${1:-build}"
if [[ $# -gt 0 ]]; then shift; fi
if [[ -z "${ANDROID_HOME:-}" && -n "${ANDROID_SDK_ROOT:-}" ]]; then export ANDROID_HOME="$ANDROID_SDK_ROOT"; fi
if [[ -z "${ANDROID_HOME:-}" && -d "$HOME/Library/Android/sdk" ]]; then export ANDROID_HOME="$HOME/Library/Android/sdk"; fi
if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then export JAVA_HOME="$(/usr/libexec/java_home -v 17)"; fi
if [[ -z "${ANDROID_HOME:-}" || ! -d "$ANDROID_HOME/platforms" ]]; then echo "Android SDK required (ANDROID_HOME)." >&2; exit 2; fi
architecture="${RNSKV_ANDROID_ABI:-arm64-v8a}"
gradle=("$android_project/gradlew" -p "$android_project" --no-daemon --max-workers=2 "-PreactNativeArchitectures=$architecture")
case "$mode" in
  build)
    "${gradle[@]}" :app:assembleDebug :app:assembleRelease \
      :react-native-skia-webgpu-video:assembleDebug :react-native-skia-webgpu-video:assembleDebugAndroidTest \
      :react-native-skia-webgpu-video:testDebugUnitTest "$@"
    ;;
  instrument)
    serial="${1:-${ANDROID_SERIAL:-}}"
    if [[ -z "$serial" ]]; then echo "Specify a connected Android device serial; no emulator or device is assumed." >&2; exit 2; fi
    "$ANDROID_HOME/platform-tools/adb" -s "$serial" get-state | rg -q '^device$'
    export ANDROID_SERIAL="$serial"
    "${gradle[@]}" :react-native-skia-webgpu-video:connectedDebugAndroidTest
    ;;
  *) echo "Usage: $0 build | instrument DEVICE_SERIAL" >&2; exit 2 ;;
esac

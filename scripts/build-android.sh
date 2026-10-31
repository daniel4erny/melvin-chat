#!/usr/bin/env bash
# Builds a debug Android APK into .releases/android.
# Requires: JDK 17, Android SDK + NDK 27, Rust targets for Android.
#
#   export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
#   export ANDROID_HOME="$HOME/Android/Sdk"
#   export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
#   export PATH="$HOME/.cargo/bin:$PATH"
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ANDROID_HOME:?set ANDROID_HOME}"
: "${NDK_HOME:?set NDK_HOME (e.g. \$ANDROID_HOME/ndk/27.0.12077973)}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$NDK_HOME}"

cd desktop
bun install --frozen-lockfile
bunx tauri android init --ci
bunx tauri android build --debug --apk --target aarch64 --ci

cd ..
mkdir -p .releases/android
find desktop/src-tauri/gen/android -name '*.apk' -exec cp {} .releases/android/ \;
(cd .releases/android && sha256sum * > SHA256SUMS)

echo "Android builds:"
ls -lh .releases/android

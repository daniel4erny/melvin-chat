#!/usr/bin/env bash
# Builds a signed release Android APK into .releases/android.
# Requires: JDK 17, Android SDK + NDK 27, Rust targets for Android.
#
#   export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
#   export ANDROID_HOME="$HOME/Android/Sdk"
#   export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
#   export PATH="$HOME/.cargo/bin:$PATH"
#
# The signing key lives outside the repo in ~/.melvin-signing so rebuilding
# never changes the app signature. Override with MELVIN_KEYSTORE_DIR and
# MELVIN_KEYSTORE_PASSWORD when needed.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ANDROID_HOME:?set ANDROID_HOME}"
: "${NDK_HOME:?set NDK_HOME (e.g. \$ANDROID_HOME/ndk/27.0.12077973)}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$NDK_HOME}"

KEYSTORE_DIR="${MELVIN_KEYSTORE_DIR:-$HOME/.melvin-signing}"
KEYSTORE="$KEYSTORE_DIR/melvin-release.jks"
STOREPASS="${MELVIN_KEYSTORE_PASSWORD:-melvin-release}"

mkdir -p "$KEYSTORE_DIR"
chmod 700 "$KEYSTORE_DIR"
if [ ! -f "$KEYSTORE" ]; then
  echo "Generating Android signing key at $KEYSTORE"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -alias melvin \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$STOREPASS" -keypass "$STOREPASS" \
    -dname "CN=Melvin, O=Melvin, C=CZ"
  chmod 600 "$KEYSTORE"
fi

cd desktop
bun install --frozen-lockfile
bunx tauri android init --ci

# --- signing + notification permission -------------------------------------
# gen/android is generated and gitignored, so the config is patched here on
# every build instead of being committed.
cat > src-tauri/gen/android/keystore.properties <<EOF
storeFile=$KEYSTORE
storePassword=$STOREPASS
keyAlias=melvin
keyPassword=$STOREPASS
EOF
chmod 600 src-tauri/gen/android/keystore.properties

python3 - <<'PY'
import pathlib

gradle = pathlib.Path("src-tauri/gen/android/app/build.gradle.kts")
s = gradle.read_text()
if "signingConfigs {" not in s:
    s = s.replace(
        "android {\n",
        '''android {
    signingConfigs {
        create("release") {
            val props = java.util.Properties()
            val propsFile = rootProject.file("keystore.properties")
            if (propsFile.exists()) {
                propsFile.inputStream().use { props.load(it) }
            }
            storeFile = file(props.getProperty("storeFile", ""))
            storePassword = props.getProperty("storePassword", "")
            keyAlias = props.getProperty("keyAlias", "melvin")
            keyPassword = props.getProperty("keyPassword", "")
        }
    }
''',
        1,
    )
if 'getByName("release") {' in s and 'signingConfig = signingConfigs.getByName("release")' not in s:
    s = s.replace(
        'getByName("release") {\n',
        'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")\n',
        1,
    )
gradle.write_text(s)

manifest = pathlib.Path("src-tauri/gen/android/app/src/main/AndroidManifest.xml")
m = manifest.read_text()
if "POST_NOTIFICATIONS" not in m:
    m = m.replace(
        '    <uses-permission android:name="android.permission.INTERNET" />',
        '    <uses-permission android:name="android.permission.INTERNET" />\n'
        '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n'
        '    <uses-permission android:name="android.permission.VIBRATE" />',
        1,
    )
    manifest.write_text(m)
PY

# ---------------------------------------------------------------------------
bunx tauri android build --apk --target aarch64 --ci

cd ..
VERSION="$(grep -m1 '"version"' desktop/src-tauri/tauri.conf.json | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')"
rm -rf .releases/android
mkdir -p .releases/android
APK="$(find desktop/src-tauri/gen/android -path '*/outputs/apk/release/*.apk' | sort | head -1)"
if [ -z "$APK" ]; then
  echo "No release APK produced" >&2
  exit 1
fi
cp "$APK" ".releases/android/melvin-${VERSION}-arm64-release.apk"

APKSIGNER="$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs ".releases/android/melvin-${VERSION}-arm64-release.apk"
fi

(cd .releases/android && sha256sum $(ls | grep -v '^SHA256SUMS$') > SHA256SUMS)

echo "Android builds:"
ls -lh .releases/android

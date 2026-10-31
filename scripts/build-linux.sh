#!/usr/bin/env bash
# Builds the Linux desktop packages into .releases/linux.
# Requires: bun, Rust, dpkg, rpm-tools, patchelf, fuse2 (or APPIMAGE_EXTRACT_AND_RUN).
set -euo pipefail

cd "$(dirname "$0")/.."

cd desktop
bun install --frozen-lockfile
APPIMAGE_EXTRACT_AND_RUN=1 bunx tauri build --bundles deb,rpm,appimage

cd ..
mkdir -p .releases/linux
cp desktop/src-tauri/target/release/bundle/deb/*.deb .releases/linux/
cp desktop/src-tauri/target/release/bundle/rpm/*.rpm .releases/linux/
cp desktop/src-tauri/target/release/bundle/appimage/*.AppImage .releases/linux/
(cd .releases/linux && sha256sum * > SHA256SUMS)

echo "Linux builds:"
ls -lh .releases/linux

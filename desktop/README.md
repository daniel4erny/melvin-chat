# Melvin apps (Tauri v2)

One React app, four platforms. This crate wraps `web/dist` in a native Tauri
window for **Windows, Linux, macOS, iOS and Android**.

## Desktop (Windows / Linux / macOS)

Prereqs:

- [Rust](https://rustup.rs) stable
- Bun
- Linux only: `webkit2gtk-4.1`, `libappindicator3`, `librsvg2`, plus your
  distro's build tools. On Arch: `sudo pacman -S webkit2gtk-4.1 base-devel`
- Windows only: WebView2 (preinstalled on Windows 10/11) and MSVC build tools

```bash
cd desktop
bun install
bun run dev      # dev window, reloads with the Vite dev server
bun run build    # installers in src-tauri/target/release/bundle
```

Outputs:

- Linux: `.deb`, `.rpm`, `.AppImage`
- Windows: `.msi`, NSIS `.exe`
- macOS: `.dmg` (must be built on macOS)

The app asks for the server URL on the login screen. Use the full address,
e.g. `https://melvin.example.com` (no trailing slash). It is stored in
localStorage, so it only has to be entered once per device.

## Android

Prereqs: Android Studio + SDK + NDK, JDK 17, Rust targets.

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cd desktop
bun install
bun run android:init     # once, generates src-tauri/gen/android
bun run android:dev      # runs on a connected device/emulator
bun run android:build    # signed/unsigned APK + AAB (see Tauri docs for signing)
```

## iOS

Prereqs: macOS with Xcode 15+, CocoaPods, Rust targets.

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
cd desktop
bun install
bun run ios:init         # once, generates src-tauri/gen/apple
bun run ios:dev          # simulator or device
bun run ios:build
```

For a plain `http://` server on iOS, add `NSAppTransportSecurity` →
`NSAllowsArbitraryLoads` to the generated `Info.plist`. HTTPS is recommended.

## Notes

- Calls need microphone/camera permission. Tauri's WebView asks for it the
  first time; on Android the generated manifest already includes the
  `RECORD_AUDIO` / `CAMERA` permissions, on iOS the usage descriptions must be
  present in `Info.plist` (add `NSMicrophoneUsageDescription` and
  `NSCameraUsageDescription`).
- Push notifications are not wired up; the app uses in-page notifications and
  sound while it is open.
- We do not ship a separate mobile UI: the same responsive React app is used.

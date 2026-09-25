#!/bin/bash
# Omniwatch Swift shell build (plain swiftc; no SwiftPM/Xcode needed — Command Line Tools only).
#
#   shell/build.sh test       compile Core + Tests into build/swift-tests and run it
#   shell/build.sh app        build build/Omniwatch.app (ad-hoc codesigned)
#   shell/build.sh selftest   build the app, then run its headless --self-test against the
#                             stub backend (shell/Tests/fake_backend.py) unless OMNIWATCH_BACKEND is set
#   shell/build.sh icon       regenerate shell/Resources/Omniwatch.icns (CoreGraphics, headless)
#   shell/build.sh clean
#
# Env: BUILD_DIR (default <repo>/build), UNIVERSAL=1 (arm64 + x86_64 via lipo),
#      SWIFTC (default swiftc), CODESIGN_ID (default "-" = ad-hoc).
set -euo pipefail

SHELL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SHELL_DIR/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$REPO_DIR/build}"
SWIFTC="${SWIFTC:-swiftc}"
MIN_MACOS=13.0
BUNDLE_ID=com.burnsbert.omniwatch
APP="$BUILD_DIR/Omniwatch.app"

core_sources() { ls "$SHELL_DIR"/Core/*.swift; }
app_sources() { ls "$SHELL_DIR"/App/*.swift; }
test_sources() { ls "$SHELL_DIR"/Tests/*.swift; }

version() {
  local v=""
  if [ -f "$REPO_DIR/omniwatch/__init__.py" ]; then
    v="$(sed -n "s/^__version__ *= *['\"]\([^'\"]*\)['\"].*/\1/p" "$REPO_DIR/omniwatch/__init__.py" | head -1)"
  fi
  echo "${v:-1.0.0}"
}

cmd_test() {
  mkdir -p "$BUILD_DIR"
  local out="$BUILD_DIR/swift-tests"
  # -parse-as-library: TestMain.swift uses @main (no top-level code in the test binary).
  # shellcheck disable=SC2046
  "$SWIFTC" -swift-version 5 -parse-as-library -Onone -g \
    -target "$(uname -m)-apple-macos$MIN_MACOS" \
    $(core_sources) $(test_sources) -o "$out"
  "$out" "$@"
}

compile_app_arch() { # $1 = arch, $2 = output
  # shellcheck disable=SC2046
  "$SWIFTC" -swift-version 5 -O -target "$1-apple-macos$MIN_MACOS" \
    -framework AppKit -framework WebKit -framework UserNotifications -framework Carbon \
    $(core_sources) $(app_sources) -o "$2"
}

cmd_app() {
  local ver; ver="$(version)"
  local tmp="$BUILD_DIR/app-obj"
  rm -rf "$APP" "$tmp"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$tmp"
  if [ "${UNIVERSAL:-0}" = "1" ]; then
    compile_app_arch arm64 "$tmp/Omniwatch-arm64"
    compile_app_arch x86_64 "$tmp/Omniwatch-x86_64"
    lipo -create "$tmp/Omniwatch-arm64" "$tmp/Omniwatch-x86_64" -output "$APP/Contents/MacOS/Omniwatch"
  else
    compile_app_arch "$(uname -m)" "$APP/Contents/MacOS/Omniwatch"
  fi
  sed -e "s/@VERSION@/$ver/g" -e "s/@BUNDLE_ID@/$BUNDLE_ID/g" -e "s/@MIN_MACOS@/$MIN_MACOS/g" \
    "$SHELL_DIR/Resources/Info.plist" > "$APP/Contents/Info.plist"
  plutil -lint -s "$APP/Contents/Info.plist"
  if [ -f "$SHELL_DIR/Resources/Omniwatch.icns" ]; then
    cp "$SHELL_DIR/Resources/Omniwatch.icns" "$APP/Contents/Resources/"
  fi
  # The backend zipapp comes from `make dist` (WP8). Without it, run with OMNIWATCH_BACKEND.
  if [ -f "$REPO_DIR/dist/omniwatch" ]; then
    cp "$REPO_DIR/dist/omniwatch" "$APP/Contents/Resources/omniwatch.pyz"
  elif [ -f "$REPO_DIR/dist/omniwatch.pyz" ]; then
    cp "$REPO_DIR/dist/omniwatch.pyz" "$APP/Contents/Resources/omniwatch.pyz"
  else
    echo "build.sh: note: no dist/omniwatch zipapp; the app needs OMNIWATCH_BACKEND (or --backend) to find a backend" >&2
  fi
  if [ -n "${PYTHON_PATH_RECORD:-}" ]; then
    printf '%s\n' "$PYTHON_PATH_RECORD" > "$APP/Contents/Resources/python-path"
  fi
  codesign --force --sign "${CODESIGN_ID:--}" --identifier "$BUNDLE_ID" "$APP"
  codesign --verify "$APP"
  rm -rf "$tmp"
  echo "built $APP ($ver)"
}

cmd_selftest() {
  cmd_app
  local backend="${OMNIWATCH_BACKEND:-$SHELL_DIR/Tests/fake_backend.py}"
  OMNIWATCH_BACKEND="$backend" "$APP/Contents/MacOS/Omniwatch" --self-test
}

cmd_icon() {
  local tmp; tmp="$(mktemp -d)"
  "$SWIFTC" -swift-version 5 -O "$SHELL_DIR/Resources/make-icon.swift" -o "$tmp/make-icon"
  "$tmp/make-icon" "$tmp/icon-1024.png"
  local set="$tmp/Omniwatch.iconset"
  mkdir -p "$set"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$tmp/icon-1024.png" --out "$set/icon_${s}x${s}.png" >/dev/null
    local d=$((s * 2))
    sips -z "$d" "$d" "$tmp/icon-1024.png" --out "$set/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$SHELL_DIR/Resources/Omniwatch.icns"
  rm -rf "$tmp"
  echo "wrote $SHELL_DIR/Resources/Omniwatch.icns"
}

case "${1:-}" in
  test) shift; cmd_test "$@" ;;
  app) cmd_app ;;
  selftest) cmd_selftest ;;
  icon) cmd_icon ;;
  clean) rm -rf "$APP" "$BUILD_DIR/swift-tests" "$BUILD_DIR/swift-tests.dSYM" "$BUILD_DIR/app-obj" ;;
  *) echo "usage: $0 {test|app|selftest|icon|clean}" >&2; exit 2 ;;
esac

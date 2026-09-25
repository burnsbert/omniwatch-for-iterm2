#!/bin/bash
# Omniwatch installer (docs/DESIGN.md §6 "Install"). One command, no sudo:
#
#   git clone https://github.com/burnsbert/omniwatch-for-iterm2 && \
#     cd omniwatch-for-iterm2 && ./install.sh
#
# Usage: install.sh [--prefix DIR] [--no-app] [--no-colors]
#                    [--with-plugin] [--no-open]
#
#   --prefix DIR    install under DIR instead of $HOME (DIR/Applications,
#                   DIR/.local/bin, DIR/.local/share/omniwatch) — used by
#                   `make check-install` so nothing touches the real
#                   ~/Applications or ~/.local/bin.
#   --no-app        skip building/installing Omniwatch.app; browser-only
#                   mode (`omniwatch --browser`). Automatic if `swiftc`
#                   isn't found.
#   --no-colors     skip installing the `iterm2` package (tab colors).
#                   By default it's installed into Omniwatch's own vendor
#                   directory (DIR-or-$HOME/.local/share/omniwatch/vendor)
#                   — never the system or Homebrew Python — so pip never
#                   refuses it as an externally-managed environment. If
#                   pip or the network fails, install.sh warns and
#                   continues; tab colors just show as unavailable
#                   (`omniwatch doctor`).
#   --with-colors   deprecated no-op: this is now the default. Kept so
#                   old instructions/scripts still work.
#   --with-plugin   also install the iTerm2 status-bar plugin (WP10,
#                   docs/DESIGN.md §4.8) into
#                   DIR-or-$HOME/Library/Application Support/iTerm2/
#                   Scripts/AutoLaunch — opt-in; never run in automated
#                   tests without --prefix.
#   --no-open       don't open the app / run anything after installing.
#                   Always passed in automated tests/CI.
#
# Idempotent: safe to run more than once (each run replaces its own
# previous output rather than erroring or duplicating anything).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "install.sh: $*"; }
die() { echo "install.sh: error: $*" >&2; exit 1; }

PREFIX=""
NO_APP=0
NO_COLORS=0
NO_OPEN=0
WITH_PLUGIN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    --no-app) NO_APP=1; shift ;;
    --no-colors) NO_COLORS=1; shift ;;
    --with-colors)
      log "note: --with-colors is deprecated — installing iterm2 is the default now. Ignoring."
      shift ;;
    --with-plugin) WITH_PLUGIN=1; shift ;;
    --no-open) NO_OPEN=1; shift ;;
    -h|--help)
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
      exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

HOME_DIR="${PREFIX:-$HOME}"
APP_DEST_DIR="$HOME_DIR/Applications"
BIN_DEST_DIR="$HOME_DIR/.local/bin"
SHARE_DEST_DIR="$HOME_DIR/.local/share/omniwatch"
SHIM_PATH="$BIN_DEST_DIR/omniwatch"
ZIPAPP_DEST="$SHARE_DEST_DIR/omniwatch.pyz"
APP_DEST="$APP_DEST_DIR/Omniwatch.app"
VENDOR_DIR="$SHARE_DEST_DIR/vendor"

# ---- 1. Checks (docs/DESIGN.md §6, §4.7 PythonLocator) --------------------

[ "$(uname -s)" = "Darwin" ] || die "Omniwatch only runs on macOS."

# /usr/bin/swiftc, /usr/bin/make and /usr/bin/python3 always exist on
# macOS: without the Command Line Tools they're shims that pop an
# "install developer tools" dialog and fail. So `command -v` proves
# nothing; ask xcode-select (which never prompts) instead.
HAVE_DEVTOOLS=0
if xcode-select -p >/dev/null 2>&1; then HAVE_DEVTOOLS=1; fi

find_python() {
  # Any >=3.9 interpreter is acceptable (docs/DESIGN.md §4.7/§8); the
  # `iterm2` package no longer needs to already be importable — it's
  # installed into our own vendor dir below, for whichever interpreter
  # this picks. Prefer a Homebrew/python.org python3 over the Command
  # Line Tools' /usr/bin/python3 shim (checked last, and skipped
  # entirely without developer tools — see below).
  candidates="${OMNIWATCH_PYTHON:-} python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3"
  for c in $candidates; do
    [ -n "$c" ] || continue
    command -v "$c" >/dev/null 2>&1 || continue
    resolved="$(command -v "$c")"
    # Running the CLT shim would pop the developer-tools install dialog.
    if [ "$resolved" = "/usr/bin/python3" ] && [ "$HAVE_DEVTOOLS" -eq 0 ]; then continue; fi
    "$resolved" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null || continue
    echo "$resolved"
    return 0
  done
  return 1
}

PYTHON_BIN="$(find_python)" || die "no Python >=3.9 found (checked \$OMNIWATCH_PYTHON, python3, Homebrew, /usr/local, /usr/bin)."
log "using Python: $PYTHON_BIN ($("$PYTHON_BIN" -c 'import platform; print(platform.python_version())'))"

if [ "$NO_APP" -eq 0 ]; then
  if [ "$HAVE_DEVTOOLS" -eq 0 ] || ! command -v swiftc >/dev/null 2>&1; then
    log "swiftc not found (no developer tools) — install Xcode Command Line Tools with:"
    log "    xcode-select --install"
    log "or re-run with --no-app for browser-only mode. Continuing with --no-app."
    NO_APP=1
  fi
fi

# ---- 2. Build (docs/DESIGN.md §6 "Artifacts") -----------------------------

log "building dist/omniwatch (zipapp)..."
if [ "$HAVE_DEVTOOLS" -eq 1 ]; then
  make -C "$REPO_DIR" dist-pyz
else
  # `make` is a developer-tools shim too; same steps as the Makefile's
  # dist-pyz target, with the Python found above.
  pyz_build="$(mktemp -d)"
  cp -R "$REPO_DIR/omniwatch" "$pyz_build/omniwatch"
  find "$pyz_build" -name __pycache__ -type d -prune -exec rm -rf {} +
  printf 'from omniwatch.__main__ import run\nrun()\n' > "$pyz_build/__main__.py"
  mkdir -p "$REPO_DIR/dist"
  "$PYTHON_BIN" -m zipapp "$pyz_build" -p "/usr/bin/env python3" -o "$REPO_DIR/dist/omniwatch"
  chmod +x "$REPO_DIR/dist/omniwatch"
  rm -rf "$pyz_build"
fi

if [ "$NO_APP" -eq 0 ]; then
  log "building Omniwatch.app (swiftc)..."
  PYTHON_PATH_RECORD="$PYTHON_BIN" make -C "$REPO_DIR" dist-app
fi

# ---- 3. Install (no sudo; everything under $HOME_DIR) ---------------------

mkdir -p "$BIN_DEST_DIR" "$SHARE_DEST_DIR"

cp "$REPO_DIR/dist/omniwatch" "$ZIPAPP_DEST"
chmod +x "$ZIPAPP_DEST"

cat > "$SHIM_PATH" <<SHIM
#!/bin/sh
# Installed by omniwatch's install.sh — re-run install.sh to update,
# don't edit this file directly.
exec "$PYTHON_BIN" "$ZIPAPP_DEST" "\$@"
SHIM
chmod +x "$SHIM_PATH"
log "installed shim: $SHIM_PATH"

if [ "$NO_APP" -eq 0 ]; then
  mkdir -p "$APP_DEST_DIR"
  rm -rf "$APP_DEST"
  cp -R "$REPO_DIR/dist/Omniwatch.app" "$APP_DEST"
  log "installed app: $APP_DEST"
else
  log "skipped Omniwatch.app (--no-app / browser-only mode)"
fi

case ":$PATH:" in
  *":$BIN_DEST_DIR:"*) ;;
  *) log "warning: $BIN_DEST_DIR is not on your PATH."
     log "  add it, e.g.: echo 'export PATH=\"$BIN_DEST_DIR:\$PATH\"' >> ~/.zshrc" ;;
esac

# Tab colors (docs/DESIGN.md §4.2/§6): `iterm2` (and its own deps,
# protobuf + websockets) install into our own vendor dir — never the
# system or Homebrew Python's site-packages — so pip never refuses it as
# an externally-managed environment. Uses the SAME interpreter recorded
# above so compiled wheels match. Idempotent: each run replaces the
# vendor dir cleanly. Best-effort: a pip/network failure warns and
# continues — install.sh must still succeed either way, with tab colors
# just unavailable (`omniwatch doctor`).
if [ "$NO_COLORS" -eq 0 ]; then
  log "installing iterm2 into the vendor dir (tab colors): $VENDOR_DIR"
  rm -rf "$VENDOR_DIR"
  mkdir -p "$VENDOR_DIR"
  if "$PYTHON_BIN" -m pip install --quiet --disable-pip-version-check \
      --target "$VENDOR_DIR" iterm2; then
    log "tab colors: iterm2 installed"
  else
    log "warning: could not install iterm2 (pip/network failure) — tab colors will show as unavailable."
    log "  re-run later with: make install-colors"
    rm -rf "$VENDOR_DIR"
  fi
else
  log "--no-colors: skipped installing iterm2 (tab colors will be unavailable)"
fi

# ---- 4. Optional extras ----------------------------------------------------

if [ "$WITH_PLUGIN" -eq 1 ]; then
  plugin_dest="$HOME_DIR/Library/Application Support/iTerm2/Scripts/AutoLaunch"
  log "installing the iTerm2 status-bar plugin to $plugin_dest ..."
  if [ "$HAVE_DEVTOOLS" -eq 1 ]; then
    PLUGIN_DEST="$plugin_dest" make -C "$REPO_DIR" install-plugin
  else
    mkdir -p "$plugin_dest"
    cp "$REPO_DIR/plugin/iterm2/omniwatch_status.py" "$REPO_DIR/plugin/iterm2/omniwatch_plugin_lib.py" "$plugin_dest/"
  fi
fi

if [ "$NO_OPEN" -eq 0 ]; then
  if [ "$NO_APP" -eq 0 ]; then
    log "opening Omniwatch..."
    open "$APP_DEST" || true
  else
    log "starting Omniwatch in the browser..."
    "$SHIM_PATH" --browser || true
  fi
else
  log "--no-open: not launching anything."
fi

log "Tab colors: enable iTerm2 → Settings → General → Magic → Enable Python API"
log "done."

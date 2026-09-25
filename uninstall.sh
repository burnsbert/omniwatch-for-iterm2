#!/bin/bash
# Reverses install.sh (docs/DESIGN.md §6). Usage:
#   uninstall.sh [--prefix DIR] [--purge]
#
#   --prefix DIR   remove from DIR instead of $HOME (must match the
#                  --prefix install.sh was run with).
#   --purge        also remove config, state, and logs (labels, prefs,
#                  projects). Without --purge, config is left in place
#                  so reinstalling keeps the user's setup.
set -euo pipefail

PREFIX=""
PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "uninstall.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

HOME_DIR="${PREFIX:-$HOME}"
APP_DEST="$HOME_DIR/Applications/Omniwatch.app"
SHIM_PATH="$HOME_DIR/.local/bin/omniwatch"
SHARE_DEST_DIR="$HOME_DIR/.local/share/omniwatch"
# Same resolution as omniwatch/config.py: $OMNIWATCH_CONFIG_DIR, else
# ${XDG_CONFIG_HOME:-~/.config}/omniwatch (an empty value counts as unset).
# With --prefix everything stays inside the prefix: env overrides are
# ignored so a sandboxed purge (make check-install) can't reach a real dir.
if [ -n "$PREFIX" ]; then
  CONFIG_DIR="$PREFIX/.config/omniwatch"
elif [ -n "${OMNIWATCH_CONFIG_DIR:-}" ]; then
  CONFIG_DIR="$OMNIWATCH_CONFIG_DIR"
else
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/omniwatch"
fi
LOG_DIR="$HOME_DIR/Library/Logs/Omniwatch"
PLUGIN_DIR="$HOME_DIR/Library/Application Support/iTerm2/Scripts/AutoLaunch"
PLUGIN_STATUS="$PLUGIN_DIR/omniwatch_status.py"
PLUGIN_LIB="$PLUGIN_DIR/omniwatch_plugin_lib.py"

log() { echo "uninstall.sh: $*"; }

removed=0
for path in "$APP_DEST" "$SHIM_PATH" "$SHARE_DEST_DIR" "$PLUGIN_STATUS" "$PLUGIN_LIB"; do
  if [ -e "$path" ]; then
    rm -rf "$path"
    log "removed $path"
    removed=1
  fi
done
[ "$removed" -eq 1 ] || log "nothing installed to remove (already uninstalled?)"

if [ "$PURGE" -eq 1 ]; then
  for path in "$CONFIG_DIR" "$LOG_DIR"; do
    if [ -e "$path" ]; then
      rm -rf "$path"
      log "purged $path"
    fi
  done
else
  log "config left in place at $CONFIG_DIR (use --purge to remove it)"
fi

log "done."

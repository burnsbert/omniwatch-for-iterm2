"""Locates and installs the vendor directory containing the optional
third-party `iterm2` package (tab colors; see itermcolor.py).

install.sh installs `iterm2` (and its own dependencies, protobuf and
websockets) into a private vendor directory — never the system or
Homebrew Python's site-packages (docs/DESIGN.md §4.7/§6) — so this module
must add that directory to `sys.path` before anything imports `iterm2`.
`omniwatch/__init__.py` calls `install()` first thing, before any other
omniwatch submodule (which is why this module itself must not import
anything from the rest of the package).

Resolution order (first match wins):
  1. `$OMNIWATCH_VENDOR_DIR`, if set (even if the directory doesn't exist —
     an explicit override is trusted as-is, matching OMNIWATCH_CONFIG_DIR's
     contract elsewhere in this codebase).
  2. `vendor/` next to the running zipapp/script (`sys.argv[0]`) — this is
     where install.sh actually puts it for the CLI shim (`<share>/vendor`
     next to `<share>/omniwatch.pyz`), and works automatically for any
     `--prefix` too.
  3. `~/.local/share/omniwatch/vendor` — the default `<share>/vendor`,
     which is also where the CLI shim's vendor dir lives, and is what the
     Omniwatch.app bundle falls back on (its own zipapp lives inside the
     bundle at Contents/Resources/omniwatch.pyz, so #2 doesn't apply to a
     default, non---prefix install of the app).

Never raises: a broken/missing vendor dir just means tab colors stay
unavailable, exactly like today.
"""
import os
import sys

_HOME = os.path.expanduser('~')
DEFAULT_VENDOR_DIR = os.path.join(_HOME, '.local', 'share', 'omniwatch', 'vendor')


def resolve():
    """Returns (path, source): source is 'env', 'zipapp-sibling', or
    'default'. `path` may not exist (callers must check)."""
    override = os.environ.get('OMNIWATCH_VENDOR_DIR')
    if override:
        return override, 'env'
    try:
        zipapp_path = os.path.abspath(sys.argv[0])
        candidate = os.path.join(os.path.dirname(zipapp_path), 'vendor')
        if os.path.isdir(candidate):
            return candidate, 'zipapp-sibling'
    except Exception:
        pass
    return DEFAULT_VENDOR_DIR, 'default'


def install():
    """Adds the resolved vendor dir to sys.path if it exists and isn't
    already there. Best-effort — must never raise (called at package
    import time, before anything else)."""
    try:
        path, _source = resolve()
        if path and os.path.isdir(path) and path not in sys.path:
            sys.path.insert(0, path)
    except Exception:
        pass


def package_source():
    """None if the `iterm2` package can't be found at all; otherwise
    'vendor' or 'site-packages' depending on where it resolved from.
    Never raises."""
    import importlib.util
    try:
        spec = importlib.util.find_spec('iterm2')
    except (ImportError, ValueError):
        return None
    if spec is None:
        return None
    locations = [spec.origin] + list(spec.submodule_search_locations or [])
    try:
        vendor_dir, _source = resolve()
        vendor_dir = os.path.abspath(vendor_dir)
    except Exception:
        vendor_dir = None
    for loc in locations:
        if not loc:
            continue
        loc = os.path.abspath(loc)
        if vendor_dir and (loc == vendor_dir or
                            loc.startswith(vendor_dir + os.sep)):
            return 'vendor'
    return 'site-packages'

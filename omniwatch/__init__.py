"""Omniwatch for iTerm2 — GUI rebuild of Ultrawatch (backend package)."""

__version__ = '1.0.0'

# Must run before anything (including other omniwatch submodules) imports
# `iterm2` — adds the optional vendor dir to sys.path if install.sh put
# one there. See vendor.py for the resolution order and rationale.
from omniwatch import vendor as _vendor
_vendor.install()

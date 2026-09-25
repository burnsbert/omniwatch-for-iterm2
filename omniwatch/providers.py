"""The fake-iTerm/osascript seam (docs/DESIGN.md §5): every external
effect (osascript, ps/lsof, Keychain/HTTPS, the iTerm2 Python API, `open`,
the wall clock) goes through a `Providers` object. `RealProviders` wraps
the ported functions from iterm.py/agents.py/usage_*.py/itermcolor.py —
their own `run=`/`fetch=`/`set_color=` injection points stay, so the
ported parser/unit tests keep exercising them directly and unchanged.

`FakeProviders` (demo mode, WP3; tests, this package) implement the same
Protocols without ever touching a real subprocess or the network.

Engine threading and provider injection (pollers.py) are WP1; the fake
implementations that back demo mode live in omniwatch/demo/ (WP3).
"""
import subprocess
import time as _time
from typing import Optional, Protocol, Tuple

from omniwatch import agents, config, itermcolor
from omniwatch import iterm as iterm_module
from omniwatch import usage_claude, usage_codex


# ---------------------------------------------------------------------
# Protocols (documentation + optional static checking; not enforced at
# runtime — a Providers object is just any object with these attributes).
# ---------------------------------------------------------------------

class ItermProvider(Protocol):
    def snapshot(self, at: float = 0.0): ...
    def paths(self, at: float = 0.0): ...
    def goto(self, uid: str) -> bool: ...
    def close_uid(self, uid: str) -> bool: ...
    def new_tab(self) -> None: ...
    def reply(self, uid: str, text: str, submit: bool = False) -> bool: ...
    def probe(self) -> bool: ...
    def launch(self) -> None: ...


class AgentsProvider(Protocol):
    def scan(self) -> dict: ...
    def fill_cwds(self, ttys) -> dict: ...


class UsageProvider(Protocol):
    def fetch(self) -> Tuple[Optional[dict], Optional[int]]: ...


class ColorsProvider(Protocol):
    def fetch(self) -> dict: ...
    def set(self, uid: str, name: Optional[str]) -> bool: ...


class Opener(Protocol):
    def open_url(self, url: str) -> None: ...
    def open_app(self, name: str) -> None: ...
    def reveal(self, path: str) -> None: ...
    def open_editor(self, argv, path: str) -> None: ...
    def copy_text(self, text: str) -> None: ...


class Clock(Protocol):
    def time(self) -> float: ...
    def monotonic(self) -> float: ...
    def sleep(self, seconds: float) -> None: ...


class Providers(Protocol):
    iterm: ItermProvider
    agents: AgentsProvider
    usage_claude: UsageProvider
    usage_codex: UsageProvider
    colors: ColorsProvider
    opener: Opener
    clock: Clock


# ---------------------------------------------------------------------
# Real implementations
# ---------------------------------------------------------------------

class RealItermProvider:
    """Wraps iterm.py. `run` stays injectable (defaults to
    iterm.run_osascript) so tests can substitute a fake osascript runner
    without going through the module-level tripwire."""

    def __init__(self, run=None):
        self.run = run or iterm_module.run_osascript

    def snapshot(self, at=0.0):
        return iterm_module.fetch_snapshot(at=at, run=self.run)

    def paths(self, at=0.0):
        return iterm_module.fetch_paths(at=at, run=self.run)

    def goto(self, uid):
        return iterm_module.goto_session(uid, run=self.run)

    def close_uid(self, uid):
        return iterm_module.close_session_tab(uid, run=self.run)

    def new_tab(self):
        return iterm_module.new_tab(run=self.run)

    def reply(self, uid, text, submit=False):
        return iterm_module.write_text(uid, text, submit=submit, run=self.run)

    def probe(self):
        return iterm_module.probe(run=self.run)

    def launch(self):
        """`open -a iTerm` (§4.4 POST /api/v1/iterm/launch)."""
        subprocess.run(['open', '-a', 'iTerm'], timeout=config.OSASCRIPT_TIMEOUT)


class RealAgentsProvider:
    def scan(self):
        return agents.get_agent_ttys()

    def fill_cwds(self, ttys):
        return agents.fill_missing_tty_cwds(ttys)


class RealUsageProvider:
    """Wraps one of usage_claude.fetch_usage / usage_codex.fetch_codex_usage.

    `token` (optional) is the matching get_*_oauth_token function; it backs
    has_credentials(), which the engine uses to tell "no credentials" from
    "fetch failed" (P-15) and which diagnostics/doctor report."""

    def __init__(self, fetch, token=None):
        self._fetch = fetch
        self._token = token

    def fetch(self):
        return self._fetch()

    def has_credentials(self):
        """True/False, or None when there's no way to tell."""
        if self._token is None:
            return None
        return bool(self._token())


class RealColorsProvider:
    def fetch(self):
        return itermcolor.fetch_colors()

    def set(self, uid, name):
        return itermcolor.set_session_color(uid, name)


class RealOpener:
    def open_url(self, url):
        subprocess.Popen(['open', url])

    def open_app(self, name):
        subprocess.run(['open', '-a', name], timeout=config.OSASCRIPT_TIMEOUT)

    def reveal(self, path):
        """Select `path` in Finder (`open -R`)."""
        r = subprocess.run(['open', '-R', path], capture_output=True, text=True,
                           timeout=config.OSASCRIPT_TIMEOUT)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip() or 'open -R failed')

    def open_editor(self, argv, path):
        """Launch the editor detached (argv, never a shell)."""
        subprocess.Popen(list(argv) + [path], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)

    def copy_text(self, text):
        r = subprocess.run(['pbcopy'], input=text, text=True, timeout=5)
        if r.returncode != 0:
            raise RuntimeError('pbcopy failed')


class RealClock:
    def time(self):
        return _time.time()

    def monotonic(self):
        return _time.monotonic()

    def sleep(self, seconds):
        _time.sleep(seconds)


class RealProviders:
    """The production Providers implementation — every external effect
    goes through a real subprocess, HTTP request, or the iTerm2 Python
    API. Never instantiate this in a test; see tests/_support.py."""

    def __init__(self):
        self.iterm = RealItermProvider()
        self.agents = RealAgentsProvider()
        self.usage_claude = RealUsageProvider(usage_claude.fetch_usage,
                                              usage_claude.get_oauth_token)
        self.usage_codex = RealUsageProvider(usage_codex.fetch_codex_usage,
                                             usage_codex.get_codex_oauth_token)
        self.colors = RealColorsProvider()
        self.opener = RealOpener()
        self.clock = RealClock()

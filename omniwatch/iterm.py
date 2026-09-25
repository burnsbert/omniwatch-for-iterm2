"""iTerm2 interaction: batched AppleScript snapshot, paths, and actions.

Ported (near-verbatim) from ultrawatch_lib/iterm.py; see docs/DESIGN.md
§4.2. New for Omniwatch: ``WRITE_TEXT_SCRIPT`` (quick reply),
``CLOSE_SESSION_TAB_SCRIPT`` (closes by session uid, looked up inside the
script so a tab reorder between confirm and close can't hit the wrong tab
— P-67), ``PROBE_SCRIPT`` (onboarding automation-permission probe), and
``ItermNotAuthorized`` (raised when macOS denies Apple Events).

Protocol notes:
- Screen text contains tabs and newlines, so records use ASCII control
  separators: US (0x1f) between fields, RS (0x1e) between records.
  iTerm2's `text` property returns rendered screen cells, which can never
  contain raw C0 control characters, so the framing is unambiguous.
- AppleScript `&` on a non-text left operand builds a *list*, so every
  numeric field is coerced with `as text` before concatenation.
- Collection queries (`text of sessions of tabs of windows`) cost one
  Apple Event per property regardless of session count (~200ms for a full
  snapshot including all screen text), versus one event per property per
  session for `tell`-style loops.
- Scripts are passed to `osascript -` via stdin; parameters travel through
  `on run argv` — user-influenced strings are never interpolated into
  AppleScript source.
"""
import subprocess

from omniwatch import config
from omniwatch.snapshot import ItermSnapshot, PathsSnapshot, SessionInfo

US = '\x1f'
RS = '\x1e'
NOT_RUNNING_SENTINEL = '__NOT_RUNNING__'

# Substrings (case-insensitive) that identify a denied-Apple-Events
# failure, e.g. "execution error: Not authorized to send Apple events to
# iTerm2. (-1743)".
_NOT_AUTHORIZED_MARKERS = ('-1743', 'not authorized')


class ItermNotRunning(Exception):
    pass


class ItermError(Exception):
    pass


class ItermNotAuthorized(ItermError):
    """macOS Automation permission for iTerm2 was denied (osascript -1743
    / "Not authorized to send Apple events")."""


SNAPSHOT_SCRIPT = '''
set US to (ASCII character 31)
set RS to (ASCII character 30)
if application "iTerm2" is not running then return "__NOT_RUNNING__"
tell application "iTerm2"
    set winIds to id of windows
    set ids to unique id of sessions of tabs of windows
    set ttys to tty of sessions of tabs of windows
    set procs to is processing of sessions of tabs of windows
    set names to name of sessions of tabs of windows
    set texts to text of sessions of tabs of windows
end tell
set recs to {}
repeat with wi from 1 to (count of ids)
    set wTabs to item wi of ids
    repeat with ti from 1 to (count of wTabs)
        set tSess to item ti of wTabs
        repeat with si from 1 to (count of tSess)
            set end of recs to ((item wi of winIds) as text) & US & ¬
                (ti as text) & US & (si as text) & US & ¬
                (item si of tSess) & US & ¬
                (item si of (item ti of (item wi of ttys))) & US & ¬
                ((item si of (item ti of (item wi of procs))) as text) & US & ¬
                (item si of (item ti of (item wi of names))) & US & ¬
                (item si of (item ti of (item wi of texts)))
        end repeat
    end repeat
end repeat
set AppleScript's text item delimiters to RS
return recs as text
'''

PATHS_SCRIPT = '''
set US to (ASCII character 31)
set RS to (ASCII character 30)
if application "iTerm2" is not running then return "__NOT_RUNNING__"
set recs to {}
tell application "iTerm2"
    repeat with w in windows
        repeat with t in (tabs of w)
            repeat with s in (sessions of t)
                tell s
                    set u to unique id
                    set p to missing value
                    try
                        set p to variable named "path"
                    end try
                end tell
                if p is missing value then set p to ""
                set end of recs to u & US & p
            end repeat
        end repeat
    end repeat
end tell
set AppleScript's text item delimiters to RS
return recs as text
'''

GOTO_SCRIPT = '''
on run argv
    set target to item 1 of argv
    tell application "iTerm2"
        repeat with w in windows
            repeat with t in (tabs of w)
                repeat with s in (sessions of t)
                    if (unique id of s) is target then
                        select s
                        select t
                        select w
                        activate
                        return "ok"
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    return "notfound"
end run
'''

CLOSE_TAB_SCRIPT = '''
on run argv
    set winId to (item 1 of argv) as integer
    set tabIx to (item 2 of argv) as integer
    tell application "iTerm2"
        tell (first window whose id is winId)
            close tab tabIx
        end tell
    end tell
    return "ok"
end run
'''

CLOSE_SESSION_TAB_SCRIPT = '''
on run argv
    set target to item 1 of argv
    tell application "iTerm2"
        repeat with w in windows
            repeat with t in (tabs of w)
                repeat with s in (sessions of t)
                    if (unique id of s) is target then
                        close t
                        return "ok"
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    return "notfound"
end run
'''

NEW_TAB_SCRIPT = '''
tell application "iTerm2"
    tell current window
        create tab with default profile
    end tell
    activate
end tell
'''

# Quick reply (§3, "wow" features): `write text` via argv, never
# interpolated into AppleScript source. doNewline is "YES"/"NO" so a
# single-key menu reply (e.g. "1") can be sent with `newline NO`.
WRITE_TEXT_SCRIPT = '''
on run argv
    set target to item 1 of argv
    set msg to item 2 of argv
    set doNewline to item 3 of argv
    tell application "iTerm2"
        repeat with w in windows
            repeat with t in (tabs of w)
                repeat with s in (sessions of t)
                    if (unique id of s) is target then
                        tell s
                            if doNewline is "YES" then
                                write text msg
                            else
                                write text msg newline NO
                            end if
                        end tell
                        return "ok"
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    return "notfound"
end run
'''

# Onboarding step 1 (§2.10): a harmless read that triggers the macOS
# Automation prompt the first time it runs.
PROBE_SCRIPT = '''
tell application "iTerm2" to count windows
'''


def run_osascript(script, args=(), timeout=config.OSASCRIPT_TIMEOUT):
    """Run an AppleScript from stdin. Returns stdout; raises on failure.

    Raises ItermNotAuthorized when macOS denied Apple Events (osascript
    -1743 / "Not authorized to send Apple events"), else ItermError.
    """
    result = subprocess.run(
        ['osascript', '-', *args],
        input=script, capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or f'osascript exited {result.returncode}'
        if any(marker in detail.lower() for marker in _NOT_AUTHORIZED_MARKERS):
            raise ItermNotAuthorized(detail)
        raise ItermError(detail)
    return result.stdout


def parse_snapshot(raw, at=0.0):
    """Parse snapshot script output into an ItermSnapshot (pure function)."""
    body = raw.rstrip('\n')
    if body.strip() == NOT_RUNNING_SENTINEL:
        raise ItermNotRunning()
    sessions = []
    if body:
        for rec in body.split(RS):
            parts = rec.split(US, 7)
            if len(parts) != 8:
                continue  # defensive: drop malformed records
            win_id, tab_ix, sess_ix, uid, tty, proc, name, text = parts
            try:
                win_id_i, tab_i, sess_i = int(win_id), int(tab_ix), int(sess_ix)
            except ValueError:
                continue
            if tty == 'missing value':
                tty = ''
            if name == 'missing value':
                name = ''
            sessions.append(SessionInfo(
                window_id=win_id_i, tab_index=tab_i, session_index=sess_i,
                uid=uid, tty=tty, is_processing=(proc == 'true'),
                name=name, text=text))
    return ItermSnapshot(sessions=tuple(sessions), at=at)


def parse_paths(raw, at=0.0):
    """Parse paths script output into a PathsSnapshot (pure function)."""
    body = raw.rstrip('\n')
    if body.strip() == NOT_RUNNING_SENTINEL:
        raise ItermNotRunning()
    pairs = []
    if body:
        for rec in body.split(RS):
            parts = rec.split(US, 1)
            if len(parts) != 2:
                continue
            uid, path = parts
            if path == 'missing value':
                path = ''
            pairs.append((uid, path))
    return PathsSnapshot(paths=tuple(pairs), at=at)


def fetch_snapshot(at=0.0, run=run_osascript):
    return parse_snapshot(run(SNAPSHOT_SCRIPT), at=at)


def fetch_paths(at=0.0, run=run_osascript):
    return parse_paths(run(PATHS_SCRIPT), at=at)


def goto_session(uid, run=run_osascript):
    return run(GOTO_SCRIPT, args=(uid,)).strip() == 'ok'


def close_tab(window_id, tab_index, run=run_osascript):
    run(CLOSE_TAB_SCRIPT, args=(str(window_id), str(tab_index)))


def close_session_tab(uid, run=run_osascript):
    """Close the tab containing session `uid` (resolved inside the
    script, so a tab reorder between confirm and close can't close the
    wrong tab — P-67). Returns True if the session was found."""
    return run(CLOSE_SESSION_TAB_SCRIPT, args=(uid,)).strip() == 'ok'


def new_tab(run=run_osascript):
    run(NEW_TAB_SCRIPT)


def write_text(uid, text, submit=False, run=run_osascript):
    """Quick reply: `write text` into session `uid`. `submit=False` sends
    `newline NO` (single-key menu replies); `submit=True` appends a
    newline. Returns True if the session was found."""
    flag = 'YES' if submit else 'NO'
    return run(WRITE_TEXT_SCRIPT, args=(uid, text, flag)).strip() == 'ok'


def probe(run=run_osascript):
    """Onboarding step 1: a harmless call that triggers (or confirms) the
    macOS Automation permission prompt for iTerm2. Raises
    ItermNotAuthorized/ItermError/ItermNotRunning on failure."""
    run(PROBE_SCRIPT)
    return True

"""``runtime.json`` discovery file (docs/DESIGN.md §4.5/§4.6).

``{"port", "token", "pid", "version", "started_at"}``, mode 0600, written
atomically once the server is listening and removed on exit — but only by
the process that wrote it, so a second instance exiting never deletes the
first one's file. The CLI reads it to reuse a running backend instead of
starting another one; the (later) iTerm2 plugin reads it to find the API.
"""
import json
import os
import tempfile


def write(path, info):
    """Atomically write `info` to `path` with mode 0600."""
    directory = os.path.dirname(path) or '.'
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix='.runtime-')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(info, f)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read(path):
    """The parsed file, or None if it's missing, unreadable, or malformed."""
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if not isinstance(data.get('port'), int) or not isinstance(data.get('pid'), int):
        return None
    if not isinstance(data.get('token'), str):
        return None
    return data


def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def read_live(path):
    """The runtime info of a backend that is still running, else None."""
    info = read(path)
    if info and pid_alive(info['pid']):
        return info
    return None


def remove(path, pid=None):
    """Remove `path` if it belongs to `pid` (default: this process)."""
    pid = os.getpid() if pid is None else pid
    info = read(path)
    if info is not None and info.get('pid') != pid:
        return False
    try:
        os.unlink(path)
        return True
    except OSError:
        return False

"""Backend log file + fd-2 redirect (docs/DESIGN.md P-77; replaces
Ultrawatch's quiet.py).

``setup(path)`` keeps the previous run's log as ``<path>.1``, points Python
``logging`` at the file, and (optionally) redirects file descriptor 2 to it,
because the optional ``iterm2`` package and C extensions print straight to
stderr. After the redirect a late crash's traceback lands in the log too.
"""
import logging
import os
import sys

LOGGER_NAME = 'omniwatch'
FORMAT = '%(asctime)s %(levelname)s %(threadName)s %(name)s: %(message)s'

log = logging.getLogger(LOGGER_NAME)


def rotate(path):
    """Move an existing log to ``<path>.1`` (replacing the older one)."""
    if os.path.exists(path):
        try:
            os.replace(path, path + '.1')
        except OSError:
            pass


def setup(path=None, redirect_fd2=True, level=logging.INFO, stream=None):
    """Configure the ``omniwatch`` logger.

    With `path`: rotate, log to the file, and (if `redirect_fd2`) dup the
    file onto fd 2. Without `path`: log to `stream` (default stderr).
    Returns the handler that was installed."""
    for h in list(log.handlers):
        log.removeHandler(h)
        h.close()
    log.setLevel(level)
    log.propagate = False
    if path:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        rotate(path)
        handler = logging.FileHandler(path, encoding='utf-8')
        if redirect_fd2:
            redirect_stderr(handler.stream)
    else:
        handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(logging.Formatter(FORMAT))
    log.addHandler(handler)
    return handler


def redirect_stderr(file_obj, fd=2):
    """dup2 `file_obj` onto `fd` so raw writes to stderr land in the log."""
    file_obj.flush()
    os.dup2(file_obj.fileno(), fd)


def teardown():
    for h in list(log.handlers):
        log.removeHandler(h)
        try:
            h.flush()
            h.close()
        except Exception:
            pass

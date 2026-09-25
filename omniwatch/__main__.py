"""``python -m omniwatch`` / the zipapp entry point → cli.main()."""
import logging
import os
import sys

from omniwatch.cli import main


def run():
    code = main()
    logging.shutdown()
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    # Hard exit: poller/handler daemon threads may be parked in a
    # subprocess or a buffered write, and Python 3.13 can abort at
    # interpreter shutdown in that case ("_enter_buffered_busy", exit 134).
    # Everything that matters (state.json, runtime.json, logs) is already
    # flushed and closed by cli.serve().
    os._exit(code if isinstance(code, int) else 0)


if __name__ == '__main__':
    run()

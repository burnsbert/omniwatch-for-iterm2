# Omniwatch for iTerm2

Omniwatch is a GUI rebuild of [Ultrawatch for iTerm2](https://github.com/burnsbert/ultrawatch-for-iterm2)
that runs in its own window instead of inside iTerm2. It's for people running
many Claude Code / Codex agents, and it answers the question Ultrawatch
answers: **who needs me right now, and what are they doing?** — in a native
Mac window, with a menu-bar counter and notifications, and without taking an
iTerm2 tab.

Status: in development. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full
design and work breakdown.

## Development

```bash
make test      # Python unit tests (python3)
make test39    # same, under the Command Line Tools' /usr/bin/python3 (3.9)
make coverage  # coverage report (installs on demand: pip install --user coverage)
make check     # test + py_compile + web unit tests
```

## License

MIT © Eric Burns — see [`LICENSE`](LICENSE).

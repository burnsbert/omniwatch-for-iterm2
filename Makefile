PYTHON ?= python3
SYSTEM_PYTHON ?= /usr/bin/python3

.PHONY: test test39 coverage web-unit swift-test app check \
        e2e screenshots dist install install-colors clean

# ---- Python backend (WP0/WP1; docs/DESIGN.md §5, §7) ---------------------

test:
	$(PYTHON) -m unittest discover -s tests

# Must also pass under the Command Line Tools' /usr/bin/python3 (3.9.6):
# no `match`, no `X | Y` types, no 3.10+ stdlib APIs (docs/DESIGN.md §8).
test39:
	$(SYSTEM_PYTHON) -m unittest discover -s tests

# `coverage` is a dev-only dependency (`pip install --user coverage`);
# make coverage prints how to install it and exits non-zero rather than
# faking a number when it isn't available (docs/DESIGN.md §5).
coverage:
	@$(PYTHON) -c "import coverage" 2>/dev/null || ( \
		echo "coverage isn't installed for $(PYTHON)."; \
		echo "Install it with: $(PYTHON) -m pip install --user coverage"; \
		echo "(add --break-system-packages if pip refuses as externally managed)"; \
		exit 1 )
	$(PYTHON) -m coverage run --source=omniwatch -m unittest discover -s tests
	$(PYTHON) -m coverage report -m

# ---- Delegated to the other workers' areas --------------------------------

# web/js unit tests (owned by the web engineer, web-tests/**).
web-unit:
	@if [ -d web-tests ]; then \
		cd web-tests && node --test unit/; \
	else \
		echo "web-tests/ not present yet — skipping web-unit"; \
	fi

# Swift Core logic tests (owned by the shell engineer, shell/**).
swift-test:
	shell/build.sh test

# Full Swift/AppKit app build (owned by the shell engineer, shell/**).
app:
	shell/build.sh app

# ---- Aggregate targets -----------------------------------------------------

check: test
	$(PYTHON) -m py_compile omniwatch/*.py
	$(MAKE) web-unit
	@echo "check OK"

# ---- Stubs (later work packages; docs/DESIGN.md §5-§6) --------------------

e2e:
	@echo "TODO(WP6): npx playwright test (chromium + webkit, headless-only guard)"

screenshots:
	@echo "TODO(WP6): node scripts/screenshots.mjs (demo mode, dark+light)"

dist:
	@echo "TODO(WP8): zipapp (omniwatch/ incl. web/) + Omniwatch.app via shell/build.sh"

install:
	@echo "TODO(WP8): install.sh --prefix DIR [--no-app] [--with-colors] [--no-open]"

# Optional: iterm2 pip package for the tab-color indicator (see README).
# Plain `pip install` fails outright on PEP 668 "externally managed"
# Pythons (e.g. Homebrew's); --break-system-packages is only needed then,
# so try the plain install first and fall back.
install-colors:
	$(PYTHON) -m pip install iterm2 || \
		$(PYTHON) -m pip install --break-system-packages iterm2

clean:
	rm -rf build dist .coverage htmlcov
	find . -name __pycache__ -type d -exec rm -rf {} +

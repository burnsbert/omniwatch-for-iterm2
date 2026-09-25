PYTHON ?= python3
SYSTEM_PYTHON ?= /usr/bin/python3

.PHONY: test test39 coverage web-unit swift-test app check \
        e2e screenshots dist dist-pyz dist-app install check-install \
        install-colors clean

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

# ---- Packaging (WP8; docs/DESIGN.md §6 "Artifacts", §7 WP8) ---------------

# dist/omniwatch — a self-contained zipapp (omniwatch/ incl. web/, read via
# pkgutil.get_data so it works from inside the zip). Entry point calls
# omniwatch.cli.main() directly, per the coordinator's interface note.
dist-pyz:
	rm -rf build/app
	mkdir -p build/app dist
	cp -R omniwatch build/app/omniwatch
	find build/app -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
	printf 'from omniwatch.cli import main\nmain()\n' > build/app/__main__.py
	$(PYTHON) -m zipapp build/app -p "/usr/bin/env python3" -o dist/omniwatch
	chmod +x dist/omniwatch
	rm -rf build/app
	@echo "built dist/omniwatch"

# dist/Omniwatch.app — delegates the actual Swift build to shell/build.sh
# (owned by the shell engineer), then copies its output into dist/ to
# match the artifact path in docs/DESIGN.md §6. Skips gracefully (exit 0)
# when swiftc isn't available, matching install.sh's --no-app fallback.
# Set PYTHON_PATH_RECORD=<path> to have the app record which interpreter
# to run the backend with (Contents/Resources/python-path).
dist-app:
	@if ! command -v swiftc >/dev/null 2>&1; then \
		echo "swiftc not found — skipping dist/Omniwatch.app (dist/omniwatch zipapp still built)"; \
		exit 0; \
	fi
	$(MAKE) app
	rm -rf dist/Omniwatch.app
	mkdir -p dist
	cp -R build/Omniwatch.app dist/Omniwatch.app
	@echo "built dist/Omniwatch.app"

dist: dist-pyz dist-app

# One command, no sudo: ./install.sh (this target is a thin convenience
# wrapper; pass flags via INSTALL_ARGS, e.g. `make install
# INSTALL_ARGS="--prefix /tmp/x --no-open"`).
install:
	./install.sh $(INSTALL_ARGS)

# `install.sh --prefix <tmp> --no-open` into a throwaway prefix: verifies
# the layout, the shim, the app bundle's Info.plist keys, and the
# codesign, runs install.sh a second time to prove it's idempotent, then
# uninstalls and verifies cleanup. Never opens the app or any window
# (docs/DESIGN.md §5, §7 WP8).
check-install:
	@set -eu; \
	tmp="$$(mktemp -d)"; \
	echo "check-install: prefix=$$tmp"; \
	trap 'rm -rf "$$tmp"' EXIT; \
	./install.sh --prefix "$$tmp" --no-open; \
	test -x "$$tmp/.local/bin/omniwatch" || { echo "FAIL: shim not installed"; exit 1; }; \
	test -f "$$tmp/.local/share/omniwatch/omniwatch.pyz" || { echo "FAIL: zipapp not installed"; exit 1; }; \
	if command -v swiftc >/dev/null 2>&1; then \
		test -d "$$tmp/Applications/Omniwatch.app" || { echo "FAIL: app not installed"; exit 1; }; \
		plist="$$tmp/Applications/Omniwatch.app/Contents/Info.plist"; \
		id="$$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$$plist")"; \
		[ "$$id" = "com.burnsbert.omniwatch" ] || { echo "FAIL: CFBundleIdentifier=$$id"; exit 1; }; \
		/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$$plist" >/dev/null || { echo "FAIL: missing LSMinimumSystemVersion"; exit 1; }; \
		/usr/libexec/PlistBuddy -c 'Print :NSAppleEventsUsageDescription' "$$plist" >/dev/null || { echo "FAIL: missing NSAppleEventsUsageDescription"; exit 1; }; \
		/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsLocalNetworking' "$$plist" >/dev/null || { echo "FAIL: missing NSAllowsLocalNetworking"; exit 1; }; \
		codesign --verify --deep "$$tmp/Applications/Omniwatch.app" || { echo "FAIL: codesign --verify"; exit 1; }; \
		echo "check-install: Info.plist keys + codesign OK"; \
	else \
		echo "check-install: swiftc not found — skipped app-bundle checks (--no-app path)"; \
	fi; \
	if [ -f omniwatch/cli.py ]; then \
		"$$tmp/.local/bin/omniwatch" --version || { echo "FAIL: shim --version"; exit 1; }; \
		echo "check-install: shim --version OK"; \
	else \
		echo "check-install: omniwatch/cli.py doesn't exist yet — skipped shim --version (awaiting WP2)"; \
	fi; \
	echo "check-install: re-running install.sh to verify idempotency..."; \
	./install.sh --prefix "$$tmp" --no-open; \
	test -x "$$tmp/.local/bin/omniwatch" || { echo "FAIL: shim missing after second install"; exit 1; }; \
	echo "check-install: idempotent OK"; \
	./uninstall.sh --prefix "$$tmp" --purge; \
	[ ! -e "$$tmp/.local/bin/omniwatch" ] || { echo "FAIL: shim survived uninstall"; exit 1; }; \
	[ ! -e "$$tmp/Applications/Omniwatch.app" ] || { echo "FAIL: app survived uninstall"; exit 1; }; \
	echo "check-install: uninstall OK"; \
	echo "check-install PASSED"

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

"""Command line (docs/DESIGN.md §4.3, §4.7; docs/SHELL_CONTRACT.md §1-§3).

    omniwatch                    app installed → open -a Omniwatch; else --browser
    omniwatch --browser          serve + open the default browser at the auth URL
    omniwatch demo               serve --demo --browser (ephemeral config dir)
    omniwatch serve [--port 0] [--demo] [--demo-scenario NAME] [--demo-seed N]
                    [--demo-clock EPOCH] [--config-dir DIR] [--ready-json]
                    [--parent-pid PID] [--log-file PATH] [--browser] [--no-open]
    omniwatch doctor [--json]    diagnostics (python, iterm2 pkg, automation, creds)
    omniwatch --version

``serve --ready-json`` prints exactly one line on stdout once listening and
nothing after it. The orphan guard exits on stdin EOF (when stdin is a
pipe/socket and ``--ready-json``/``--parent-pid`` is given) or when the
parent pid changes (checked every 2 s). ``POST /api/v1/shutdown``,
SIGTERM, and SIGINT exit cleanly with status 0 (state saved, runtime.json
removed).

``--providers-factory MODULE:FUNC`` (hidden, for tests and the headless
self-test) replaces the providers with ``FUNC(scenario=, seed=,
frozen_clock=)`` and forces the ``OMNIWATCH_DEMO=1`` guard.
"""
import argparse
import http.client
import importlib
import json
import os
import shutil
import signal
import stat
import sys
import tempfile
import threading
import time

from omniwatch import __version__

COMMANDS = ('serve', 'demo', 'doctor')
PARENT_CHECK_SECONDS = 2.0
APP_PATHS = ('~/Applications/Omniwatch.app', '/Applications/Omniwatch.app')


class CliError(Exception):
    pass


def _add_provider_args(p):
    p.add_argument('--demo', action='store_true', help='fake iTerm2/usage data; never touches iTerm2')
    p.add_argument('--demo-scenario', default='default', metavar='NAME')
    p.add_argument('--demo-seed', type=int, default=0, metavar='N')
    p.add_argument('--demo-clock', type=float, default=None, metavar='EPOCH',
                   help='freeze the demo clock at EPOCH (it then moves only via demo/step)')
    p.add_argument('--providers-factory', default=None, help=argparse.SUPPRESS)


def serve_parser(prog='omniwatch serve'):
    p = argparse.ArgumentParser(prog=prog, description='Run the Omniwatch backend.')
    p.add_argument('--version', action='store_true', help='print the version and exit')
    p.add_argument('--port', type=int, default=0, help='TCP port on 127.0.0.1 (default: random)')
    _add_provider_args(p)
    p.add_argument('--config-dir', default=None, metavar='DIR')
    p.add_argument('--ready-json', action='store_true',
                   help='print one JSON ready line on stdout once listening')
    p.add_argument('--parent-pid', type=int, default=0, metavar='PID',
                   help='exit when the parent process changes')
    p.add_argument('--log-file', default=None, metavar='PATH')
    p.add_argument('--browser', action='store_true', help='open the UI in the default browser')
    p.add_argument('--no-open', action='store_true', help="don't open a browser")
    return p


def doctor_parser():
    p = argparse.ArgumentParser(prog='omniwatch doctor', description='Print diagnostics.')
    p.add_argument('--json', action='store_true')
    _add_provider_args(p)
    p.add_argument('--config-dir', default=None, metavar='DIR')
    return p


# ---------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------

def default_config_dir():
    xdg = os.environ.get('XDG_CONFIG_HOME') or os.path.join(os.path.expanduser('~'), '.config')
    return os.path.join(xdg, 'omniwatch')


def resolve_config_dir(opts):
    """--config-dir, else $OMNIWATCH_CONFIG_DIR, else a fresh temp dir in
    demo mode, else ~/.config/omniwatch. Returns (dir, is_temp)."""
    if opts.config_dir:
        return os.path.abspath(os.path.expanduser(opts.config_dir)), False
    env = os.environ.get('OMNIWATCH_CONFIG_DIR')
    if env:
        return env, False
    if opts.demo:
        return tempfile.mkdtemp(prefix='omniwatch-demo-'), True
    return default_config_dir(), False


def load_factory(spec):
    module_name, sep, attr = (spec or '').partition(':')
    if not sep or not module_name or not attr:
        raise CliError('--providers-factory must be MODULE:FUNC')
    try:
        module = importlib.import_module(module_name)
        return getattr(module, attr)
    except (ImportError, AttributeError) as e:
        raise CliError('cannot load providers factory %s: %s' % (spec, e))


def build_providers(opts):
    """(providers, demo_factory, scenarios). Demo/fake providers force the
    OMNIWATCH_DEMO guard on before anything else runs."""
    if opts.providers_factory or opts.demo:
        os.environ['OMNIWATCH_DEMO'] = '1'
    if opts.providers_factory:
        factory = load_factory(opts.providers_factory)
        scenarios = tuple(getattr(sys.modules[factory.__module__], 'SCENARIOS', ('default',)))
    elif opts.demo:
        try:
            from omniwatch.demo import SCENARIOS, make_demo_providers
        except ImportError as e:
            raise CliError('demo mode is unavailable: %s' % e)
        factory, scenarios = make_demo_providers, tuple(SCENARIOS)
    else:
        from omniwatch.providers import RealProviders
        return RealProviders(), None, ()
    if opts.demo_scenario not in scenarios:
        raise CliError('unknown demo scenario %r (choose from: %s)'
                       % (opts.demo_scenario, ', '.join(scenarios)))
    providers = factory(scenario=opts.demo_scenario, seed=opts.demo_seed,
                        frozen_clock=opts.demo_clock)
    return providers, factory, scenarios


def stdin_is_pipe(fd=0):
    try:
        mode = os.fstat(fd).st_mode
    except OSError:
        return False
    return stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)


def watch_stdin(on_eof, fd=0):
    """Block in os.read (not sys.stdin.buffer.read: a daemon thread parked
    in the buffered reader aborts Python 3.13 at shutdown) until EOF."""
    try:
        while os.read(fd, 4096):
            pass
    except OSError:
        pass
    on_eof('stdin closed')


def watch_parent(parent_pid, stop, on_change, interval=PARENT_CHECK_SECONDS,
                 getppid=os.getppid):
    while not stop.is_set():
        if getppid() != parent_pid:
            on_change('parent %d is gone' % parent_pid)
            return
        stop.wait(interval)


def app_installed():
    return any(os.path.isdir(os.path.expanduser(p)) for p in APP_PATHS)


def auth_url(port, token):
    return 'http://127.0.0.1:%d/auth?token=%s' % (port, token)


def backend_healthy(info, timeout=1.0):
    """True when the backend in `info` (runtime.json) answers /health."""
    try:
        conn = http.client.HTTPConnection('127.0.0.1', info['port'], timeout=timeout)
        conn.request('GET', '/api/v1/health',
                     headers={'Authorization': 'Bearer ' + info['token'],
                              'Host': '127.0.0.1:%d' % info['port']})
        ok = conn.getresponse().status == 200
        conn.close()
        return ok
    except (OSError, http.client.HTTPException):
        return False


def open_browser(url):
    import webbrowser
    webbrowser.open(url)


# ---------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------

class Backend:
    """One running backend: engine + SSE hub + HTTP server + runtime.json.
    ``start()`` returns once the socket is listening; ``wait()`` blocks
    until shutdown is requested; ``close()`` tears everything down."""

    def __init__(self, opts, providers=None, demo_factory=None, scenarios=(),
                 heartbeat=None, tick=None, engine_kwargs=None):
        from omniwatch import engine as engine_mod
        from omniwatch import persist, security, sse
        self.opts = opts
        self.done = threading.Event()
        self.reason = ''
        if providers is None:
            providers, demo_factory, scenarios = build_providers(opts)
        self.providers = providers
        self.demo = bool(opts.demo or opts.providers_factory)
        self.config_dir, self._temp_dir = resolve_config_dir(opts)
        os.makedirs(self.config_dir, exist_ok=True)
        self.runtime_path = os.path.join(self.config_dir, 'runtime.json')
        ultrawatch = None
        if self.demo:   # never import the user's real Ultrawatch labels into a demo
            ultrawatch = os.path.join(self.config_dir, 'no-ultrawatch-migration')
        store = persist.StateStore(path=os.path.join(self.config_dir, 'state.json'),
                                   ultrawatch_path=ultrawatch)
        if self.demo:
            engine_mod.apply_seed_state(store, getattr(providers, 'demo', None))
        self.hub = sse.Hub(heartbeat=heartbeat) if heartbeat else sse.Hub()
        kwargs = dict(demo=self.demo, config_dir=self.config_dir,
                      log_path=opts.log_file or '')
        if self.demo:
            kwargs.update(
                sync=True,
                autostep=None if opts.demo_clock is not None else 2.0,
                demo_factory=demo_factory,
                demo_options={'scenarios': scenarios,
                              'factory_kwargs': {'seed': opts.demo_seed,
                                                 'frozen_clock': opts.demo_clock}})
        if tick is not None:
            kwargs['tick'] = tick
        kwargs.update(engine_kwargs or {})
        self.engine = engine_mod.Engine(providers, store, self.hub, **kwargs)
        self.token = security.new_token()
        self.server = None

    def request_shutdown(self, reason='shutdown requested'):
        if not self.done.is_set():
            self.reason = reason
            self.done.set()

    def start(self):
        from omniwatch import runtime
        from omniwatch.server import OmniwatchServer
        if self.demo:
            self.engine.sync_poll()
            self.engine.apply_demo_seed()
            self.engine.pump()
        self.server = OmniwatchServer(self.engine, self.hub, self.token,
                                      port=self.opts.port, demo=self.demo,
                                      on_shutdown=self.request_shutdown)
        self.engine.start()
        self.server.start()
        runtime.write(self.runtime_path, {
            'port': self.port, 'token': self.token, 'pid': os.getpid(),
            'version': __version__, 'started_at': time.time(), 'demo': self.demo})
        return self

    @property
    def port(self):
        return self.server.port

    def ready_line(self):
        return json.dumps({'event': 'ready', 'port': self.port, 'token': self.token,
                           'pid': os.getpid(), 'version': __version__,
                           'demo': self.demo}, separators=(',', ':'))

    def wait(self, poll=0.5):
        while not self.done.wait(poll):
            pass
        return self.reason

    def close(self):
        from omniwatch import runtime
        self.engine.stop()
        self.hub.close()
        if self.server is not None:
            self.server.stop()
        runtime.remove(self.runtime_path)
        if self._temp_dir:
            shutil.rmtree(self.config_dir, ignore_errors=True)


def serve(opts, stdout=None, stderr=None, install_signals=True, watch_stdin_fd=0,
          redirect_fd2=True, backend_factory=Backend):
    """Run the backend until shutdown. Returns the process exit status."""
    from omniwatch import config, logs
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    if opts.providers_factory or opts.demo:
        os.environ['OMNIWATCH_DEMO'] = '1'

    log_file = opts.log_file
    if not log_file and opts.browser and not opts.ready_json:
        log_file = config.BACKEND_LOG_PATH
        opts.log_file = log_file
    logs.setup(log_file, redirect_fd2=redirect_fd2, stream=stderr)

    try:
        backend = backend_factory(opts)
        backend.start()
    except (CliError, OSError, ValueError) as e:
        logs.log.error('startup failed: %s', e)
        stderr.write('omniwatch: %s\n' % e)
        stderr.flush()
        logs.teardown()
        return 1

    # Handlers before the ready line: a supervisor may SIGTERM right after
    # the handshake, and the default action would skip the clean exit.
    old_handlers = {}
    if install_signals and threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGTERM, signal.SIGINT):
            old_handlers[sig] = signal.signal(
                sig, lambda signum, frame: backend.request_shutdown('signal %d' % signum))

    logs.log.info('listening on 127.0.0.1:%d (pid %d, demo=%s, config %s)',
                  backend.port, os.getpid(), backend.demo, backend.config_dir)
    url = auth_url(backend.port, backend.token)
    if opts.ready_json:
        stdout.write(backend.ready_line() + '\n')
    else:
        stdout.write('Omniwatch %s on http://127.0.0.1:%d/ — open %s (Ctrl-C quits)\n'
                     % (__version__, backend.port, url))
    stdout.flush()

    if opts.parent_pid:
        threading.Thread(target=watch_parent, name='parent-watch', daemon=True,
                         args=(opts.parent_pid, backend.done, backend.request_shutdown)).start()
    if watch_stdin_fd is not None and (opts.ready_json or opts.parent_pid) and \
            stdin_is_pipe(watch_stdin_fd):
        threading.Thread(target=watch_stdin, name='stdin-watch', daemon=True,
                         args=(backend.request_shutdown, watch_stdin_fd)).start()

    if opts.browser and not opts.no_open:
        try:
            open_browser(url)
        except Exception as e:
            logs.log.warning('could not open a browser: %s', e)

    try:
        reason = backend.wait()
        logs.log.info('shutting down: %s', reason)
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        backend.close()
        logs.teardown()
    return 0


# ---------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------

def doctor(opts, stdout=None):
    from omniwatch import config, engine as engine_mod, runtime
    stdout = stdout or sys.stdout
    providers = build_providers(opts)[0]
    clock = providers.clock
    snap = engine_mod.poll_iterm(providers, clock.time())
    if snap.not_running:
        iterm_status, automation, detail = 'not_running', 'unknown', 'iTerm2 is not running'
    elif snap.error.startswith(engine_mod.NOT_AUTHORIZED_PREFIX):
        iterm_status, automation = 'not_authorized', 'denied'
        detail = ('Automation permission denied — System Settings › Privacy & Security › '
                  'Automation: allow iTerm2')
    elif snap.error:
        iterm_status, automation, detail = 'error', 'unknown', snap.error
    else:
        iterm_status, automation = 'ok', 'ok'
        detail = '%d session(s)' % len(snap.sessions)

    def creds(provider):
        fn = getattr(provider, 'has_credentials', None)
        try:
            value = fn() if fn else None
        except Exception:
            value = None
        return value if isinstance(value, bool) else None

    config_dir = resolve_config_dir(opts)[0] if not opts.demo else '(demo: temporary)'
    running = runtime.read_live(os.path.join(resolve_config_dir(opts)[0], 'runtime.json')) \
        if not opts.demo else None
    report = {
        'version': __version__,
        'python': {'path': sys.executable, 'version': sys.version.split()[0]},
        'iterm2_package': engine_mod.iterm2_package_available(),
        'iterm': {'status': iterm_status, 'detail': detail},
        'automation': automation,
        'claude_credentials': creds(providers.usage_claude),
        'codex_credentials': creds(providers.usage_codex),
        'config_dir': config_dir,
        'log_path': config.BACKEND_LOG_PATH,
        'running_backend': ({'pid': running['pid'], 'port': running['port']}
                            if running else None),
    }
    if opts.json:
        stdout.write(json.dumps(report, indent=2) + '\n')
        return 0

    def yn(v):
        return {True: 'yes', False: 'no', None: 'unknown'}[v]

    lines = [
        'Omniwatch %s' % __version__,
        'python           %s (%s)' % (report['python']['path'], report['python']['version']),
        'iterm2 package   %s%s' % (yn(report['iterm2_package']),
                                   '' if report['iterm2_package'] else
                                   ' — tab colors need it: make install-colors'),
        'iTerm2           %s — %s' % (iterm_status, detail),
        'automation       %s' % automation,
        'Claude creds     %s' % yn(report['claude_credentials']),
        'Codex creds      %s' % yn(report['codex_credentials']),
        'config dir       %s' % config_dir,
        'log file         %s' % report['log_path'],
        'running backend  %s' % ('pid %(pid)d on port %(port)d' % report['running_backend']
                                 if running else 'none'),
    ]
    stdout.write('\n'.join(lines) + '\n')
    return 0


# ---------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------

def main(argv=None, stdout=None, stderr=None, **serve_kwargs):
    argv = list(sys.argv[1:] if argv is None else argv)
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    command = argv[0] if argv and argv[0] in COMMANDS else None
    rest = argv[1:] if command else argv
    try:
        if command == 'doctor':
            return doctor(doctor_parser().parse_args(rest), stdout=stdout)
        prog = 'omniwatch %s' % command if command else 'omniwatch'
        opts = serve_parser(prog).parse_args(rest)
        if opts.version:
            stdout.write('omniwatch %s\n' % __version__)
            return 0
        if command == 'demo':
            opts.demo = True
            opts.browser = True
        elif command is None:
            if not rest and app_installed():
                from omniwatch.providers import RealOpener
                RealOpener().open_app('Omniwatch')
                return 0
            opts.browser = True
            if not opts.demo and not opts.providers_factory and reuse_running(opts, stdout):
                return 0
        return serve(opts, stdout=stdout, stderr=stderr, **serve_kwargs)
    except CliError as e:
        stderr.write('omniwatch: %s\n' % e)
        return 2


def reuse_running(opts, stdout):
    """--browser with a healthy backend already running: open it instead
    of starting a second one (runtime.json, §4.5)."""
    from omniwatch import runtime
    config_dir = resolve_config_dir(opts)[0]
    info = runtime.read_live(os.path.join(config_dir, 'runtime.json'))
    if not info or not backend_healthy(info):
        return False
    url = auth_url(info['port'], info['token'])
    stdout.write('Omniwatch is already running (pid %d): %s\n' % (info['pid'], url))
    if not opts.no_open:
        open_browser(url)
    return True

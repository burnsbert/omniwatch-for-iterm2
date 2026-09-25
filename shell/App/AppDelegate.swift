import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    let options: LaunchOptions
    let model = ShellModel()
    let log: ShellLog
    let logsDir = Paths.logsDir()
    private(set) var supervisor: BackendSupervisor!
    private var sse: EventStreamClient?
    private var api: BackendAPI?
    private var windowController: WindowController!
    private var statusItem: StatusItemController!
    private let notifications = NotificationController()
    private var visibleUids = Set<String>()
    private var lastGotoUid: String?
    /// A notification action that arrived before the backend was up (app launched by the click).
    private var pendingGotoUid: String?
    private var quitting = false
    private(set) var backendFailure: String?
    private(set) var toggleHotKey: HotKeySpec?
    private(set) var nextWaitingHotKey: HotKeySpec?
    weak var keepOnTopMenuItem: NSMenuItem?
    private var themeFromWeb = false
    private var demoMode: Bool

    init(options: LaunchOptions) {
        self.options = options
        demoMode = options.demo
        log = ShellLog(url: Paths.logsDir().appendingPathComponent("shell.log"))
        super.init()
    }

    var keepOnTop: Bool { windowController?.keepOnTop ?? false }

    // MARK: lifecycle

    func applicationWillFinishLaunching(_ notification: Notification) {
        // The notification delegate must be set before launch completes so a click that
        // launched the app is still delivered.
        notifications.log = { [weak self] in self?.log.log($0) }
        notifications.onGoto = { [weak self] uid in self?.gotoSession(uid) }
        notifications.onShow = { [weak self] uid in self?.showSession(uid) }
        notifications.clickBehavior = { [weak self] in self?.model.prefs.notifications.click ?? "goto" }
        notifications.setup()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        log.log("Omniwatch \(AppInfo.version) starting (pid \(ProcessInfo.processInfo.processIdentifier))")
        NSApp.mainMenu = Menus.build(app: self)

        windowController = WindowController()
        windowController.onRetry = { [weak self] in self?.retryBackend() }
        windowController.onOpenLog = { [weak self] in self?.openLog() }
        windowController.bridge.onMessage = { [weak self] m in self?.handleBridge(m) }
        statusItem = StatusItemController(app: self)

        registerHotKeys()
        startSupervisor()
        windowController.show()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// §4.7 step 5: POST /shutdown → 2 s → SIGTERM → 2 s → SIGKILL, then quit.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateNow }
        quitting = true
        log.log("quitting: stopping backend")
        sse?.stop()
        HotKeyCenter.shared.unregisterAll()
        var replied = false
        let reply = { [weak self] in
            // Always async: the reply must not happen before we return .terminateLater.
            DispatchQueue.main.async {
                guard !replied else { return }
                replied = true
                self?.log.log("backend stopped; bye")
                self?.log.flush()
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        supervisor.stop(requestShutdown: { ready in
            let api = BackendAPI(ready: ready)
            api.send(api.shutdownRequest())
        }, completion: reply)
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: reply) // never hang the quit
        return .terminateLater
    }

    // MARK: backend

    private func startSupervisor() {
        var env = ProcessInfo.processInfo.environment
        if demoMode { env["OMNIWATCH_DEMO"] = "1" } else { env.removeValue(forKey: "OMNIWATCH_DEMO") }
        let logFile = logsDir.appendingPathComponent("backend.log").path
        let demo = demoMode
        let opts = options
        supervisor = BackendSupervisor(makeLaunch: { try opts.makeLaunch(environment: env, logFile: logFile, demo: demo) },
                                       environment: env)
        supervisor.log = { [weak self] in self?.log.log($0) }
        supervisor.stderrHandle = { [weak self] in self?.log.appendingHandle() }
        supervisor.onStatus = { [weak self] s in self?.backendStatusChanged(s) }
        supervisor.start()
    }

    /// Stops the current backend (clean shutdown) and starts a new one, e.g. in demo mode.
    func restartBackend(demo: Bool) {
        log.log("restarting backend (demo: \(demo))")
        disconnectEvents()
        windowController.showStarting(demo ? "Starting the demo…" : "Restarting Omniwatch…")
        supervisor.onStatus = nil
        supervisor.stop(requestShutdown: { ready in
            let api = BackendAPI(ready: ready)
            api.send(api.shutdownRequest())
        }, completion: { [weak self] in
            guard let self = self, !self.quitting else { return }
            self.demoMode = demo
            self.startSupervisor()
        })
    }

    func retryBackend() {
        backendFailure = nil
        windowController.showStarting("Starting Omniwatch…")
        supervisor.retry()
    }

    private func backendStatusChanged(_ s: BackendSupervisor.Status) {
        switch s {
        case .running(let r):
            backendFailure = nil
            api = BackendAPI(ready: r)
            windowController.load(ready: r)
            connectEvents(r)
            if let uid = pendingGotoUid {
                pendingGotoUid = nil
                gotoSession(uid)
            }
        case .restarting(let after, let reason):
            disconnectEvents()
            windowController.showStarting("Restarting Omniwatch backend in \(Int(after.rounded(.up))) s…")
            log.log("restarting after \(after)s: \(reason)")
        case .failed(let reason):
            disconnectEvents()
            backendFailure = reason
            windowController.showError(reason, logPath: logsDir.appendingPathComponent("backend.log").path)
        case .starting, .idle, .stopping, .stopped:
            break
        }
    }

    private func connectEvents(_ r: ReadyLine) {
        sse?.stop()
        let c = EventStreamClient(ready: r)
        c.onEvent = { [weak self] e in self?.handleEvent(e) }
        c.onStatus = { [weak self] st in
            guard let self = self else { return }
            switch st {
            case .open: self.statusItem.update(waiting: self.model.summary.waiting, connected: true)
            case .disconnected(let why): self.log.log("SSE disconnected: \(why)")
            case .unauthorized: self.log.log("SSE unauthorized (stale token?)")
            case .connecting: break
            }
        }
        sse = c
        c.start()
    }

    private func disconnectEvents() {
        sse?.stop()
        sse = nil
        api = nil
        statusItem.update(waiting: 0, connected: false)
        NSApp.dockTile.badgeLabel = nil
    }

    // MARK: SSE → native surfaces

    private func handleEvent(_ e: SSEEvent) {
        for fx in model.apply(e) {
            switch fx {
            case .summaryChanged(let s):
                statusItem.update(waiting: s.waiting, connected: true)
                let badge = BadgeFormatter.badge(s.waiting)
                NSApp.dockTile.badgeLabel = badge.isEmpty ? nil : badge
                windowController.setWaiting(s.waiting)
                notifications.prune(waiting: Set(model.waitingSessions.map { $0.uid }))
            case .prefsChanged(let p):
                windowController.setKeepOnTop(p.keepOnTop)
                keepOnTopMenuItem?.state = p.keepOnTop ? .on : .off
                if !themeFromWeb { applyTheme(p.theme) }
            case .becameWaiting(let t):
                attention(t)
            case .actionFailed(let kind, let detail):
                log.log("action \(kind) failed: \(detail)")
            case .hello(let version, let demo):
                log.log("SSE hello: backend \(version) demo \(demo)")
            }
        }
    }

    private func attention(_ t: Transition) {
        let session = model.session(t.uid)
        if NotificationPolicy.shouldPlaySound(t, prefs: model.prefs, session: session) {
            NSSound(named: NSSound.Name("Glass"))?.play()
        }
        let focus = FocusContext(appActive: NSApp.isActive, windowKey: windowController.window.isKeyWindow,
                                 visibleUids: visibleUids)
        switch NotificationPolicy.decide(t, prefs: model.prefs, focus: focus, session: session,
                                         screenText: model.screens[t.uid]) {
        case .post(let title, let body):
            notifications.post(uid: t.uid, title: title, body: body)
        case .suppress(let why):
            log.log("notification for \(t.uid.prefix(8)) suppressed: \(why)")
        }
    }

    private func applyTheme(_ theme: String) {
        switch theme {
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        default: NSApp.appearance = nil
        }
    }

    // MARK: bridge (web → native)

    private func handleBridge(_ m: BridgeMessage) {
        switch m {
        case .ready:
            notifications.refreshStatus { [weak self] s in
                self?.windowController.bridge.nativeEvent(["type": "notifyPermission", "status": s])
            }
        case .theme(let v):
            themeFromWeb = true
            applyTheme(v)
        case .keepOnTop(let on):
            windowController.setKeepOnTop(on)
            keepOnTopMenuItem?.state = on ? .on : .off
        case .notifyPermission:
            notifications.requestPermission { [weak self] status, error in
                var ev: [String: Any] = ["type": "notifyPermission", "status": status]
                if let e = error { ev["error"] = e }
                self?.windowController.bridge.nativeEvent(ev)
            }
        case .visible(let uids):
            visibleUids = Set(uids)
        case .closeWindow:
            windowController.window.performClose(nil)
        case .restartBackend(let demo):
            restartBackend(demo: demo)
        case .unknown(let t):
            log.log("bridge: unknown message type \(t)")
        }
    }

    // MARK: commands (menus, status item, hotkeys, notifications)

    func sendCommand(_ c: NativeCommand, args: [String: Any]? = nil) {
        windowController.bridge.command(c, args: args)
    }

    func showMainWindow() { windowController.show() }

    func showSession(_ uid: String) {
        windowController.show()
        sendCommand(.selectSession, args: ["uid": uid])
    }

    func gotoSession(_ uid: String) {
        lastGotoUid = uid
        guard let api = api else { pendingGotoUid = uid; return }
        api.send(api.gotoRequest(uid: uid)) { [weak self] status, _, err in
            if status != 202 { self?.log.log("goto \(uid.prefix(8)) → HTTP \(status) \(err?.localizedDescription ?? "")") }
        }
    }

    func gotoNextWaiting() {
        guard let s = model.nextWaiting(after: lastGotoUid) else { NSSound.beep(); return }
        gotoSession(s.uid)
    }

    /// Native toggle → PATCH prefs so the web UI and the persisted pref stay in sync; applied
    /// immediately here too, and re-applied when the `prefs` event echoes back.
    func toggleKeepOnTop() {
        let on = !keepOnTop
        windowController.setKeepOnTop(on)
        keepOnTopMenuItem?.state = on ? .on : .off
        if let api = api { api.send(api.patchPrefsRequest(["keep_on_top": on])) }
    }

    func openLog() { NSWorkspace.shared.open(logsDir.appendingPathComponent("backend.log")) }
    func openLogsFolder() { NSWorkspace.shared.open(logsDir) }

    private func registerHotKeys() {
        let cfg = ShellConfig.load(configDir: Paths.configDir(environment: ProcessInfo.processInfo.environment))
        if let t = HotKeySpec.parse(cfg.toggleHotKey) {
            if HotKeyCenter.shared.register(t, handler: { [weak self] in self?.windowController.toggle() }) {
                toggleHotKey = t
            } else {
                log.log("hotkey \(t.display) unavailable (taken by another app?)")
            }
        }
        if let n = HotKeySpec.parse(cfg.nextWaitingHotKey) {
            if HotKeyCenter.shared.register(n, handler: { [weak self] in self?.gotoNextWaiting() }) {
                nextWaitingHotKey = n
            } else {
                log.log("hotkey \(n.display) unavailable (taken by another app?)")
            }
        }
    }
}

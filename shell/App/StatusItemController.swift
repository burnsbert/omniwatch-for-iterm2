import AppKit

/// Menu-bar item (§2.8 step 4): `◉ 2` in amber when anyone is waiting, with a dropdown of
/// waiting sessions (click = go to it in iTerm2; ⌥-click = show it in Omniwatch).
final class StatusItemController: NSObject, NSMenuDelegate {
    private let item: NSStatusItem
    private let menu = NSMenu()
    weak var app: AppDelegate?

    init(app: AppDelegate) {
        self.app = app
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        item.behavior = []
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        update(waiting: 0, connected: false)
    }

    func update(waiting: Int, connected: Bool) {
        guard let button = item.button else { return }
        let title = connected ? BadgeFormatter.menuBarTitle(waiting) : "◌"
        var attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: waiting > 0 ? .semibold : .regular),
        ]
        if waiting > 0 && connected { attrs[.foregroundColor] = NSColor.systemOrange }
        button.attributedTitle = NSAttributedString(string: title, attributes: attrs)
        button.toolTip = connected ? BadgeFormatter.windowTitle(waiting) : "Omniwatch — backend not running"
        button.setAccessibilityLabel(connected ? BadgeFormatter.menuHeader(waiting) : "Omniwatch backend not running")
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let app = app else { return }
        let waiting = app.model.waitingSessions
        if let failure = app.backendFailure {
            menu.addItem(disabled("Backend stopped: \(failure)"))
            menu.addItem(ActionMenuItem("Retry Backend") { [weak app] in app?.retryBackend() })
        } else {
            menu.addItem(disabled(BadgeFormatter.menuHeader(waiting.count)))
        }
        let now = app.model.serverNow() // demo mode runs on the demo clock (API.md §5)
        for s in waiting.prefix(20) {
            var label = s.bestTitle
            if !s.tabLabel.isEmpty { label += " · tab \(s.tabLabel)" }
            if let since = s.stateSince { label += " · wait \(BadgeFormatter.age(now - since))" }
            if s.muted { label += " (muted)" }
            let uid = s.uid
            let goto = ActionMenuItem("◉ " + label) { [weak app] in app?.gotoSession(uid) }
            goto.toolTip = "Go to this session in iTerm2 (⌥: show in Omniwatch)"
            menu.addItem(goto)
            let show = ActionMenuItem("Show “\(s.bestTitle)” in Omniwatch") { [weak app] in app?.showSession(uid) }
            show.keyEquivalentModifierMask = .option
            show.isAlternate = true
            menu.addItem(show)
        }
        if waiting.count > 20 { menu.addItem(disabled("…and \(waiting.count - 20) more")) }
        let stalled = app.model.sessions.filter { $0.stalled }
        if !stalled.isEmpty {
            menu.addItem(.separator())
            menu.addItem(disabled(stalled.count == 1 ? "1 session may be stalled" : "\(stalled.count) sessions may be stalled"))
            for s in stalled.prefix(10) {
                var label = s.bestTitle
                if let since = s.stalledSince { label += " · quiet \(BadgeFormatter.age(now - since))" }
                let uid = s.uid
                menu.addItem(ActionMenuItem("⏸ " + label) { [weak app] in app?.gotoSession(uid) })
            }
        }
        menu.addItem(.separator())
        let next = ActionMenuItem("Go to Next Waiting in iTerm2") { [weak app] in app?.gotoNextWaiting() }
        next.isEnabled = !waiting.isEmpty
        if let hk = app.nextWaitingHotKey { next.title += "  (\(hk.display))" }
        menu.addItem(next)
        let showTitle = app.toggleHotKey.map { "Show Omniwatch  (\($0.display))" } ?? "Show Omniwatch"
        menu.addItem(ActionMenuItem(showTitle) { [weak app] in app?.showMainWindow() })
        let top = ActionMenuItem("Keep Window on Top") { [weak app] in app?.toggleKeepOnTop() }
        top.state = app.keepOnTop ? .on : .off
        menu.addItem(top)
        let login = ActionMenuItem("Launch at Login") { [weak app] in
            guard let app = app else { return }
            app.setLaunchAtLogin(!app.launchAtLogin)
        }
        login.state = app.launchAtLogin ? .on : .off
        menu.addItem(login)
        let barOnly = ActionMenuItem("Menu Bar Only") { [weak app] in
            guard let app = app else { return }
            app.setMenuBarOnly(!app.menuBarOnly)
        }
        barOnly.state = app.menuBarOnly ? .on : .off
        menu.addItem(barOnly)
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Quit Omniwatch") { NSApp.terminate(nil) })
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }
}

/// NSMenuItem that runs a closure (keeps menus free of one-selector-per-command boilerplate).
final class ActionMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, key: String = "", modifiers: NSEvent.ModifierFlags = [.command], handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: key)
        target = self
        if !key.isEmpty { keyEquivalentModifierMask = modifiers }
    }

    required init(coder: NSCoder) { fatalError("not used") }

    @objc private func fire() { handler() }
}

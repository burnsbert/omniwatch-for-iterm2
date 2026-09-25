import AppKit

/// Main menu. Items that mirror web commands call `window.omniwatch.command(id)`; standard
/// Edit items go through the responder chain so text fields in the web view work.
enum Menus {
    static func build(app: AppDelegate) -> NSMenu {
        let main = NSMenu()
        func cmd(_ title: String, _ c: NativeCommand, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
            ActionMenuItem(title, key: key, modifiers: mods) { [weak app] in app?.sendCommand(c) }
        }
        func std(_ title: String, _ sel: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = m
            main.addItem(holder)
            return m
        }

        let launchAtLogin = ActionMenuItem("Launch at Login") { [weak app] in
            guard let app = app else { return }
            app.setLaunchAtLogin(!app.launchAtLogin)
        }
        let menuBarOnly = ActionMenuItem("Menu Bar Only (Hide Dock Icon)") { [weak app] in
            guard let app = app else { return }
            app.setMenuBarOnly(!app.menuBarOnly)
        }
        app.launchAtLoginMenuItem = launchAtLogin
        app.menuBarOnlyMenuItem = menuBarOnly
        _ = submenu("Omniwatch", [
            std("About Omniwatch", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            cmd("Settings…", .settingsOpen, ","),
            launchAtLogin,
            menuBarOnly,
            ActionMenuItem("Setup Guide…") { [weak app] in app?.showMainWindow(); app?.sendCommand(.onboardingOpen) },
            .separator(),
            std("Hide Omniwatch", #selector(NSApplication.hide(_:)), "h"),
            std("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            std("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            std("Quit Omniwatch", #selector(NSApplication.terminate(_:)), "q"),
        ])

        _ = submenu("Edit", [
            std("Undo", Selector(("undo:")), "z"),
            std("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            std("Cut", #selector(NSText.cut(_:)), "x"),
            std("Copy", #selector(NSText.copy(_:)), "c"),
            std("Paste", #selector(NSText.paste(_:)), "v"),
            std("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            cmd("Filter Sessions…", .filterFocus, "f"),
        ])

        let keepOnTop = ActionMenuItem("Keep Window on Top", key: "t", modifiers: [.command, .option]) { [weak app] in
            app?.toggleKeepOnTop()
        }
        app.keepOnTopMenuItem = keepOnTop
        _ = submenu("View", [
            cmd("Split", .viewSplit, "1"),
            cmd("List", .viewList, "2"),
            cmd("Grid", .viewGrid, "3"),
            .separator(),
            cmd("Usage", .usageOpen, "u"),
            cmd("Command Palette…", .paletteOpen, "k"),
            cmd("Refresh", .refresh, "r"),
            .separator(),
            cmd("Bigger Text", .fontIncrease, "="),
            cmd("Smaller Text", .fontDecrease, "-"),
            cmd("Actual Size", .fontReset, "0"),
            .separator(),
            keepOnTop,
            std("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])

        _ = submenu("Session", [
            cmd("Select Next Waiting", .nextWaiting),
            ActionMenuItem("Go to Next Waiting in iTerm2") { [weak app] in app?.gotoNextWaiting() },
        ])

        let window = submenu("Window", [
            std("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            std("Zoom", #selector(NSWindow.performZoom(_:)), ""),
            std("Close", #selector(NSWindow.performClose(_:)), "w"),
            .separator(),
            ActionMenuItem("Omniwatch") { [weak app] in app?.showMainWindow() },
            .separator(),
            std("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), ""),
        ])
        NSApp.windowsMenu = window

        let help = submenu("Help", [
            cmd("Keyboard Shortcuts", .shortcutsOpen, "/"),
            ActionMenuItem("Open Logs Folder") { [weak app] in app?.openLogsFolder() },
        ])
        NSApp.helpMenu = help
        return main
    }
}

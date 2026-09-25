import Foundation

/// Web → native messages: `window.webkit.messageHandlers.omniwatch.postMessage({type: …})` (§4.7 step 6).
public enum BridgeMessage: Equatable {
    /// Page booted; native replies with `nativeEvent({type:"notifyPermission", status})`.
    case ready
    /// Resolved theme so `NSApp.appearance` matches: "dark" | "light" | "system".
    case theme(String)
    case keepOnTop(Bool)
    /// Ask macOS for notification permission (onboarding step 3 / settings).
    case notifyPermission
    /// Session uids currently on screen (preview, zoom, visible grid tiles), for suppression.
    case visible([String])
    /// `q` (P-73): close the window; the app stays in the menu bar.
    case closeWindow
    /// Onboarding "Try the demo" (§2.10): restart the supervised backend with/without `--demo`.
    case restartBackend(demo: Bool)
    /// Settings toggles for native-only options; native answers with `nativeSettings`.
    case launchAtLogin(Bool)
    case menuBarOnly(Bool)
    case unknown(String)

    public static func parse(_ body: Any) -> BridgeMessage? {
        guard let d = body as? [String: Any], let type = d["type"] as? String else { return nil }
        switch type {
        case "ready": return .ready
        case "theme":
            guard let v = d["value"] as? String, ["dark", "light", "system"].contains(v) else { return nil }
            return .theme(v)
        case "keepOnTop":
            guard let n = d["value"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
            return .keepOnTop(n.boolValue)
        case "notifyPermission": return .notifyPermission
        case "visible":
            guard let a = d["uids"] as? [Any] else { return nil }
            return .visible(a.compactMap { $0 as? String })
        case "closeWindow": return .closeWindow
        case "launchAtLogin", "menuBarOnly":
            guard let n = d["value"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
            return type == "launchAtLogin" ? .launchAtLogin(n.boolValue) : .menuBarOnly(n.boolValue)
        case "restartBackend":
            let n = d["demo"] as? NSNumber
            return .restartBackend(demo: n.map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false)
        default: return .unknown(type)
        }
    }
}

/// Native → web command ids, sent as `window.omniwatch.command(id[, args])`. Menu items,
/// hotkeys, and notification actions use these; the web keymap must register the same ids.
public enum NativeCommand: String, CaseIterable {
    case viewSplit = "view.split"
    case viewList = "view.list"
    case viewGrid = "view.grid"
    case usageOpen = "usage.open"
    case paletteOpen = "palette.open"
    case settingsOpen = "settings.open"
    case shortcutsOpen = "shortcuts.open"
    case onboardingOpen = "onboarding.open"
    case filterFocus = "filter.focus"
    case refresh = "refresh"
    case nextWaiting = "session.nextWaiting"
    /// args: `{uid}` — select (and visit) that session; used by "Show in Omniwatch".
    case selectSession = "session.select"
    case fontIncrease = "font.increase"
    case fontDecrease = "font.decrease"
    case fontReset = "font.reset"
}

public enum BridgeJS {
    /// JSON-encodes a value for inlining in JS (JSON is a JS subset once U+2028/2029 are escaped).
    public static func literal(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject([value]),
              let d = try? JSONSerialization.data(withJSONObject: [value], options: [.sortedKeys]),
              var s = String(data: d, encoding: .utf8) else { return "null" }
        s = String(s.dropFirst().dropLast()) // strip the wrapping array
        return s.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    /// Guarded so it's a no-op before the page's bridge is installed.
    public static func command(_ id: String, args: [String: Any]? = nil) -> String {
        let a = args.map { ", " + literal($0) } ?? ""
        return "window.omniwatch && window.omniwatch.command && window.omniwatch.command(\(literal(id))\(a));"
    }

    public static func command(_ c: NativeCommand, args: [String: Any]? = nil) -> String {
        command(c.rawValue, args: args)
    }

    /// `nativeEvent({type:"nativeSettings", launchAtLogin, menuBarOnly, launchAtLoginError?})`.
    public static func nativeSettings(launchAtLogin: Bool, menuBarOnly: Bool, error: String? = nil) -> [String: Any] {
        var e: [String: Any] = ["type": "nativeSettings", "launchAtLogin": launchAtLogin, "menuBarOnly": menuBarOnly]
        if let err = error { e["launchAtLoginError"] = err }
        return e
    }

    public static func nativeEvent(_ event: [String: Any]) -> String {
        "window.omniwatch && window.omniwatch.nativeEvent && window.omniwatch.nativeEvent(\(literal(event)));"
    }

    /// Injected at document start: lets `native.js` detect the app.
    public static func bootstrap(version: String) -> String {
        "window.__OMNIWATCH_NATIVE__ = Object.freeze(\(literal(["platform": "macos", "app": "Omniwatch", "version": version, "bridge": 1] as [String: Any])));"
    }
}

/// WKWebView navigation rule (§4.7 step 6): stay on the backend origin; everything else is
/// handed to NSWorkspace (http(s), mailto, x-apple.systempreferences) or dropped.
public enum NavigationRule {
    public enum Decision: Equatable { case allow, openExternally, cancel }

    public static func decide(_ url: URL?, backendPort: Int?) -> Decision {
        guard let url = url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if scheme == "about" { return url.absoluteString == "about:blank" ? .allow : .cancel }
        if scheme == "http", let port = backendPort, url.port == port,
           let host = url.host?.lowercased(), host == "127.0.0.1" || host == "localhost" {
            return .allow
        }
        if ["http", "https", "mailto", "x-apple.systempreferences"].contains(scheme) { return .openExternally }
        return .cancel
    }
}

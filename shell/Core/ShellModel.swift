import Foundation

/// Side effects the AppKit layer should perform after an SSE event.
public enum ShellEffect: Equatable {
    case hello(version: String, demo: Bool)
    /// Waiting count / waiting list changed: update dock badge, menu-bar title, window title.
    case summaryChanged(Summary)
    case prefsChanged(Prefs)
    /// A session just transitioned to `waiting` (candidate for notification + sound).
    case becameWaiting(Transition)
    case actionFailed(kind: String, detail: String)
}

/// The native shell's view of backend state, driven purely by SSE events.
/// Pure (no AppKit), so it's unit-tested.
public final class ShellModel {
    public private(set) var summary = Summary()
    public private(set) var sessions: [SessionInfo] = []
    public private(set) var prefs = Prefs()
    public private(set) var hasState = false
    public private(set) var demo = false
    /// Latest raw screen text per uid (for the notification body fallback).
    public private(set) var screens: [String: String] = [:]
    public private(set) var decodeErrors = 0

    public init() {}

    @discardableResult
    public func apply(_ event: SSEEvent) -> [ShellEffect] {
        do {
            return try applyThrowing(event)
        } catch {
            decodeErrors += 1
            return []
        }
    }

    private func applyThrowing(_ event: SSEEvent) throws -> [ShellEffect] {
        let dec = OmniwatchJSON.decoder()
        let data = Data(event.data.utf8)
        switch event.type {
        case "hello":
            let h = try dec.decode(Hello.self, from: data)
            demo = h.demo
            return [.hello(version: h.version, demo: h.demo)]
        case "state":
            let s = try dec.decode(StateDoc.self, from: data)
            let oldPrefs = prefs, hadState = hasState, oldSummary = summary
            sessions = s.sessions
            summary = s.summary
            prefs = s.prefs
            demo = s.demo
            screens = s.screens.mapValues { $0.text }
            hasState = true
            var fx: [ShellEffect] = []
            if !hadState || oldSummary != summary { fx.append(.summaryChanged(summary)) }
            if !hadState || oldPrefs != prefs { fx.append(.prefsChanged(prefs)) }
            return fx
        case "sessions":
            let u = try dec.decode(SessionsUpdate.self, from: data)
            let old = summary
            sessions = u.sessions
            summary = u.summary
            let live = Set(u.sessions.map { $0.uid })
            screens = screens.filter { live.contains($0.key) }
            return old != summary ? [.summaryChanged(summary)] : []
        case "screens":
            let u = try dec.decode(ScreensUpdate.self, from: data)
            for (uid, s) in u.screens { screens[uid] = s.text }
            for uid in u.removed { screens.removeValue(forKey: uid) }
            return []
        case "prefs":
            let u = try dec.decode(PrefsUpdate.self, from: data)
            guard u.prefs != prefs else { return [] }
            prefs = u.prefs
            return [.prefsChanged(prefs)]
        case "transition":
            let t = try dec.decode(Transition.self, from: data)
            return t.to == "waiting" && t.from != "waiting" ? [.becameWaiting(t)] : []
        case "action":
            let a = try dec.decode(ActionResult.self, from: data)
            return a.ok ? [] : [.actionFailed(kind: a.kind, detail: a.detail)]
        default:
            return [] // usage, toast, quota, capabilities: the web UI handles these
        }
    }

    /// Sessions currently waiting, longest-waiting first (P-58 order), for the menu dropdown.
    public var waitingSessions: [SessionInfo] {
        let w = sessions.filter { $0.state == "waiting" }
        return w.enumerated().sorted { a, b in
            let sa = a.element.stateSince ?? .greatestFiniteMagnitude
            let sb = b.element.stateSince ?? .greatestFiniteMagnitude
            return sa != sb ? sa < sb : a.offset < b.offset
        }.map { $0.element }
    }

    public func session(_ uid: String) -> SessionInfo? { sessions.first { $0.uid == uid } }

    /// "Go to next waiting in iTerm2": the longest-waiting session after `lastUid` in the
    /// waiting order, wrapping around; the first one if `lastUid` isn't waiting anymore.
    public func nextWaiting(after lastUid: String?) -> SessionInfo? {
        let w = waitingSessions
        guard !w.isEmpty else { return nil }
        if let last = lastUid, let i = w.firstIndex(where: { $0.uid == last }) {
            return w[(i + 1) % w.count]
        }
        return w[0]
    }
}

/// Where the user is looking, as far as notification suppression is concerned.
public struct FocusContext: Equatable {
    public var appActive: Bool
    public var windowKey: Bool
    /// Session uids the web UI reports as visible (bridge message `visible`).
    public var visibleUids: Set<String>

    public init(appActive: Bool, windowKey: Bool, visibleUids: Set<String>) {
        self.appActive = appActive; self.windowKey = windowKey; self.visibleUids = visibleUids
    }
}

public enum NotificationDecision: Equatable {
    case post(title: String, body: String)
    case suppress(String)
}

public enum NotificationPolicy {
    /// §2.8 step 2: notify on → WAITING unless notifications are off, the session is muted,
    /// or Omniwatch is the key window and that session is on screen.
    public static func decide(_ t: Transition, prefs: Prefs, focus: FocusContext,
                              session: SessionInfo?, screenText: String?) -> NotificationDecision {
        guard t.to == "waiting" else { return .suppress("not a waiting transition") }
        guard prefs.notifications.enabled else { return .suppress("notifications off") }
        if t.muted || (session?.muted ?? false) { return .suppress("muted") }
        if focus.appActive && focus.windowKey && focus.visibleUids.contains(t.uid) {
            return .suppress("visible")
        }
        return .post(title: "\(displayTitle(t, session: session)) needs you",
                     body: body(t, session: session, screenText: screenText))
    }

    public static func shouldPlaySound(_ t: Transition, prefs: Prefs, session: SessionInfo?) -> Bool {
        t.to == "waiting" && prefs.sound && !t.muted && !(session?.muted ?? false)
    }

    static func displayTitle(_ t: Transition, session: SessionInfo?) -> String {
        if !t.title.isEmpty { return t.title }
        if let s = session { return s.bestTitle }
        return String(t.uid.prefix(8))
    }

    static func body(_ t: Transition, session: SessionInfo?, screenText: String?) -> String {
        if let q = (t.prompt ?? session?.prompt)?.question?.trimmingCharacters(in: .whitespaces), !q.isEmpty {
            return q
        }
        if let text = screenText, let line = ScreenText.lastMeaningfulLine(text) { return line }
        return "Waiting for your input"
    }
}

extension ScreenText {
    static let chromeChars = CharacterSet(charactersIn: "─━═│┃║╭╮╰╯┌┐└┘├┤┬┴┼▔▁ \t")
    static let edgeChars = CharacterSet(charactersIn: "│┃║ \t")

    /// Last line of a screen worth putting in a notification: skips blank lines, box rules,
    /// bare prompts (`❯`, `>`), `⏵⏵` status lines, and `% remaining]` lines (P-45 chrome);
    /// strips box edges; caps at 200 characters.
    public static func lastMeaningfulLine(_ text: String) -> String? {
        let lines = text.split(omittingEmptySubsequences: false, whereSeparator: { $0.isNewline })
        for raw in lines.reversed() {
            let line = String(raw).trimmingCharacters(in: edgeChars)
            if line.isEmpty { continue }
            if line.unicodeScalars.allSatisfy({ chromeChars.contains($0) }) { continue }
            if line == "❯" || line == ">" || line == "›" { continue }
            if line.hasPrefix("⏵⏵") || line.contains("% remaining]") { continue }
            return line.count > 200 ? String(line.prefix(199)) + "…" : line
        }
        return nil
    }
}

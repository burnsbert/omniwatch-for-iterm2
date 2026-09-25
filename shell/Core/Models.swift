import Foundation

// The subset of the backend's JSON (§4.4.1, §4.4.2) that the native shell consumes.
// Decoding is deliberately tolerant: every field has a default so a backend that adds or
// omits fields degrades gracefully instead of breaking the badge/menu/notifications.

public struct Summary: Decodable, Equatable {
    public var tabs = 0
    public var agents = 0
    public var waiting = 0
    public var busy = 0
    /// Busy sessions whose screen hasn't changed for `prefs.stall_minutes` (P1 stall detection).
    public var stalled = 0
    public var waitingUids: [String] = []

    public init(tabs: Int = 0, agents: Int = 0, waiting: Int = 0, busy: Int = 0, stalled: Int = 0,
                waitingUids: [String] = []) {
        self.tabs = tabs; self.agents = agents; self.waiting = waiting; self.busy = busy
        self.stalled = stalled; self.waitingUids = waitingUids
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tabs = try c.decodeIfPresent(Int.self, forKey: .tabs) ?? 0
        agents = try c.decodeIfPresent(Int.self, forKey: .agents) ?? 0
        waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
        busy = try c.decodeIfPresent(Int.self, forKey: .busy) ?? 0
        stalled = try c.decodeIfPresent(Int.self, forKey: .stalled) ?? 0
        waitingUids = try c.decodeIfPresent([String].self, forKey: .waitingUids) ?? []
    }

    enum CodingKeys: String, CodingKey { case tabs, agents, waiting, busy, stalled, waitingUids }
}

public struct PromptOption: Decodable, Equatable {
    public var key: String
    public var label: String
    public var selected: Bool

    public init(key: String, label: String, selected: Bool = false) {
        self.key = key; self.label = label; self.selected = selected
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decodeIfPresent(String.self, forKey: .key) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        selected = try c.decodeIfPresent(Bool.self, forKey: .selected) ?? false
    }

    enum CodingKeys: String, CodingKey { case key, label, selected }
}

public struct Prompt: Decodable, Equatable {
    public var question: String?
    public var options: [PromptOption]
    public var freeText: Bool

    public init(question: String?, options: [PromptOption] = [], freeText: Bool = false) {
        self.question = question; self.options = options; self.freeText = freeText
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decodeIfPresent(String.self, forKey: .question)
        options = try c.decodeIfPresent([PromptOption].self, forKey: .options) ?? []
        freeText = try c.decodeIfPresent(Bool.self, forKey: .freeText) ?? false
    }

    enum CodingKeys: String, CodingKey { case question, options, freeText }
}

public struct SessionInfo: Decodable, Equatable {
    public var uid: String
    public var title: String
    public var displayName: String
    public var tabLabel: String
    public var pathDisplay: String
    public var agent: String?
    public var state: String?
    public var stateSince: Double?
    public var attention: Bool
    public var muted: Bool
    public var prompt: Prompt?
    public var stalled: Bool
    public var stalledSince: Double?

    public init(uid: String, title: String = "", displayName: String = "", tabLabel: String = "",
                pathDisplay: String = "", agent: String? = nil, state: String? = nil,
                stateSince: Double? = nil, attention: Bool = false, muted: Bool = false,
                prompt: Prompt? = nil, stalled: Bool = false, stalledSince: Double? = nil) {
        self.uid = uid; self.title = title; self.displayName = displayName; self.tabLabel = tabLabel
        self.pathDisplay = pathDisplay; self.agent = agent; self.state = state
        self.stateSince = stateSince; self.attention = attention; self.muted = muted
        self.prompt = prompt; self.stalled = stalled; self.stalledSince = stalledSince
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        uid = try c.decode(String.self, forKey: .uid)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        tabLabel = try c.decodeIfPresent(String.self, forKey: .tabLabel) ?? ""
        pathDisplay = try c.decodeIfPresent(String.self, forKey: .pathDisplay) ?? ""
        agent = try c.decodeIfPresent(String.self, forKey: .agent)
        state = try c.decodeIfPresent(String.self, forKey: .state)
        stateSince = try c.decodeIfPresent(Double.self, forKey: .stateSince)
        attention = try c.decodeIfPresent(Bool.self, forKey: .attention) ?? false
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        prompt = try c.decodeIfPresent(Prompt.self, forKey: .prompt)
        stalled = try c.decodeIfPresent(Bool.self, forKey: .stalled) ?? false
        stalledSince = try c.decodeIfPresent(Double.self, forKey: .stalledSince)
    }

    enum CodingKeys: String, CodingKey {
        case uid, title, displayName, tabLabel, pathDisplay, agent, state, stateSince
        case attention, muted, prompt, stalled, stalledSince
    }

    /// Best human title: backend `title` (P-24) → display name → path → uid prefix.
    public var bestTitle: String {
        for s in [title, displayName, pathDisplay] where !s.isEmpty { return s }
        return String(uid.prefix(8))
    }
}

public struct NotificationPrefs: Decodable, Equatable {
    public var enabled = true
    /// What a plain click on a notification does: "goto" (iTerm2) or "show" (Omniwatch).
    public var click = "goto"
    /// Tolerant: not in the backend's pref whitelist yet; absent = stall notifications on
    /// (`prefs.stall_minutes = 0` turns stall detection off entirely).
    public var stall = true

    public init(enabled: Bool = true, click: String = "goto", stall: Bool = true) {
        self.enabled = enabled; self.click = click; self.stall = stall
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        click = try c.decodeIfPresent(String.self, forKey: .click) ?? "goto"
        stall = try c.decodeIfPresent(Bool.self, forKey: .stall) ?? true
    }

    enum CodingKeys: String, CodingKey { case enabled, click, stall }
}

public struct Prefs: Decodable, Equatable {
    public var theme = "system"
    public var sound = false
    public var keepOnTop = false
    public var closeWindowOnQ = true
    public var notifications = NotificationPrefs()
    /// Minutes of busy + unchanged screen before a session counts as stalled; 0 = off.
    public var stallMinutes = 10

    public init(theme: String = "system", sound: Bool = false, keepOnTop: Bool = false,
                closeWindowOnQ: Bool = true, notifications: NotificationPrefs = NotificationPrefs(),
                stallMinutes: Int = 10) {
        self.theme = theme; self.sound = sound; self.keepOnTop = keepOnTop
        self.closeWindowOnQ = closeWindowOnQ; self.notifications = notifications
        self.stallMinutes = stallMinutes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        theme = try c.decodeIfPresent(String.self, forKey: .theme) ?? "system"
        sound = try c.decodeIfPresent(Bool.self, forKey: .sound) ?? false
        keepOnTop = try c.decodeIfPresent(Bool.self, forKey: .keepOnTop) ?? false
        closeWindowOnQ = try c.decodeIfPresent(Bool.self, forKey: .closeWindowOnQ) ?? true
        notifications = try c.decodeIfPresent(NotificationPrefs.self, forKey: .notifications) ?? NotificationPrefs()
        stallMinutes = try c.decodeIfPresent(Int.self, forKey: .stallMinutes) ?? 10
    }

    enum CodingKeys: String, CodingKey { case theme, sound, keepOnTop, closeWindowOnQ, notifications, stallMinutes }
}

public struct ScreenText: Decodable, Equatable {
    public var hash: String
    public var text: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hash = try c.decodeIfPresent(String.self, forKey: .hash) ?? ""
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
    }

    enum CodingKeys: String, CodingKey { case hash, text }
}

public struct Hello: Decodable, Equatable {
    public var version: String
    public var serverTime: Double
    public var demo: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? ""
        serverTime = try c.decodeIfPresent(Double.self, forKey: .serverTime) ?? 0
        demo = try c.decodeIfPresent(Bool.self, forKey: .demo) ?? false
    }

    enum CodingKeys: String, CodingKey { case version, serverTime, demo }
}

/// Full `state` event / `GET /api/v1/state` (only the parts the shell uses).
public struct StateDoc: Decodable {
    public var seq: Int
    public var serverTime: Double?
    public var demo: Bool
    public var summary: Summary
    public var sessions: [SessionInfo]
    public var screens: [String: ScreenText]
    public var prefs: Prefs

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
        serverTime = try c.decodeIfPresent(Double.self, forKey: .serverTime)
        demo = try c.decodeIfPresent(Bool.self, forKey: .demo) ?? false
        summary = try c.decodeIfPresent(Summary.self, forKey: .summary) ?? Summary()
        sessions = try c.decodeIfPresent([SessionInfo].self, forKey: .sessions) ?? []
        screens = try c.decodeIfPresent([String: ScreenText].self, forKey: .screens) ?? [:]
        prefs = try c.decodeIfPresent(Prefs.self, forKey: .prefs) ?? Prefs()
    }

    enum CodingKeys: String, CodingKey { case seq, serverTime, demo, summary, sessions, screens, prefs }
}

/// `sessions` event: `{seq, sessions, summary, windows, iterm}`.
public struct SessionsUpdate: Decodable {
    public var seq: Int
    public var sessions: [SessionInfo]
    public var summary: Summary

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
        sessions = try c.decodeIfPresent([SessionInfo].self, forKey: .sessions) ?? []
        summary = try c.decodeIfPresent(Summary.self, forKey: .summary) ?? Summary()
    }

    enum CodingKeys: String, CodingKey { case seq, sessions, summary }
}

/// `screens` event: `{seq, screens:{uid:{hash,text}}, removed:[uid]}`.
public struct ScreensUpdate: Decodable {
    public var screens: [String: ScreenText]
    public var removed: [String]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        screens = try c.decodeIfPresent([String: ScreenText].self, forKey: .screens) ?? [:]
        removed = try c.decodeIfPresent([String].self, forKey: .removed) ?? []
    }

    enum CodingKeys: String, CodingKey { case screens, removed }
}

/// `prefs` event: `{seq, prefs, projects}`.
public struct PrefsUpdate: Decodable {
    public var prefs: Prefs

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        prefs = try c.decodeIfPresent(Prefs.self, forKey: .prefs) ?? Prefs()
    }

    enum CodingKeys: String, CodingKey { case prefs }
}

/// `transition` event: `{uid, from, to, at, title, agent, prompt, muted}`.
public struct Transition: Decodable, Equatable {
    public var uid: String
    public var from: String?
    public var to: String?
    public var at: Double
    public var title: String
    public var agent: String?
    public var prompt: Prompt?
    public var muted: Bool

    public init(uid: String, from: String? = nil, to: String? = nil, at: Double = 0, title: String = "",
                agent: String? = nil, prompt: Prompt? = nil, muted: Bool = false) {
        self.uid = uid; self.from = from; self.to = to; self.at = at; self.title = title
        self.agent = agent; self.prompt = prompt; self.muted = muted
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        uid = try c.decode(String.self, forKey: .uid)
        from = try c.decodeIfPresent(String.self, forKey: .from)
        to = try c.decodeIfPresent(String.self, forKey: .to)
        at = try c.decodeIfPresent(Double.self, forKey: .at) ?? 0
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        agent = try c.decodeIfPresent(String.self, forKey: .agent)
        prompt = try c.decodeIfPresent(Prompt.self, forKey: .prompt)
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
    }

    enum CodingKeys: String, CodingKey { case uid, from, to, at, title, agent, prompt, muted }
}

/// `stall` event (P1 stall detection, engine.py `_stall_events`):
/// `{uid, title, agent, since, minutes, muted}` — sent once when a busy session's screen has
/// been unchanged for `prefs.stall_minutes`. Every field but `uid` is optional.
public struct StallEvent: Decodable, Equatable {
    public var uid: String
    public var title: String
    public var agent: String?
    public var since: Double?
    public var minutes: Int?
    public var muted: Bool

    public init(uid: String, title: String = "", agent: String? = nil, since: Double? = nil,
                minutes: Int? = nil, muted: Bool = false) {
        self.uid = uid; self.title = title; self.agent = agent; self.since = since
        self.minutes = minutes; self.muted = muted
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        uid = try c.decode(String.self, forKey: .uid)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        agent = try c.decodeIfPresent(String.self, forKey: .agent)
        since = try c.decodeIfPresent(Double.self, forKey: .since)
        minutes = try c.decodeIfPresent(Int.self, forKey: .minutes)
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
    }

    enum CodingKeys: String, CodingKey { case uid, title, agent, since, minutes, muted }
}

/// `GET /api/v1/summary`: `{tabs, agents, waiting, busy, stalled, waiting_sessions:[{uid,title,since,agent}]}`.
public struct SummaryResponse: Decodable, Equatable {
    public struct Waiting: Decodable, Equatable {
        public var uid: String
        public var title: String
        public var since: Double?
        public var agent: String?

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            uid = try c.decode(String.self, forKey: .uid)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            since = try c.decodeIfPresent(Double.self, forKey: .since)
            agent = try c.decodeIfPresent(String.self, forKey: .agent)
        }

        enum CodingKeys: String, CodingKey { case uid, title, since, agent }
    }

    public var tabs: Int
    public var agents: Int
    public var waiting: Int
    public var busy: Int
    public var stalled: Int
    public var waitingSessions: [Waiting]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tabs = try c.decodeIfPresent(Int.self, forKey: .tabs) ?? 0
        agents = try c.decodeIfPresent(Int.self, forKey: .agents) ?? 0
        waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
        busy = try c.decodeIfPresent(Int.self, forKey: .busy) ?? 0
        stalled = try c.decodeIfPresent(Int.self, forKey: .stalled) ?? 0
        waitingSessions = try c.decodeIfPresent([Waiting].self, forKey: .waitingSessions) ?? []
    }

    enum CodingKeys: String, CodingKey { case tabs, agents, waiting, busy, stalled, waitingSessions }
}

/// `action` event: `{id, kind, uid, ok, detail}`.
public struct ActionResult: Decodable, Equatable {
    public var id: String
    public var kind: String
    public var uid: String?
    public var ok: Bool
    public var detail: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        uid = try c.decodeIfPresent(String.self, forKey: .uid)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
    }

    enum CodingKeys: String, CodingKey { case id, kind, uid, ok, detail }
}

public enum OmniwatchJSON {
    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    public static func decode<T: Decodable>(_ type: T.Type, from string: String) throws -> T {
        try decoder().decode(type, from: Data(string.utf8))
    }
}

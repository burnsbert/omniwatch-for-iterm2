import Foundation

/// Filesystem seam so login-item logic is testable without touching ~/Library.
public protocol FileSystem {
    func read(_ url: URL) -> Data?
    func exists(_ path: String) -> Bool
    /// Atomic write; creates parent directories.
    func write(_ data: Data, to url: URL) throws
    func remove(_ url: URL) throws
}

public struct RealFileSystem: FileSystem {
    public init() {}
    public func read(_ url: URL) -> Data? { try? Data(contentsOf: url) }
    public func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }
    public func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }
    public func remove(_ url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}

/// Launch at login via a per-user LaunchAgent (`~/Library/LaunchAgents/<label>.plist`).
///
/// Chosen over `SMAppService.mainApp` because an ad-hoc-signed build has no Team ID and a new
/// cdhash on every rebuild, and I couldn't verify SMAppService registration survives that
/// without registering on the user's real system. launchd loads the plist at the next
/// login; enabling does **not** `launchctl bootstrap` it (RunAtLoad would start a second
/// copy right away). The agent runs `open -a <app> --args --launched-at-login`, so the app
/// goes through LaunchServices (the right TCC identity) and starts without showing its window.
public struct LaunchAgent {
    public static let label = "com.burnsbert.omniwatch.login"
    public static let loginFlag = "--launched-at-login"

    public enum Status: Equatable {
        case disabled
        case enabled(appPath: String)
        /// A file with our name that isn't ours / isn't readable: never overwritten or removed.
        case foreign
    }

    public enum AgentError: Error, CustomStringConvertible, Equatable {
        case foreignFile(String)
        case badAppPath(String)
        public var description: String {
            switch self {
            case .foreignFile(let p): return "\(p) exists and wasn't written by Omniwatch; leaving it alone"
            case .badAppPath(let p): return "not an app bundle path: \(p)"
            }
        }
    }

    public let agentsDir: URL
    public let fs: FileSystem

    public init(agentsDir: URL, fs: FileSystem = RealFileSystem()) {
        self.agentsDir = agentsDir
        self.fs = fs
    }

    public static func defaultAgentsDir(home: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home, isDirectory: true).appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    }

    public var plistURL: URL { agentsDir.appendingPathComponent("\(LaunchAgent.label).plist") }

    public static func plist(appPath: String) -> [String: Any] {
        [
            "Label": label,
            "ProgramArguments": ["/usr/bin/open", "-a", appPath, "--args", loginFlag],
            "RunAtLoad": true,
            "LimitLoadToSessionType": "Aqua",
            "ProcessType": "Interactive",
            "AssociatedBundleIdentifiers": ["com.burnsbert.omniwatch"],
        ]
    }

    public func status() -> Status {
        guard let data = fs.read(plistURL) else { return .disabled }
        guard let obj = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              obj["Label"] as? String == LaunchAgent.label,
              let args = obj["ProgramArguments"] as? [String],
              args.count >= 3, args[0] == "/usr/bin/open", args[1] == "-a" else { return .foreign }
        return .enabled(appPath: args[2])
    }

    public var isEnabled: Bool {
        if case .enabled = status() { return true }
        return false
    }

    public func enable(appPath: String) throws {
        guard appPath.hasPrefix("/"), appPath.hasSuffix(".app") else { throw AgentError.badAppPath(appPath) }
        if status() == .foreign { throw AgentError.foreignFile(plistURL.path) }
        let data = try PropertyListSerialization.data(fromPropertyList: LaunchAgent.plist(appPath: appPath),
                                                      format: .xml, options: 0)
        try fs.write(data, to: plistURL)
    }

    public func disable() throws {
        switch status() {
        case .disabled: return
        case .foreign: throw AgentError.foreignFile(plistURL.path)
        case .enabled: try fs.remove(plistURL)
        }
    }

    public func setEnabled(_ on: Bool, appPath: String) throws {
        if on { try enable(appPath: appPath) } else { try disable() }
    }

    /// At launch: if the agent points at an app that no longer exists (moved/reinstalled),
    /// retarget it at the running bundle. Returns true if it rewrote the plist.
    @discardableResult
    public func repairIfNeeded(appPath: String) throws -> Bool {
        guard case .enabled(let recorded) = status(), recorded != appPath, !fs.exists(recorded) else { return false }
        try enable(appPath: appPath)
        return true
    }
}

/// Native-only settings (not backend prefs): kept in UserDefaults by the app.
public protocol BoolStore {
    func bool(forKey key: String) -> Bool
    func set(_ value: Bool, forKey key: String)
}

extension UserDefaults: BoolStore {}

public struct ShellSettings {
    public static let menuBarOnlyKey = "menuBarOnly"
    public let store: BoolStore

    public init(store: BoolStore) { self.store = store }

    /// Menu-bar-only mode: no Dock icon (`NSApp.setActivationPolicy(.accessory)`).
    public var menuBarOnly: Bool {
        get { store.bool(forKey: ShellSettings.menuBarOnlyKey) }
        nonmutating set { store.set(newValue, forKey: ShellSettings.menuBarOnlyKey) }
    }
}

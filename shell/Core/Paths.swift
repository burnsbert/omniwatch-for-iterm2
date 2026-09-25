import Foundation

/// Config/log locations (§4.6) and the bits of `config.json` the shell reads.
public enum Paths {
    /// `$OMNIWATCH_CONFIG_DIR` → `$XDG_CONFIG_HOME/omniwatch` → `~/.config/omniwatch`.
    public static func configDir(environment env: [String: String], home: String = NSHomeDirectory()) -> URL {
        if let d = env["OMNIWATCH_CONFIG_DIR"], !d.isEmpty { return URL(fileURLWithPath: d, isDirectory: true) }
        if let x = env["XDG_CONFIG_HOME"], !x.isEmpty {
            return URL(fileURLWithPath: x, isDirectory: true).appendingPathComponent("omniwatch", isDirectory: true)
        }
        return URL(fileURLWithPath: home, isDirectory: true)
            .appendingPathComponent(".config/omniwatch", isDirectory: true)
    }

    public static func logsDir(home: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home, isDirectory: true).appendingPathComponent("Library/Logs/Omniwatch", isDirectory: true)
    }
}

/// Shell-relevant keys of the optional, user-edited `config.json`.
public struct ShellConfig: Equatable {
    /// nil = off. A missing `hotkeys.toggle` key means the default (⌃⌥⌘O); explicit `null` means off.
    public var toggleHotKey: String?
    /// Default off.
    public var nextWaitingHotKey: String?

    public init(toggleHotKey: String? = HotKeySpec.defaultToggle, nextWaitingHotKey: String? = nil) {
        self.toggleHotKey = toggleHotKey
        self.nextWaitingHotKey = nextWaitingHotKey
    }

    public static func parse(_ data: Data?) -> ShellConfig {
        var c = ShellConfig()
        guard let data = data,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let hk = obj["hotkeys"] as? [String: Any] else { return c }
        if let t = hk["toggle"] {
            c.toggleHotKey = t as? String // NSNull / non-string → off
        }
        if let n = hk["next_waiting"] {
            c.nextWaitingHotKey = n as? String
        }
        return c
    }

    public static func load(configDir: URL) -> ShellConfig {
        parse(try? Data(contentsOf: configDir.appendingPathComponent("config.json")))
    }
}

/// Minimal thread-safe append-only log (`shell.log`).
public final class ShellLog {
    public let url: URL?
    private let queue = DispatchQueue(label: "omniwatch.shelllog")
    private var handle: FileHandle?
    public var echoToStderr = false

    public init(url: URL?, truncate: Bool = true) {
        self.url = url
        guard let url = url else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if truncate || !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        handle = try? FileHandle(forWritingTo: url)
        handle?.seekToEndOfFile()
    }

    public func log(_ message: String) {
        let line = "\(ShellLog.stamp()) \(message)\n"
        queue.async { [weak self] in
            guard let self = self else { return }
            self.handle?.write(Data(line.utf8))
            if self.echoToStderr { FileHandle.standardError.write(Data(line.utf8)) }
        }
    }

    public func flush() { queue.sync { try? handle?.synchronize() } }

    /// File handle the backend child's stderr is appended to (early startup errors).
    public func appendingHandle() -> FileHandle? {
        guard let url = url, let h = try? FileHandle(forWritingTo: url) else { return nil }
        h.seekToEndOfFile()
        return h
    }

    static func stamp() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f.string(from: Date())
    }
}

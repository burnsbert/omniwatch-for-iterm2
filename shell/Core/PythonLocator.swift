import Foundation

/// Interpreter discovery (§4.7 step 1).
///
/// Explicit choices — `config.json` `python`, `$OMNIWATCH_PYTHON`, `Resources/python-path`
/// (written by install.sh) — are tried first, in that order, and the first that works (≥3.9)
/// wins even without `iterm2`: the user or installer picked it. Among the built-in defaults
/// (`/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `/usr/bin/python3`) the first one
/// that can `import iterm2` wins, else the first that is ≥3.9.
public struct PythonLocator {
    public struct ProbeResult: Equatable {
        public var major: Int
        public var minor: Int
        public var hasIterm2: Bool
        public init(major: Int, minor: Int, hasIterm2: Bool) {
            self.major = major; self.minor = minor; self.hasIterm2 = hasIterm2
        }
        public var isSupported: Bool { major > 3 || (major == 3 && minor >= 9) }
    }

    public struct Choice: Equatable {
        public var path: String
        public var source: String
        public var probe: ProbeResult
    }

    public enum LocateError: Error, CustomStringConvertible {
        case noneFound(tried: [String])
        public var description: String {
            switch self {
            case .noneFound(let tried):
                return "no Python ≥3.9 found (tried: \(tried.joined(separator: ", ")))"
            }
        }
    }

    public static let defaultCandidates = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]

    public var configDir: URL?
    public var environment: [String: String]
    public var resourcesDir: URL?
    public var isExecutable: (String) -> Bool
    public var readFile: (URL) -> Data?
    public var probe: (String) -> ProbeResult?

    public init(configDir: URL?, environment: [String: String], resourcesDir: URL?,
                isExecutable: @escaping (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
                readFile: @escaping (URL) -> Data? = { try? Data(contentsOf: $0) },
                probe: @escaping (String) -> ProbeResult? = { PythonLocator.runProbe($0) }) {
        self.configDir = configDir
        self.environment = environment
        self.resourcesDir = resourcesDir
        self.isExecutable = isExecutable
        self.readFile = readFile
        self.probe = probe
    }

    /// The explicit candidates in priority order, with their source names.
    public func explicitCandidates() -> [(path: String, source: String)] {
        var out: [(String, String)] = []
        if let dir = configDir, let data = readFile(dir.appendingPathComponent("config.json")),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let p = obj["python"] as? String, !p.trimmingCharacters(in: .whitespaces).isEmpty {
            out.append((expand(p), "config.json"))
        }
        if let p = environment["OMNIWATCH_PYTHON"], !p.trimmingCharacters(in: .whitespaces).isEmpty {
            out.append((expand(p), "OMNIWATCH_PYTHON"))
        }
        if let dir = resourcesDir, let data = readFile(dir.appendingPathComponent("python-path")),
           let s = String(data: data, encoding: .utf8) {
            let p = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if !p.isEmpty { out.append((expand(p), "python-path")) }
        }
        return out
    }

    public func locate() throws -> Choice {
        var tried: [String] = []
        for (path, source) in explicitCandidates() {
            tried.append(path)
            if isExecutable(path), let r = probe(path), r.isSupported {
                return Choice(path: path, source: source, probe: r)
            }
        }
        var firstSupported: Choice?
        for path in PythonLocator.defaultCandidates where !tried.contains(path) {
            tried.append(path)
            guard isExecutable(path), let r = probe(path), r.isSupported else { continue }
            let c = Choice(path: path, source: "default", probe: r)
            if r.hasIterm2 { return c }
            if firstSupported == nil { firstSupported = c }
        }
        if let c = firstSupported { return c }
        throw LocateError.noneFound(tried: tried)
    }

    func expand(_ p: String) -> String {
        let t = p.trimmingCharacters(in: .whitespaces)
        if t == "~" || t.hasPrefix("~/"), let home = environment["HOME"] {
            return home + t.dropFirst()
        }
        return t
    }

    public static let probeScript =
        "import sys\ntry:\n import iterm2\n i=1\nexcept Exception:\n i=0\nprint('%d %d %d' % (sys.version_info[0], sys.version_info[1], i))"

    /// Parses the probe's stdout: "3 13 1".
    public static func parseProbeOutput(_ s: String) -> ProbeResult? {
        let parts = s.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ")
        guard parts.count == 3, let ma = Int(parts[0]), let mi = Int(parts[1]), let i = Int(parts[2]) else {
            return nil
        }
        return ProbeResult(major: ma, minor: mi, hasIterm2: i == 1)
    }

    /// Runs `python -c <probeScript>` with a 3 s timeout (§4.7 step 1).
    public static func runProbe(_ path: String, timeout: TimeInterval = 3) -> ProbeResult? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["-c", probeScript]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in done.signal() }
        do { try p.run() } catch { return nil }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            _ = done.wait(timeout: .now() + 1)
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        guard p.terminationStatus == 0, let s = String(data: data, encoding: .utf8) else { return nil }
        return parseProbeOutput(s)
    }
}

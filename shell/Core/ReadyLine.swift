import Foundation

/// The single line the backend prints on stdout once its socket is listening (§4.3):
/// `{"event":"ready","port":53817,"token":"<43 chars>","pid":1234,"version":"1.0.0","demo":false}`
public struct ReadyLine: Equatable {
    public let port: Int
    public let token: String
    public let pid: Int32
    public let version: String
    public let demo: Bool

    public enum ParseError: Error, Equatable, CustomStringConvertible {
        case notJSON
        case wrongEvent(String?)
        case missingField(String)
        case invalidField(String)
        /// The backend printed `{"event":"error","code":…,"message":…}` instead of a ready
        /// line: it refused to start (e.g. `already_running`) and will exit on its own.
        case backendError(code: String, message: String)

        public var description: String {
            switch self {
            case .backendError(_, let message): return message
            case .notJSON: return "ready line is not a JSON object"
            case .wrongEvent(let e): return "ready line has event \(e.map { "\"\($0)\"" } ?? "none"), expected \"ready\""
            case .missingField(let f): return "ready line is missing \"\(f)\""
            case .invalidField(let f): return "ready line has an invalid \"\(f)\""
            }
        }
    }

    public init(port: Int, token: String, pid: Int32, version: String, demo: Bool) {
        self.port = port
        self.token = token
        self.pid = pid
        self.version = version
        self.demo = demo
    }

    /// Parses one stdout line. Leading/trailing whitespace (including `\r`) is ignored.
    /// Unknown extra fields are ignored so the backend can add fields without breaking the shell.
    public static func parse(_ line: String) throws -> ReadyLine {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw ParseError.notJSON
        }
        if obj["event"] as? String == "error" {
            let message = (obj["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            throw ParseError.backendError(code: (obj["code"] as? String) ?? "error",
                                          message: message ?? "the backend refused to start")
        }
        guard let event = obj["event"] as? String, event == "ready" else {
            throw ParseError.wrongEvent(obj["event"] as? String)
        }
        guard let portAny = obj["port"] else { throw ParseError.missingField("port") }
        guard let port = exactInt(portAny), (1...65535).contains(port) else {
            throw ParseError.invalidField("port")
        }
        guard let tokenAny = obj["token"] else { throw ParseError.missingField("token") }
        guard let token = tokenAny as? String, !token.isEmpty,
              token.unicodeScalars.allSatisfy({ tokenAllowed.contains($0) }) else {
            throw ParseError.invalidField("token")
        }
        guard let pidAny = obj["pid"] else { throw ParseError.missingField("pid") }
        guard let pid = exactInt(pidAny), pid > 0, pid <= Int(Int32.max) else {
            throw ParseError.invalidField("pid")
        }
        let version = (obj["version"] as? String) ?? ""
        var demo = false
        if let d = obj["demo"] {
            guard let n = d as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {
                throw ParseError.invalidField("demo")
            }
            demo = n.boolValue
        }
        return ReadyLine(port: port, token: token, pid: Int32(pid), version: version, demo: demo)
    }

    /// `secrets.token_urlsafe` alphabet. Restricting it means the token can go into a URL
    /// query and an HTTP header without escaping.
    static let tokenAllowed = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    private static func exactInt(_ v: Any) -> Int? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.rounded() == d, abs(d) < 1e15 else { return nil }
        return n.intValue
    }

    public var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    /// URL the WKWebView loads; the backend sets the `ow_session` cookie and 302s to `/`.
    public var authURL: URL { URL(string: "http://127.0.0.1:\(port)/auth?token=\(token)")! }
}

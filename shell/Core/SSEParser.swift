import Foundation

public struct SSEEvent: Equatable {
    public var type: String
    public var data: String
    /// The stream's last event id at dispatch time (persists across events, per the spec).
    public var id: String?

    public init(type: String, data: String, id: String?) {
        self.type = type
        self.data = data
        self.id = id
    }
}

/// Incremental `text/event-stream` parser (WHATWG HTML §9.2.6 rules).
///
/// Bytes can arrive split anywhere — mid-line, mid-CRLF, or mid-UTF-8 sequence — because lines
/// are only decoded once complete. Handles LF, CR, and CRLF line endings, `:` comments,
/// multi-line `data`, `id` (ignored if it contains NUL), `retry`, and a leading BOM.
public final class SSEParser {
    public private(set) var lastEventId: String?
    /// Reconnection delay requested by the server via `retry:`, in milliseconds.
    public private(set) var retryMs: Int?
    /// Number of comment lines seen (the backend's `: ping` heartbeat).
    public private(set) var commentCount = 0

    private var buffer = [UInt8]()
    private var pendingCR = false
    private var sawFirstLine = false
    private var eventType = ""
    private var dataLines = [String]()
    private var hasData = false

    public init(lastEventId: String? = nil) {
        self.lastEventId = lastEventId
    }

    /// Clears the partial event and line buffer (for a new connection); keeps `lastEventId`.
    public func resetConnection() {
        buffer.removeAll()
        pendingCR = false
        sawFirstLine = false
        eventType = ""
        dataLines.removeAll()
        hasData = false
    }

    public func feed(_ string: String) -> [SSEEvent] { feed(Data(string.utf8)) }

    public func feed(_ data: Data) -> [SSEEvent] {
        var out = [SSEEvent]()
        for byte in data {
            if pendingCR {
                pendingCR = false
                if byte == 0x0A { continue } // CRLF: the CR already ended the line
            }
            if byte == 0x0D {
                pendingCR = true
                endLine(&out)
            } else if byte == 0x0A {
                endLine(&out)
            } else {
                buffer.append(byte)
            }
        }
        return out
    }

    private func endLine(_ out: inout [SSEEvent]) {
        var bytes = buffer
        buffer.removeAll(keepingCapacity: true)
        if !sawFirstLine {
            sawFirstLine = true
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        }
        let line = String(decoding: bytes, as: UTF8.self)
        processLine(line, &out)
    }

    private func processLine(_ line: String, _ out: inout [SSEEvent]) {
        if line.isEmpty {
            dispatch(&out)
            return
        }
        if line.hasPrefix(":") {
            commentCount += 1
            return
        }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[line.startIndex..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "event":
            eventType = String(value)
        case "data":
            dataLines.append(String(value))
            hasData = true
        case "id":
            if !value.contains("\u{0}") { lastEventId = String(value) }
        case "retry":
            if !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }), let ms = Int(value) {
                retryMs = ms
            }
        default:
            break // unknown fields are ignored
        }
    }

    private func dispatch(_ out: inout [SSEEvent]) {
        defer {
            eventType = ""
            dataLines.removeAll()
            hasData = false
        }
        guard hasData else { return }
        out.append(SSEEvent(type: eventType.isEmpty ? "message" : eventType,
                            data: dataLines.joined(separator: "\n"),
                            id: lastEventId))
    }
}

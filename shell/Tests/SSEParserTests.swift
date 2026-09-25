import Foundation

enum SSEParserTests {
    static let all: [TestCase] = [
        TestCase(name: "basicEventWithIdAndType") {
            let p = SSEParser()
            let ev = p.feed("id: 7\nevent: hello\ndata: {\"a\":1}\n\n")
            checkEqual(ev, [SSEEvent(type: "hello", data: "{\"a\":1}", id: "7")])
            checkEqual(p.lastEventId, "7")
        },
        TestCase(name: "defaultTypeIsMessage") {
            checkEqual(SSEParser().feed("data: x\n\n"), [SSEEvent(type: "message", data: "x", id: nil)])
        },
        TestCase(name: "multiLineData") {
            let ev = SSEParser().feed("data: a\ndata:b\ndata:  c\n\n")
            checkEqual(ev.map { $0.data }, ["a\nb\n c"])
        },
        TestCase(name: "commentsAreCountedNotDispatched") {
            let p = SSEParser()
            checkEqual(p.feed(": ping\n\n: ping\n\n"), [])
            checkEqual(p.commentCount, 2)
        },
        TestCase(name: "everyChunkBoundary") {
            let stream = "id: 1\nevent: state\ndata: {\"s\":\"héllo ◉\"}\n\n: ping\n\nid: 2\r\nevent: sessions\r\ndata: [1]\r\n\r\n"
            let bytes = Array(stream.utf8)
            let expected = [SSEEvent(type: "state", data: "{\"s\":\"héllo ◉\"}", id: "1"),
                            SSEEvent(type: "sessions", data: "[1]", id: "2")]
            for cut in 0...bytes.count {
                let p = SSEParser()
                var out = p.feed(Data(bytes[0..<cut]))
                out += p.feed(Data(bytes[cut...]))
                checkEqual(out, expected, "cut at \(cut)")
            }
            // byte-at-a-time
            let p = SSEParser()
            var out: [SSEEvent] = []
            for b in bytes { out += p.feed(Data([b])) }
            checkEqual(out, expected)
        },
        TestCase(name: "crOnlyLineEndings") {
            checkEqual(SSEParser().feed("event: x\rdata: 1\r\r"), [SSEEvent(type: "x", data: "1", id: nil)])
        },
        TestCase(name: "crlfSplitAcrossChunksIsOneLineEnd") {
            let p = SSEParser()
            var out = p.feed("data: 1\r")
            out += p.feed("\n\r")
            out += p.feed("\n")
            checkEqual(out, [SSEEvent(type: "message", data: "1", id: nil)])
        },
        TestCase(name: "noDataNoDispatchAndTypeResets") {
            let p = SSEParser()
            checkEqual(p.feed("event: lonely\n\n"), [])
            checkEqual(p.feed("data: y\n\n"), [SSEEvent(type: "message", data: "y", id: nil)])
        },
        TestCase(name: "emptyDataFieldDispatchesEmptyString") {
            checkEqual(SSEParser().feed("data\n\n"), [SSEEvent(type: "message", data: "", id: nil)])
            checkEqual(SSEParser().feed("data:\n\n").map { $0.data }, [""])
        },
        TestCase(name: "idPersistsAndNulIdIgnored") {
            let p = SSEParser()
            _ = p.feed("id: 5\ndata: a\n\n")
            checkEqual(p.feed("data: b\n\n").first?.id, "5")
            _ = p.feed("id: 6\u{0}\ndata: c\n\n")
            checkEqual(p.lastEventId, "5")
            _ = p.feed("id\ndata: d\n\n")
            checkEqual(p.lastEventId, "")
        },
        TestCase(name: "retryAndUnknownFields") {
            let p = SSEParser()
            _ = p.feed("retry: 2500\nfoo: bar\nretry: 1x\n\n")
            checkEqual(p.retryMs, 2500)
        },
        TestCase(name: "leadingBOMStripped") {
            let d = Data([0xEF, 0xBB, 0xBF]) + Data("data: z\n\n".utf8)
            checkEqual(SSEParser().feed(d).map { $0.data }, ["z"])
        },
        TestCase(name: "incompleteEventHeldUntilBlankLine") {
            let p = SSEParser()
            checkEqual(p.feed("data: part\n"), [])
            checkEqual(p.feed("\n").map { $0.data }, ["part"])
        },
        TestCase(name: "resetConnectionDropsPartialKeepsId") {
            let p = SSEParser(lastEventId: "9")
            _ = p.feed("event: x\ndata: half")
            p.resetConnection()
            checkEqual(p.feed("data: new\n\n"), [SSEEvent(type: "message", data: "new", id: "9")])
        },
        TestCase(name: "fieldWithoutSpaceAndColonInValue") {
            checkEqual(SSEParser().feed("data:a: b\n\n").map { $0.data }, ["a: b"])
        },
    ]
}

import Foundation

enum RestartPolicyTests {
    static let all: [TestCase] = [
        TestCase(name: "backoffThenGiveUp") {
            var p = RestartPolicy()
            checkEqual(p.onUnexpectedExit(at: 0), .restart(after: 1))
            checkEqual(p.onUnexpectedExit(at: 2), .restart(after: 2))
            checkEqual(p.onUnexpectedExit(at: 5), .restart(after: 5))
            checkEqual(p.onUnexpectedExit(at: 11), .giveUp) // 4th crash within 60 s
            checkEqual(p.recentRestarts(at: 11), 3)
        },
        TestCase(name: "oldRestartsExpire") {
            var p = RestartPolicy()
            _ = p.onUnexpectedExit(at: 0)
            _ = p.onUnexpectedExit(at: 10)
            _ = p.onUnexpectedExit(at: 20)
            checkEqual(p.onUnexpectedExit(at: 61), .restart(after: 5)) // the t=0 one aged out
            checkEqual(p.recentRestarts(at: 200), 0)
            checkEqual(p.onUnexpectedExit(at: 200), .restart(after: 1))
        },
        TestCase(name: "resetForRetry") {
            var p = RestartPolicy()
            for t in 0..<3 { _ = p.onUnexpectedExit(at: Double(t)) }
            checkEqual(p.onUnexpectedExit(at: 4), .giveUp)
            p.reset()
            checkEqual(p.onUnexpectedExit(at: 5), .restart(after: 1))
        },
        TestCase(name: "customDelaysClampToLast") {
            var p = RestartPolicy(delays: [0.1], maxRestarts: 5, window: 10)
            for t in 0..<5 { checkEqual(p.onUnexpectedExit(at: Double(t)), .restart(after: 0.1)) }
            checkEqual(p.onUnexpectedExit(at: 5), .giveUp)
        },
    ]
}

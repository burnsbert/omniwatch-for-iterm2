import Foundation

/// Backend supervision policy (§4.7 step 4): restart after 1 s, 2 s, 5 s; more than
/// `maxRestarts` restarts inside `window` seconds → give up and show the error view.
public struct RestartPolicy {
    public enum Decision: Equatable {
        case restart(after: TimeInterval)
        case giveUp
    }

    public let delays: [TimeInterval]
    public let maxRestarts: Int
    public let window: TimeInterval
    public private(set) var restarts: [TimeInterval] = []

    public init(delays: [TimeInterval] = [1, 2, 5], maxRestarts: Int = 3, window: TimeInterval = 60) {
        precondition(!delays.isEmpty)
        self.delays = delays
        self.maxRestarts = maxRestarts
        self.window = window
    }

    /// Call when the backend exits unexpectedly (or fails its handshake) at time `now`.
    public mutating func onUnexpectedExit(at now: TimeInterval) -> Decision {
        restarts = restarts.filter { now - $0 < window }
        if restarts.count >= maxRestarts { return .giveUp }
        let delay = delays[min(restarts.count, delays.count - 1)]
        restarts.append(now)
        return .restart(after: delay)
    }

    /// Manual Retry from the error view starts over.
    public mutating func reset() { restarts.removeAll() }

    public func recentRestarts(at now: TimeInterval) -> Int {
        restarts.filter { now - $0 < window }.count
    }
}

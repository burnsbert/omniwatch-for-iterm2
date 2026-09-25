import Foundation

/// Keeps one backend running (§4.7 step 4): restarts it with `RestartPolicy` backoff after an
/// unexpected exit or failed handshake and gives up after too many restarts.
/// Main-queue (or `callbackQueue`) confined: call everything from that queue.
public final class BackendSupervisor {
    public enum Status: Equatable {
        case idle
        case starting(attempt: Int)
        case running(ReadyLine)
        case restarting(after: TimeInterval, reason: String)
        case failed(String)
        case stopping
        case stopped
    }

    public var makeLaunch: () throws -> BackendLaunch
    public var environment: [String: String]
    public var stderrHandle: () -> FileHandle? = { nil }
    public var readyTimeout: TimeInterval = 10
    public var policy: RestartPolicy
    public var clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    public var callbackQueue: DispatchQueue = .main
    public var log: (String) -> Void = { _ in }

    public var onStatus: ((Status) -> Void)?

    public private(set) var status: Status = .idle { didSet { onStatus?(status) } }
    public private(set) var current: BackendProcess?
    public private(set) var attempts = 0
    private var generation = 0

    public init(makeLaunch: @escaping () throws -> BackendLaunch,
                environment: [String: String] = ProcessInfo.processInfo.environment,
                policy: RestartPolicy = RestartPolicy()) {
        self.makeLaunch = makeLaunch
        self.environment = environment
        self.policy = policy
    }

    public var ready: ReadyLine? {
        if case .running(let r) = status { return r }
        return nil
    }

    public func start() {
        switch status {
        case .idle, .failed, .stopped: break
        default: return
        }
        spawn()
    }

    /// Error view **Retry**: forget previous crashes and start again.
    public func retry() {
        policy.reset()
        if case .failed = status { spawn() } else if status == .stopped || status == .idle { spawn() }
    }

    private func spawn() {
        generation += 1
        let gen = generation
        attempts += 1
        status = .starting(attempt: attempts)
        let launch: BackendLaunch
        do {
            launch = try makeLaunch()
        } catch {
            log("backend launch failed: \(error)")
            status = .failed("\(error)")
            return
        }
        let p = BackendProcess(launch: launch, environment: environment)
        p.readyTimeout = readyTimeout
        p.callbackQueue = callbackQueue
        p.stderrHandle = stderrHandle()
        p.onReady = { [weak self] r in
            guard let self = self, self.generation == gen else { return }
            self.log("backend ready: port \(r.port) pid \(r.pid) version \(r.version) demo \(r.demo)")
            self.status = .running(r)
        }
        p.onOutputLine = { [weak self] line in self?.log("backend stdout: \(line)") }
        p.onExit = { [weak self] exit in
            guard let self = self, self.generation == gen else { return }
            self.handleExit(exit)
        }
        current = p
        log("spawning backend: \(launch.argv.joined(separator: " "))")
        do {
            try p.start()
        } catch {
            log("backend spawn failed: \(error)")
            handleExit(.handshakeFailed("could not start \(launch.python): \(error.localizedDescription)"))
        }
    }

    private func handleExit(_ exit: BackendProcess.Exit) {
        let reason: String
        switch exit {
        case .requested:
            status = .stopped
            return
        case .crashed(let s): reason = "backend exited unexpectedly (status \(s))"
        case .handshakeFailed(let r): reason = "backend handshake failed: \(r)"
        }
        log(reason)
        switch policy.onUnexpectedExit(at: clock()) {
        case .giveUp:
            status = .failed(reason)
        case .restart(let delay):
            status = .restarting(after: delay, reason: reason)
            let gen = generation
            callbackQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, self.generation == gen, case .restarting = self.status else { return }
                self.spawn()
            }
        }
    }

    /// Quit: runs the §4.7 step 5 sequence on the current child and reports `.stopped`.
    public func stop(requestShutdown: ((ReadyLine) -> Void)? = nil, completion: (() -> Void)? = nil) {
        generation += 1 // cancels pending restarts and ignores callbacks from the old child
        let r = ready
        status = .stopping
        guard let p = current else {
            status = .stopped
            completion?()
            return
        }
        let shutdown: (() -> Void)? = (r != nil && requestShutdown != nil) ? { requestShutdown!(r!) } : nil
        p.stop(requestShutdown: shutdown) { [weak self] in
            self?.status = .stopped
            completion?()
        }
    }
}

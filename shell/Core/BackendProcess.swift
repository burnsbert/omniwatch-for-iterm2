import Foundation

/// How to start the backend (§4.7 step 2).
public struct BackendLaunch: Equatable {
    public var python: String
    /// What goes between the interpreter and `serve`: `[".../omniwatch.pyz"]`, `["-m", "omniwatch"]`,
    /// or `[".../fake_backend.py"]`.
    public var program: [String]
    public var parentPid: Int32
    public var logFile: String?
    public var demo: Bool
    public var extraArgs: [String]

    public init(python: String, program: [String], parentPid: Int32, logFile: String?, demo: Bool,
                extraArgs: [String] = []) {
        self.python = python; self.program = program; self.parentPid = parentPid
        self.logFile = logFile; self.demo = demo; self.extraArgs = extraArgs
    }

    public var argv: [String] {
        var a = [python] + program + ["serve", "--ready-json", "--parent-pid", String(parentPid)]
        if let l = logFile { a += ["--log-file", l] }
        if demo { a.append("--demo") }
        return a + extraArgs
    }

    public enum ResolveError: Error, CustomStringConvertible {
        case notFound(String)
        public var description: String {
            switch self { case .notFound(let s): return s }
        }
    }

    /// Resolves the program part. Override (flag `--backend X` or `$OMNIWATCH_BACKEND`):
    /// `-m <module>` runs a module (e.g. `-m omniwatch` with `PYTHONPATH` set), anything else
    /// is a script/zipapp path. Default: `Resources/omniwatch.pyz`.
    public static func resolveProgram(override: String?, resourcesDir: URL?,
                                      currentDirectory: String = FileManager.default.currentDirectoryPath,
                                      fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) })
        throws -> [String] {
        if var o = override?.trimmingCharacters(in: .whitespaces), !o.isEmpty {
            let parts = o.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            if parts.first == "-m" {
                guard parts.count == 2 else { throw ResolveError.notFound("backend override \"\(o)\": expected \"-m <module>\"") }
                return parts
            }
            if !o.hasPrefix("/") { // the child may not share our cwd (Finder launches use "/")
                o = URL(fileURLWithPath: o, relativeTo: URL(fileURLWithPath: currentDirectory, isDirectory: true)).standardized.path
            }
            guard fileExists(o) else { throw ResolveError.notFound("backend override \(o) does not exist") }
            return [o]
        }
        if let r = resourcesDir {
            let pyz = r.appendingPathComponent("omniwatch.pyz").path
            if fileExists(pyz) { return [pyz] }
        }
        throw ResolveError.notFound("backend not bundled (no Resources/omniwatch.pyz); set OMNIWATCH_BACKEND or pass --backend")
    }

    /// `$OMNIWATCH_BACKEND_ARGS`, whitespace-split, appended after the standard arguments.
    public static func extraArgs(environment: [String: String]) -> [String] {
        (environment["OMNIWATCH_BACKEND_ARGS"] ?? "").split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
    }
}

/// One backend child process: spawn, ready-line handshake, exit reporting, and the quit
/// sequence. All state lives on a private serial queue; callbacks run on `callbackQueue`.
public final class BackendProcess {
    public enum Exit: Equatable {
        /// Exited (or was killed) after `stop()` was called.
        case requested(status: Int32)
        /// Exited on its own after a successful handshake.
        case crashed(status: Int32)
        /// Never produced a valid ready line (bad line, early exit, or timeout).
        case handshakeFailed(String)
        /// Printed an `error` event instead of the ready line (e.g. another backend already
        /// owns the config dir). Restarting won't help, so the supervisor doesn't.
        case refused(String)
    }

    public let launch: BackendLaunch
    public var environment: [String: String]
    public var stderrHandle: FileHandle?
    public var readyTimeout: TimeInterval = 10
    public var callbackQueue: DispatchQueue = .main
    public var onReady: ((ReadyLine) -> Void)?
    public var onExit: ((Exit) -> Void)?
    /// Every stdout line after the ready line (the backend shouldn't print any; logged).
    public var onOutputLine: ((String) -> Void)?

    private let q = DispatchQueue(label: "omniwatch.backend")
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutBuffer = Data()
    private var ready: ReadyLine?
    private var handshakeError: String?
    private var refusal: String?
    private var stopRequested = false
    private var exited = false
    private var reported = false
    private var stopCompletions: [(DispatchQueue, () -> Void)] = []

    public init(launch: BackendLaunch, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.launch = launch
        self.environment = environment
    }

    public var pid: Int32? { q.sync { process.map { $0.processIdentifier } } }
    public var isRunning: Bool { q.sync { process != nil && !exited } }
    public var readyLine: ReadyLine? { q.sync { ready } }

    public func start() throws {
        try q.sync {
            precondition(process == nil, "BackendProcess.start() called twice")
            let p = Process()
            p.executableURL = URL(fileURLWithPath: launch.python)
            p.arguments = Array(launch.argv.dropFirst())
            var env = environment
            env["PYTHONUNBUFFERED"] = "1"
            p.environment = env
            let inPipe = Pipe(), outPipe = Pipe()
            p.standardInput = inPipe
            p.standardOutput = outPipe
            p.standardError = stderrHandle ?? FileHandle.nullDevice
            outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
                let d = h.availableData
                self?.q.async { self?.handleStdout(d, handle: h) }
            }
            p.terminationHandler = { [weak self] proc in
                let status = proc.terminationStatus
                self?.q.async { self?.handleExit(status) }
            }
            try p.run()
            process = p
            stdinPipe = inPipe
            q.asyncAfter(deadline: .now() + readyTimeout) { [weak self] in self?.handshakeTimeout() }
        }
    }

    private func handleStdout(_ d: Data, handle: FileHandle) {
        if d.isEmpty {
            handle.readabilityHandler = nil // EOF
            return
        }
        stdoutBuffer.append(d)
        while let nl = stdoutBuffer.firstIndex(of: 0x0A) {
            let lineData = stdoutBuffer[stdoutBuffer.startIndex..<nl]
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...nl)
            let line = String(decoding: lineData, as: UTF8.self)
            if ready == nil && handshakeError == nil {
                do {
                    let r = try ReadyLine.parse(line)
                    ready = r
                    let cb = onReady
                    callbackQueue.async { cb?(r) }
                } catch {
                    if case ReadyLine.ParseError.backendError(_, let message) = error { refusal = message }
                    failHandshake("\(error)")
                }
            } else {
                let cb = onOutputLine
                callbackQueue.async { cb?(line) }
            }
        }
        if ready == nil && handshakeError == nil && stdoutBuffer.count > 64 * 1024 {
            failHandshake("ready line longer than 64 KiB")
        }
    }

    private func handshakeTimeout() {
        guard ready == nil, handshakeError == nil, !exited, !stopRequested else { return }
        failHandshake("no ready line within \(Int(readyTimeout)) s")
    }

    private func failHandshake(_ reason: String) {
        handshakeError = reason
        signalChild(SIGTERM)
        q.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, !self.exited else { return }
            self.signalChild(SIGKILL)
        }
    }

    private func handleExit(_ status: Int32) {
        exited = true
        try? stdinPipe?.fileHandleForWriting.close()
        let exit: Exit
        if stopRequested {
            exit = .requested(status: status)
        } else if let why = refusal {
            exit = .refused(why)
        } else if let err = handshakeError {
            exit = .handshakeFailed(err)
        } else if ready == nil {
            exit = .handshakeFailed("backend exited with status \(status) before the ready line")
        } else {
            exit = .crashed(status: status)
        }
        if !reported {
            reported = true
            let cb = onExit
            callbackQueue.async { cb?(exit) }
        }
        let completions = stopCompletions
        stopCompletions.removeAll()
        for (queue, c) in completions { queue.async(execute: c) }
    }

    private func signalChild(_ sig: Int32) {
        guard let p = process, !exited else { return }
        kill(p.processIdentifier, sig)
    }

    /// Quit sequence (§4.7 step 5): `requestShutdown` (POST /shutdown) → wait `grace` →
    /// close stdin + SIGTERM → wait `grace` → SIGKILL. `completion` runs once the child exited
    /// (or immediately if it never started / already exited).
    public func stop(grace: TimeInterval = 2, requestShutdown: (() -> Void)? = nil,
                     completionQueue: DispatchQueue? = nil, completion: (() -> Void)? = nil) {
        q.async {
            self.stopRequested = true
            let cq = completionQueue ?? self.callbackQueue
            if self.process == nil || self.exited {
                if let c = completion { cq.async(execute: c) }
                return
            }
            if let c = completion { self.stopCompletions.append((cq, c)) }
            if let req = requestShutdown, self.ready != nil {
                req()
            } else {
                try? self.stdinPipe?.fileHandleForWriting.close()
                self.signalChild(SIGTERM)
            }
            self.q.asyncAfter(deadline: .now() + grace) {
                guard !self.exited else { return }
                try? self.stdinPipe?.fileHandleForWriting.close()
                self.signalChild(SIGTERM)
                self.q.asyncAfter(deadline: .now() + grace) {
                    guard !self.exited else { return }
                    self.signalChild(SIGKILL)
                }
            }
        }
    }

    /// Blocking variant for the last moments of the app (and tests).
    @discardableResult
    public func stopAndWait(grace: TimeInterval = 2, requestShutdown: (() -> Void)? = nil) -> Bool {
        let sem = DispatchSemaphore(value: 0)
        stop(grace: grace, requestShutdown: requestShutdown, completionQueue: .global()) { sem.signal() }
        return sem.wait(timeout: .now() + grace * 2 + 2) == .success
    }
}

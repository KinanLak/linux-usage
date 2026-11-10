import Foundation

struct CommandResult: Sendable {
    let success: Bool
    let stdout: String
    let stderr: String
}

enum Shell {
    /// Apps launched from Finder get a bare PATH, so CLIs installed by npm, bun, Homebrew or the
    /// Claude installer are looked up in the usual places, then through a login shell.
    private static let searchDirectories: [String] = {
        let home = Paths.home
        var dirs = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        dirs += [
            "\(home)/.local/bin",
            "\(home)/.claude/local",
            "\(home)/.bun/bin",
            "\(home)/.npm-global/bin",
            "\(home)/.volta/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
        ]
        var seen = Set<String>()
        return dirs.filter { !$0.isEmpty && seen.insert($0).inserted }
    }()

    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var resolved: [String: String?] = [:]

    static func which(_ name: String) async -> String? {
        if let cached = cacheLock.withLock({ resolved[name] }) { return cached }

        var found = searchDirectories
            .map { ($0 as NSString).appendingPathComponent(name) }
            .first { FileManager.default.isExecutableFile(atPath: $0) }

        if found == nil {
            let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            let result = await run([shell, "-lic", "command -v \(name)"], timeout: 5)
            found = result.stdout
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .last { $0.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: $0) }
        }

        cacheLock.withLock { resolved[name] = .some(found) }
        return found
    }

    static func run(_ arguments: [String], input: String? = nil, timeout: TimeInterval = 15) async -> CommandResult {
        guard let executable = arguments.first else { return CommandResult(success: false, stdout: "", stderr: "") }

        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = Array(arguments.dropFirst())
                var environment = ProcessInfo.processInfo.environment
                environment["PATH"] = searchDirectories.joined(separator: ":")
                process.environment = environment

                let stdout = Pipe()
                let stderr = Pipe()
                let stdin = Pipe()
                process.standardOutput = stdout
                process.standardError = stderr
                process.standardInput = stdin

                do {
                    try process.run()
                } catch {
                    continuation.resume(
                        returning: CommandResult(success: false, stdout: "", stderr: error.localizedDescription)
                    )
                    return
                }

                if let input { stdin.fileHandleForWriting.write(Data(input.utf8)) }
                try? stdin.fileHandleForWriting.close()

                let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)

                // Drain stderr concurrently so a chatty process can't fill its pipe and stall.
                let errBuffer = DataBox()
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async {
                    errBuffer.data = stderr.fileHandleForReading.readDataToEndOfFile()
                    group.leave()
                }
                let outData = stdout.fileHandleForReading.readDataToEndOfFile()
                group.wait()
                let errData = errBuffer.data
                process.waitUntilExit()
                watchdog.cancel()

                continuation.resume(
                    returning: CommandResult(
                        success: process.terminationStatus == 0 && process.terminationReason == .exit,
                        stdout: String(decoding: outData, as: UTF8.self),
                        stderr: String(decoding: errData, as: UTF8.self)
                    )
                )
            }
        }
    }
}

/// Written by one reader thread and read after `DispatchGroup.wait()`, which orders the accesses.
private final class DataBox: @unchecked Sendable {
    var data = Data()
}

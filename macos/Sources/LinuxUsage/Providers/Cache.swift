import Foundation

struct BackoffEntry: Codable, Sendable {
    var blockedUntil: String
    var failureCount: Int
    var lastError: String?
}

private struct BackoffState: Codable {
    var providers: [String: BackoffEntry] = [:]
}

/// Snapshot cache and per-provider exponential backoff, same files as the GNOME helper but under
/// `~/Library/Caches/<bundle id>/`.
enum Cache {
    private static let backoffBaseSeconds = 300.0
    private static let backoffMaxSeconds = 21600.0
    /// Providers fetch concurrently and each one read-modify-writes the shared backoff file.
    private static let backoffLock = NSLock()

    private static var directory: String {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.path
            ?? Paths.join(Paths.home, "Library", "Caches")
        return Paths.join(base, Bundle.main.bundleIdentifier ?? AppInfo.bundleIdentifier)
    }

    private static var snapshotPath: String { Paths.join(directory, "snapshot.json") }
    private static var backoffPath: String { Paths.join(directory, "provider-backoff.json") }

    static func loadSnapshot() -> Snapshot? {
        guard let data = FileManager.default.contents(atPath: snapshotPath) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    static func storeSnapshot(_ snapshot: Snapshot) {
        write(snapshot, to: snapshotPath)
    }

    static func activeBackoff(_ providerId: String) -> BackoffEntry? {
        backoffLock.lock()
        defer { backoffLock.unlock() }
        var state = loadBackoff()
        var changed = pruneExpired(&state)
        defer { if changed { write(state, to: backoffPath) } }

        guard let entry = state.providers[providerId] else { return nil }
        if (ISODate.parse(entry.blockedUntil) ?? .distantPast) <= Date() {
            state.providers[providerId] = nil
            changed = true
            return nil
        }
        return entry
    }

    @discardableResult
    static func recordFailure(_ providerId: String, lastError: String?) -> BackoffEntry {
        backoffLock.lock()
        defer { backoffLock.unlock() }
        var state = loadBackoff()
        _ = pruneExpired(&state)

        let failureCount = (state.providers[providerId]?.failureCount ?? 0) + 1
        let exponent = Double(min(failureCount - 1, 10))
        let seconds = min(backoffBaseSeconds * pow(2, exponent), backoffMaxSeconds)
        let entry = BackoffEntry(
            blockedUntil: ISODate.string(Date().addingTimeInterval(seconds)),
            failureCount: failureCount,
            lastError: lastError
        )
        state.providers[providerId] = entry
        write(state, to: backoffPath)
        return entry
    }

    static func clearBackoff(_ providerId: String) {
        backoffLock.lock()
        defer { backoffLock.unlock() }
        var state = loadBackoff()
        guard state.providers[providerId] != nil else { return }
        state.providers[providerId] = nil
        write(state, to: backoffPath)
    }

    private static func loadBackoff() -> BackoffState {
        guard let data = FileManager.default.contents(atPath: backoffPath),
            let state = try? JSONDecoder().decode(BackoffState.self, from: data)
        else { return BackoffState() }
        return state
    }

    private static func pruneExpired(_ state: inout BackoffState) -> Bool {
        let now = Date()
        let expired = state.providers.filter { (ISODate.parse($0.value.blockedUntil) ?? .distantPast) <= now }
        for key in expired.keys { state.providers[key] = nil }
        return !expired.isEmpty
    }

    private static func write<T: Encodable>(_ value: T, to path: String) {
        do {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(value).write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            // Cache writes are best effort, like the GNOME helper.
        }
    }
}

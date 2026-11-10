import Foundation

/// Port of `src/helper/registry.ts`: fetches every provider, applies the backoff, falls back to
/// the cached quotas on failure and stores the result.
enum Registry {
    typealias Fetcher = @Sendable (ProviderMetadata, ProviderOptions) async -> ProviderSnapshot

    private static let fetchers: [String: Fetcher] = [
        "claude": ClaudeProvider.fetch,
        "codex": CodexProvider.fetch,
    ]

    static func fetchAll(options: ProviderOptions) async -> Snapshot {
        let cached = Cache.loadSnapshot()

        // Providers are independent, so unlike the GJS helper they run concurrently.
        let providers = await withTaskGroup(of: (Int, ProviderSnapshot).self) { group in
            for (index, metadata) in ProviderCatalog.all.enumerated() {
                group.addTask {
                    (index, await fetchProvider(metadata, options: options, cached: cached))
                }
            }
            var results = [ProviderSnapshot?](repeating: nil, count: ProviderCatalog.all.count)
            for await (index, snapshot) in group { results[index] = snapshot }
            return results.compactMap { $0 }
        }

        let degraded = providers.contains { $0.status == .error || $0.status == .authRequired }
        let snapshot = Snapshot(
            generatedAt: ISODate.now(),
            overallStatus: degraded ? "degraded" : "ok",
            providers: providers
        )
        Cache.storeSnapshot(snapshot)
        return snapshot
    }

    static func fetchOne(_ providerId: String, options: ProviderOptions) async -> ProviderSnapshot? {
        guard let metadata = ProviderCatalog.all.first(where: { $0.id == providerId }) else { return nil }
        return await fetchProvider(metadata, options: options, cached: Cache.loadSnapshot())
    }

    private static func fetchProvider(_ metadata: ProviderMetadata, options: ProviderOptions, cached: Snapshot?) async
        -> ProviderSnapshot
    {
        let cachedProvider = cached?.providers.first { $0.providerId == metadata.id }

        if let backoff = Cache.activeBackoff(metadata.id) {
            return snapshotFromBackoff(metadata, cached: cachedProvider, backoff: backoff)
        }

        guard let fetcher = fetchers[metadata.id] else {
            return .status(metadata, .error, "No implementation for provider '\(metadata.id)'")
        }
        let snapshot = await fetcher(metadata, options)

        if snapshot.status == .error {
            Cache.recordFailure(metadata.id, lastError: snapshot.errorMessage)
        } else {
            Cache.clearBackoff(metadata.id)
        }
        return mergeStale(snapshot, cached: cachedProvider)
    }

    private static func mergeStale(_ snapshot: ProviderSnapshot, cached: ProviderSnapshot?) -> ProviderSnapshot {
        guard snapshot.status == .error, snapshot.primaryQuota == nil, let cached,
            cached.primaryQuota != nil || cached.secondaryQuota != nil
        else { return snapshot }

        var merged = snapshot
        merged.primaryQuota = cached.primaryQuota
        merged.secondaryQuota = cached.secondaryQuota
        merged.accountLabel = snapshot.accountLabel ?? cached.accountLabel
        merged.planLabel = snapshot.planLabel ?? cached.planLabel
        merged.sourceLabel = snapshot.sourceLabel ?? cached.sourceLabel
        if merged.detailLines.isEmpty { merged.detailLines = cached.detailLines }
        merged.status = .stale
        merged.stale = true
        return merged
    }

    private static func snapshotFromBackoff(_ metadata: ProviderMetadata, cached: ProviderSnapshot?, backoff: BackoffEntry)
        -> ProviderSnapshot
    {
        let message = "Refresh paused for \(backoffDuration(backoff.blockedUntil)) because of \(backoffReason(backoff.lastError))"

        if var snapshot = cached, snapshot.primaryQuota != nil || snapshot.secondaryQuota != nil {
            snapshot.status = .stale
            snapshot.stale = true
            snapshot.errorMessage = message
            snapshot.remediation = "Using cached data until the provider cooldown expires."
            return snapshot
        }
        return .status(metadata, .error, message, "Wait for the provider cooldown to expire before retrying.")
    }

    private static func backoffDuration(_ blockedUntil: String) -> String {
        let remaining = (ISODate.parse(blockedUntil) ?? Date()).timeIntervalSinceNow
        let totalSeconds = max(60, Int(remaining.rounded()))
        let totalMinutes = Int((Double(totalSeconds) / 60).rounded(.up))
        if totalMinutes >= 60 && totalMinutes % 60 == 0 {
            let hours = totalMinutes / 60
            return hours == 1 ? "1 hour" : "\(hours) hours"
        }
        return totalMinutes == 1 ? "1 minute" : "\(totalMinutes) minutes"
    }

    private static func backoffReason(_ lastError: String?) -> String {
        guard let lastError, !lastError.trimmingCharacters(in: .whitespaces).isEmpty else { return "recent failures" }
        let normalized = lastError.lowercased()
        if normalized.contains("rate-limit") || normalized.contains("rate limit") { return "rate-limit" }
        return lastError.replacingOccurrences(of: "^Provider ", with: "", options: .regularExpression)
    }
}

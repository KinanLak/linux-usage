import Foundation

/// Display rules ported from `src/extension/ui/popup.ts`.
enum Presentation {
    static let paceWarnLead = 10.0
    static let paceDangerLead = 25.0

    enum Tone {
        case ok, warn, info, error, muted
    }

    enum Pace {
        case ok, warn, danger
    }

    static func formatPercent(_ value: Double?) -> String {
        guard let value else { return "--" }
        return "\(jsRound(value))%"
    }

    static func titleCase(_ text: String?) -> String? {
        guard let text else { return nil }
        return text.split(separator: " ", omittingEmptySubsequences: false).map { word in
            word.isEmpty ? "" : word.prefix(1).uppercased() + word.dropFirst().lowercased()
        }.joined(separator: " ")
    }

    static func humanAge(_ iso: String?, now: Date) -> String {
        guard let iso else { return "Waiting for data" }
        guard let date = ISODate.parse(iso) else { return "Updated" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "Just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        return "\(seconds / 3600)h ago"
    }

    static func humanReset(_ quota: Quota, now: Date) -> String? {
        if let text = quota.resetText, !text.isEmpty { return text }
        guard let date = ISODate.parse(quota.resetAt) else { return nil }
        let seconds = max(0, Int(date.timeIntervalSince(now)))
        let days = seconds / 86400
        let hours = (seconds % 86400) / 3600
        let minutes = (seconds % 3600) / 60
        if seconds < 60 { return "Resets in <1m" }
        if days > 0 { return "Resets in \(days)d \(hours)h" }
        if hours > 0 { return "Resets in \(hours)h \(minutes)m" }
        return "Resets in \(minutes)m"
    }

    static func statusText(_ status: ProviderStatus) -> String {
        switch status {
        case .ok: "Healthy"
        case .stale: "Stale"
        case .refreshing: "Refreshing"
        case .unconfigured: "Setup needed"
        case .authRequired: "Auth needed"
        case .unavailable: "Offline"
        case .error: "Issue"
        }
    }

    static func detailStatusText(_ status: ProviderStatus) -> String? {
        switch status {
        case .stale: "Showing cached data"
        case .refreshing: "Refreshing provider data"
        case .unconfigured: "Not configured on this machine"
        case .authRequired: "Authentication required"
        case .unavailable: "Provider unavailable"
        case .error: "Something went wrong"
        case .ok: nil
        }
    }

    static func statusTone(_ status: ProviderStatus) -> Tone {
        switch status {
        case .ok: .ok
        case .stale: .warn
        case .refreshing: .info
        case .error, .authRequired: .error
        case .unconfigured, .unavailable: .muted
        }
    }

    struct StatusMessage {
        let title: String
        let hint: String
        let tone: Tone
    }

    @MainActor
    static func overviewMessage(_ store: UsageStore, providers: [ProviderSnapshot]) -> StatusMessage? {
        if store.snapshot == nil {
            if store.loading || store.requestState == .loading {
                return StatusMessage(
                    title: "Loading usage data…",
                    hint: "Contacting providers. Their status will appear here shortly.",
                    tone: .muted
                )
            }
            if store.requestState == .timeout {
                return StatusMessage(
                    title: "Still waiting for providers…",
                    hint: "No response yet. Retry in a moment or check your network connection.",
                    tone: .warn
                )
            }
            if store.requestState == .error {
                return StatusMessage(
                    title: "Unable to load provider data.",
                    hint: "Try again or open Preferences to inspect the setup.",
                    tone: .error
                )
            }
        }
        if providers.isEmpty {
            return StatusMessage(title: "No providers enabled.", hint: "Open Preferences to add one.", tone: .muted)
        }
        return nil
    }

    // MARK: - Quotas

    static func quotaPercent(_ quota: Quota?) -> Double {
        guard let quota else { return 0 }
        if quota.valueLabel == "Included" { return 100 }
        guard let used = quota.usedPercent, !used.isNaN else { return 0 }
        return clampPercent(used)
    }

    static func timeProgressPercent(_ quota: Quota?, now: Date) -> Double? {
        guard let quota else { return nil }
        let start = ISODate.parse(quota.periodStartAt)
        let end = ISODate.parse(quota.periodEndAt ?? quota.resetAt)
        if let start, let end {
            let total = end.timeIntervalSince(start)
            guard total > 0 else { return nil }
            return clampPercent(now.timeIntervalSince(start) / total * 100)
        }
        guard let end, let period = quota.periodSeconds, period > 0 else { return nil }
        let elapsed = period - end.timeIntervalSince(now)
        return clampPercent(elapsed / period * 100)
    }

    /// Pace = quota used minus period elapsed, in percentage points. A small lead is tolerated so
    /// early spikes in a fresh window don't immediately turn the bar red.
    static func pace(_ quota: Quota?, now: Date) -> Pace {
        let used = quotaPercent(quota)
        if used >= 100 { return .danger }
        guard let elapsed = timeProgressPercent(quota, now: now) else { return .ok }
        let ahead = used - elapsed
        if ahead > paceDangerLead { return .danger }
        if ahead > paceWarnLead { return .warn }
        return .ok
    }

    static func barTone(_ quota: Quota, now: Date) -> Tone {
        if quota.valueLabel == "Included" { return .info }
        switch pace(quota, now: now) {
        case .danger: return .error
        case .warn: return .warn
        case .ok: return .ok
        }
    }

    static func quotaWindow(_ quota: Quota) -> OverviewWindow? {
        if let period = quota.periodSeconds, period > 0 {
            if period < 86400 { return .session }
            if period <= 8 * 86400 { return .weekly }
            return nil
        }
        if quota.label.range(of: "session", options: .caseInsensitive) != nil { return .session }
        if quota.label.range(of: "week", options: .caseInsensitive) != nil { return .weekly }
        return nil
    }

    static func overviewQuota(_ provider: ProviderSnapshot, window: OverviewWindow) -> Quota? {
        let quotas = [provider.primaryQuota, provider.secondaryQuota].compactMap { $0 }
        guard !quotas.isEmpty else { return nil }
        return quotas.first { quotaWindow($0) == window } ?? provider.primaryQuota ?? quotas.first
    }

    /// Percentage shown next to the menu bar icon: the selected provider, or the most used one
    /// (`auto`), in the window picked by the popup's Session/Weekly toggle.
    static func panelUsage(_ providers: [ProviderSnapshot], window: OverviewWindow, provider: String, now: Date)
        -> (providerId: String, percent: Double, pace: Pace)?
    {
        let candidates = provider == "auto" ? providers : providers.filter { $0.providerId == provider }
        return candidates
            .compactMap { snapshot in overviewQuota(snapshot, window: window).map { (snapshot.providerId, $0) } }
            .filter { $0.1.usedPercent != nil || $0.1.valueLabel == "Included" }
            .map { (providerId: $0.0, percent: quotaPercent($0.1), pace: pace($0.1, now: now)) }
            .max { $0.percent < $1.percent }
    }

    static func isExtraLine(_ line: String) -> Bool {
        line.hasPrefix("Credits:") || line.hasPrefix("Extra usage:")
    }
}

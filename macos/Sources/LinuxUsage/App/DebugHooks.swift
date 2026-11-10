#if DEBUG
import AppKit
import Foundation

/// Debug-build launch flags (`make dev ARGS="…"`) for UI work without real credentials:
///   --sample           show a fixed snapshot covering the main states (no network)
///   --busy             with --sample, stay in the refreshing state (spinner in the refresh button)
///   --open-popup       open the menu bar popup once launched (works even when the item is hidden
///                      behind the notch or a menu bar manager)
///   --open-preferences open the preferences window once launched
@MainActor
enum DebugHooks {
    static let arguments = Set(CommandLine.arguments)

    static var useSample: Bool { arguments.contains("--sample") }

    static func afterLaunch(store: UsageStore) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if arguments.contains("--open-preferences") {
                PreferencesWindow.shared.show(store: store)
            }
            if arguments.contains("--open-popup") {
                StatusItemController.shared?.open()
            }
        }
    }

    static func sampleSnapshot(now: Date = Date()) -> Snapshot {
        func iso(_ offset: TimeInterval) -> String { ISODate.string(now.addingTimeInterval(offset)) }

        var codex = ProviderSnapshot(metadata: ProviderCatalog.all[0], status: .ok)
        codex.accountLabel = "user@example.com"
        codex.planLabel = "PLUS"
        codex.sourceLabel = "Local session + OpenAI usage API"
        codex.primaryQuota = Quota(label: "Session", usedPercent: 27, remainingPercent: 73)
        codex.primaryQuota?.resetAt = iso(2.5 * 3600)
        codex.primaryQuota?.periodSeconds = 5 * 3600
        codex.secondaryQuota = Quota(label: "Weekly", usedPercent: 58, remainingPercent: 42)
        codex.secondaryQuota?.resetAt = iso(4 * 86400 + 21 * 3600)
        codex.secondaryQuota?.periodSeconds = 7 * 86400
        codex.detailLines = ["Credits: 197.00"]

        var claude = ProviderSnapshot(metadata: ProviderCatalog.all[1], status: .stale)
        claude.stale = true
        claude.accountLabel = "Jane Doe"
        claude.planLabel = "Max 20x"
        claude.primaryQuota = Quota(label: "Session", usedPercent: 81, remainingPercent: 19)
        claude.primaryQuota?.resetAt = iso(3 * 3600)
        claude.primaryQuota?.periodSeconds = 5 * 3600
        claude.secondaryQuota = Quota(label: "Weekly", usedPercent: 34, remainingPercent: 66)
        claude.secondaryQuota?.resetAt = iso(2 * 86400)
        claude.secondaryQuota?.periodSeconds = 7 * 86400
        claude.detailLines = ["Extra usage: $4.20 / $50.00"]
        claude.errorMessage = "Refresh paused for 5 minutes because of rate-limit"
        claude.remediation = "Using cached data until the provider cooldown expires."

        return Snapshot(generatedAt: iso(-180), overallStatus: "ok", providers: [codex, claude])
    }
}
#endif

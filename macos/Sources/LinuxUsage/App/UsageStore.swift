import AppKit
import Foundation
import Observation

enum RequestState: Sendable {
    case loading, ready, timeout, error
}

/// Owns the snapshot and the refresh loop, like `LinuxUsageIndicator` + `HelperClient` on GNOME.
/// Providers are fetched in-process: no helper, no D-Bus.
@MainActor
@Observable
final class UsageStore {
    private static let timeoutSeconds: Double = 25

    let settings: AppSettings
    private(set) var snapshot: Snapshot?
    private(set) var loading = false
    private(set) var requestState: RequestState = .loading
    /// Provider id shown in the detail view, `nil` for the overview.
    private(set) var selectedProvider: String?

    @ObservationIgnored private var refreshLoop: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var wakeObserver: NSObjectProtocol?

    init(settings: AppSettings) {
        self.settings = settings
        let saved = settings.lastSelectedTab
        selectedProvider = saved == "overview" || saved.isEmpty ? nil : saved
        // Show the last known quotas immediately instead of an empty popup.
        snapshot = Cache.loadSnapshot()
        if snapshot != nil { requestState = .ready }

        settings.onRefreshIntervalChange = { [weak self] in self?.scheduleRefresh() }
        settings.onCredentialSourceChange = { [weak self] in self?.refresh(force: true) }
    }

    func start() {
        scheduleRefresh()
        refresh(force: false)
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh(force: false) }
        }
    }

    func scheduleRefresh() {
        refreshLoop?.cancel()
        let interval = settings.effectiveRefreshInterval
        refreshLoop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(interval))
                if Task.isCancelled { return }
                self?.refresh(force: false)
            }
        }
    }

    /// The GNOME helper runs the same full fetch for both calls (the backoff protects the APIs);
    /// `force` is kept for parity with `SnapshotJson` / `RefreshJson`.
    func refresh(force _: Bool) {
        guard !loading else { return }
        generation += 1
        let current = generation
        loading = true
        if snapshot == nil { requestState = .loading }

        let source = settings.credentialSource
        let fetch = Task.detached { await Registry.fetchAll(options: await ProviderOptions.current(source)) }

        // Like the helper timeout on GNOME: stop showing "loading" and allow a new refresh, but
        // still take the result if it arrives later and nothing newer started meanwhile.
        let watchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.timeoutSeconds))
            guard !Task.isCancelled, let self, current == self.generation, self.loading else { return }
            if self.snapshot == nil { self.requestState = .timeout }
            self.loading = false
        }

        Task { [weak self] in
            let result = await fetch.value
            watchdog.cancel()
            guard let self, current == self.generation else { return }
            self.snapshot = result
            self.requestState = .ready
            self.loading = false
        }
    }

    #if DEBUG
        func showSample(_ sample: Snapshot, busy: Bool = false) {
            snapshot = sample
            requestState = .ready
            loading = busy
        }
    #endif

    // MARK: - Navigation

    func navigate(to providerId: String?) {
        selectedProvider = providerId
        settings.lastSelectedTab = providerId ?? "overview"
    }

    // MARK: - Derived state

    var visibleProviders: [ProviderSnapshot] {
        guard let providers = snapshot?.providers else { return [] }
        let enabled = Set(settings.enabledProviderIds)
        if settings.enabledProviders == nil && enabled.isEmpty { return providers }
        return providers.filter { enabled.contains($0.providerId) }
    }

    /// Detail target, or `nil` when the saved provider was disabled since.
    var selectedSnapshot: ProviderSnapshot? {
        guard let selectedProvider else { return nil }
        return visibleProviders.first { $0.providerId == selectedProvider }
    }

    /// Provider and text next to the menu bar icon, e.g. `("claude", "48%")`.
    var trayUsage: (providerId: String, text: String)? {
        guard settings.panelShowUsage,
            let usage = Presentation.panelUsage(
                visibleProviders, window: settings.overviewQuotaWindow, provider: settings.panelProvider, now: Date()
            )
        else { return nil }
        return (usage.providerId, Presentation.formatPercent(usage.percent))
    }

    enum TrayIcon {
        case normal, refreshing, warning

        var symbol: String {
            switch self {
            case .normal: "cellularbars"
            case .refreshing: "arrow.clockwise"
            case .warning: "exclamationmark.triangle"
            }
        }
    }

    var trayIcon: TrayIcon {
        if loading && snapshot == nil { return .refreshing }
        if snapshot == nil && (requestState == .timeout || requestState == .error) { return .warning }
        let providers = visibleProviders
        let bad = providers.contains {
            $0.status == .error || $0.status == .authRequired || ($0.status == .stale && $0.errorMessage != nil)
        }
        if bad { return .warning }
        if !providers.isEmpty && providers.allSatisfy(\.stale) { return .refreshing }
        return .normal
    }
}

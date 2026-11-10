import Foundation
import Observation

enum CredentialSource: String, CaseIterable, Sendable, Identifiable {
    case auto
    case local
    case cliProxy = "cli-proxy"
    /// macOS only: a CLIProxyAPI server reached through its management API.
    case server = "cli-proxy-server"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: "Automatic"
        case .local: "CLI login"
        case .cliProxy: "Local CLIProxyAPI"
        case .server: "CLIProxyAPI server"
        }
    }

    var usesServer: Bool { self == .auto || self == .server }

    /// Read outside the main actor by the providers (and by the `snapshot` CLI command).
    static func current(_ defaults: UserDefaults = .standard) -> CredentialSource {
        CredentialSource(rawValue: defaults.string(forKey: AppSettings.Key.credentialSource) ?? "") ?? .auto
    }
}

enum OverviewWindow: String, Sendable {
    case session, weekly

    var label: String { self == .session ? "Session" : "Weekly" }
    var toggled: OverviewWindow { self == .session ? .weekly : .session }
}

/// UserDefaults-backed settings, one key per `org.gnome.shell.extensions.linux-usage` gschema key.
@MainActor
@Observable
final class AppSettings {
    enum Key {
        static let refreshInterval = "refresh-interval-seconds"
        static let enabledProviders = "enabled-providers"
        static let lastSelectedTab = "last-selected-tab"
        static let showSourceLabel = "show-source-label"
        static let showExtraCredits = "show-extra-credits"
        static let showTimeProgressMarker = "show-time-progress-marker"
        static let overviewQuotaWindow = "overview-quota-window"
        static let credentialSource = "credential-source"
        static let cliProxyURL = "cli-proxy-url"
        static let panelShowUsage = "panel-show-usage"
        static let panelProvider = "panel-provider"
    }

    static let refreshIntervalOptions: [(value: Int, label: String)] = [
        (30, "30 seconds"),
        (60, "1 minute"),
        (120, "2 minutes"),
        (180, "3 minutes"),
        (300, "5 minutes"),
        (600, "10 minutes"),
        (900, "15 minutes"),
    ]
    static let shortRefreshWarningMaxSeconds = 120

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored var onRefreshIntervalChange: (() -> Void)?
    @ObservationIgnored var onCredentialSourceChange: (() -> Void)?

    var refreshIntervalSeconds: Int {
        didSet {
            defaults.set(refreshIntervalSeconds, forKey: Key.refreshInterval)
            if oldValue != refreshIntervalSeconds { onRefreshIntervalChange?() }
        }
    }

    /// `nil` until the user toggles a provider, like an unset gsettings key.
    var enabledProviders: [String]? {
        didSet { defaults.set(enabledProviders, forKey: Key.enabledProviders) }
    }

    var lastSelectedTab: String {
        didSet { defaults.set(lastSelectedTab, forKey: Key.lastSelectedTab) }
    }

    var showSourceLabel: Bool {
        didSet { defaults.set(showSourceLabel, forKey: Key.showSourceLabel) }
    }

    var showExtraCredits: Bool {
        didSet { defaults.set(showExtraCredits, forKey: Key.showExtraCredits) }
    }

    var showTimeProgressMarker: Bool {
        didSet { defaults.set(showTimeProgressMarker, forKey: Key.showTimeProgressMarker) }
    }

    /// Percentage next to the menu bar icon.
    var panelShowUsage: Bool {
        didSet { defaults.set(panelShowUsage, forKey: Key.panelShowUsage) }
    }

    /// `auto` (highest usage among visible providers) or a provider id.
    var panelProvider: String {
        didSet { defaults.set(panelProvider, forKey: Key.panelProvider) }
    }

    var overviewQuotaWindow: OverviewWindow {
        didSet { defaults.set(overviewQuotaWindow.rawValue, forKey: Key.overviewQuotaWindow) }
    }

    var credentialSource: CredentialSource {
        didSet {
            defaults.set(credentialSource.rawValue, forKey: Key.credentialSource)
            if oldValue != credentialSource { onCredentialSourceChange?() }
        }
    }

    /// CLIProxyAPI server base URL; the management key is in the Keychain (`ManagementKeyStore`).
    var cliProxyURL: String {
        didSet {
            defaults.set(cliProxyURL, forKey: Key.cliProxyURL)
            if oldValue != cliProxyURL { onCredentialSourceChange?() }
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Key.refreshInterval: 300,
            Key.lastSelectedTab: "overview",
            Key.showSourceLabel: false,
            Key.showExtraCredits: true,
            Key.showTimeProgressMarker: true,
            Key.overviewQuotaWindow: OverviewWindow.session.rawValue,
            Key.credentialSource: CredentialSource.auto.rawValue,
            Key.panelShowUsage: true,
            Key.panelProvider: "auto",
        ])
        refreshIntervalSeconds = defaults.integer(forKey: Key.refreshInterval)
        enabledProviders = defaults.stringArray(forKey: Key.enabledProviders)
        lastSelectedTab = defaults.string(forKey: Key.lastSelectedTab) ?? "overview"
        showSourceLabel = defaults.bool(forKey: Key.showSourceLabel)
        showExtraCredits = defaults.bool(forKey: Key.showExtraCredits)
        showTimeProgressMarker = defaults.bool(forKey: Key.showTimeProgressMarker)
        panelShowUsage = defaults.bool(forKey: Key.panelShowUsage)
        panelProvider = defaults.string(forKey: Key.panelProvider) ?? "auto"
        overviewQuotaWindow = OverviewWindow(rawValue: defaults.string(forKey: Key.overviewQuotaWindow) ?? "") ?? .session
        credentialSource = CredentialSource.current(defaults)
        cliProxyURL = defaults.string(forKey: Key.cliProxyURL) ?? ""
    }

    var effectiveRefreshInterval: Int { max(30, refreshIntervalSeconds) }

    var enabledProviderIds: [String] { enabledProviders ?? ProviderCatalog.defaultEnabledIds }

    func isProviderEnabled(_ id: String) -> Bool { enabledProviderIds.contains(id) }

    func setProvider(_ id: String, enabled: Bool) {
        var current = Set(enabledProviderIds)
        if enabled { current.insert(id) } else { current.remove(id) }
        enabledProviders = ProviderCatalog.all.map(\.id).filter(current.contains)
    }
}

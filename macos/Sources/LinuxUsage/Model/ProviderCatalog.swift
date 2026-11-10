import Foundation

/// Same catalog as `src/extension/providers.json`.
struct ProviderMetadata: Sendable, Identifiable, Hashable {
    let id: String
    let title: String
    let description: String
    let iconName: String
    let defaultEnabled: Bool
}

enum ProviderCatalog {
    static let all: [ProviderMetadata] = [
        ProviderMetadata(
            id: "codex",
            title: "Codex",
            description: "OpenAI Codex session and weekly quota",
            iconName: "utilities-terminal-symbolic",
            defaultEnabled: true
        ),
        ProviderMetadata(
            id: "claude",
            title: "Claude",
            description: "Anthropic Claude quota and local auth state",
            iconName: "weather-overcast-symbolic",
            defaultEnabled: true
        ),
    ]

    static var defaultEnabledIds: [String] {
        let defaults = all.filter(\.defaultEnabled).map(\.id)
        return defaults.isEmpty ? all.map(\.id) : defaults
    }
}

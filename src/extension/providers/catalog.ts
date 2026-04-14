type ProviderCatalogEntry = {
    id: string;
    title: string;
    description: string;
    iconName: string;
    defaultEnabled: boolean;
};

const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
    {
        id: "codex",
        title: "Codex",
        description: "OpenAI Codex session and weekly quota",
        iconName: "utilities-terminal-symbolic",
        defaultEnabled: true,
    },
    {
        id: "claude",
        title: "Claude",
        description: "Anthropic Claude quota and local auth state",
        iconName: "weather-overcast-symbolic",
        defaultEnabled: true,
    },
    {
        id: "copilot",
        title: "Copilot",
        description: "GitHub Copilot premium interactions and included chat",
        iconName: "system-users-symbolic",
        defaultEnabled: true,
    },
];

function loadProviderCatalog(_extensionDir?: string): ProviderCatalogEntry[] {
    return PROVIDER_CATALOG.map((provider) => ({ ...provider }));
}

function getEnabledProviderIds(settings: any, providers: ProviderCatalogEntry[]) {
    if (settings.get_user_value("enabled-providers") !== null) return settings.get_strv("enabled-providers");

    const defaults = providers.filter((provider) => provider.defaultEnabled !== false).map((provider) => provider.id);

    if (defaults.length) return defaults;

    return providers.map((provider) => provider.id);
}

export const ProviderCatalog = {
    loadProviderCatalog,
    getEnabledProviderIds,
};

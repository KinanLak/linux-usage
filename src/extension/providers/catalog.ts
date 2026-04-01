import Gio from "gi://Gio";
import GLib from "gi://GLib";

const ByteArray = (globalThis as any).imports?.byteArray;

function bytesToString(bytes: Uint8Array | null | undefined) {
    if (!bytes) return "";
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    if (!ByteArray) throw new Error("ByteArray support is unavailable");
    return ByteArray.toString(bytes);
}

type ProviderCatalogEntry = {
    id: string;
    title: string;
    description: string;
    iconName: string;
    defaultEnabled: boolean;
};

function catalogPath(extensionDir: string) {
    return GLib.build_filenamev([extensionDir, "providers.json"]);
}

function loadProviderCatalog(extensionDir: string): ProviderCatalogEntry[] {
    const file = Gio.File.new_for_path(catalogPath(extensionDir));
    const [ok, contents] = file.load_contents(null);

    if (!ok) throw new Error("Unable to read providers.json");

    const catalog = JSON.parse(bytesToString(contents));
    if (!Array.isArray(catalog)) throw new Error("Provider catalog must be an array");

    return catalog
        .filter((provider) => provider && provider.id)
        .map((provider) => ({
            id: `${provider.id}`,
            title: provider.title ? `${provider.title}` : `${provider.id}`,
            description: provider.description ? `${provider.description}` : "",
            iconName: provider.iconName ? `${provider.iconName}` : "applications-system-symbolic",
            defaultEnabled: provider.defaultEnabled !== false,
        }));
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

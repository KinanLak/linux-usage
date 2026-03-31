/* oxlint-disable no-unused-vars */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;

type ProviderCatalogEntry = {
  id: string;
  title: string;
  description: string;
  iconName: string;
  defaultEnabled: boolean;
};

let ExtensionUtils = null;
try {
  ExtensionUtils = imports.misc.extensionUtils;
} catch {
  ExtensionUtils = null;
}

function catalogPath(extensionDir: string | null = null) {
  if (extensionDir) return GLib.build_filenamev([extensionDir, "providers.json"]);
  if (!ExtensionUtils) throw new Error("Extension directory is unavailable");
  return GLib.build_filenamev([ExtensionUtils.getCurrentExtension().path, "providers.json"]);
}

function loadProviderCatalog(extensionDir: string | null = null): ProviderCatalogEntry[] {
  const file = Gio.File.new_for_path(catalogPath(extensionDir));
  const [ok, contents] = file.load_contents(null);

  if (!ok) throw new Error("Unable to read providers.json");

  const catalog = JSON.parse(ByteArray.toString(contents));
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
  if (settings.get_user_value("enabled-providers") !== null)
    return settings.get_strv("enabled-providers");

  const defaults = providers
    .filter((provider) => provider.defaultEnabled !== false)
    .map((provider) => provider.id);

  if (defaults.length) return defaults;

  return providers.map((provider) => provider.id);
}

var ProviderCatalog = {
  loadProviderCatalog,
  getEnabledProviderIds,
};

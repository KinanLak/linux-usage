import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { Utils } from "./utils.js";

const SCHEMA_ID = "org.gnome.shell.extensions.linux-usage";

export type CredentialSource = "auto" | "local" | "cli-proxy";

export type ProviderOptions = {
    credentialSource: CredentialSource;
};

export type CliProxyAccount = {
    path: string;
    data: any;
};

function _lookupSchema(extensionDir: string): any | null {
    const defaultSource = Gio.SettingsSchemaSource.get_default();
    const schemaDir = GLib.build_filenamev([extensionDir, "schemas"]);
    if (Utils.fileExists(GLib.build_filenamev([schemaDir, "gschemas.compiled"]))) {
        const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, defaultSource, false);
        const schema = source.lookup(SCHEMA_ID, false);
        if (schema) return schema;
    }
    return defaultSource ? defaultSource.lookup(SCHEMA_ID, true) : null;
}

function credentialSource(extensionDir: string): CredentialSource {
    try {
        const schema = _lookupSchema(extensionDir);
        if (!schema || !schema.has_key("credential-source")) return "auto";
        const value = new Gio.Settings({ settings_schema: schema }).get_string("credential-source");
        return value === "local" || value === "cli-proxy" ? value : "auto";
    } catch {
        return "auto";
    }
}

function cliProxyAuthDir(): string {
    return GLib.build_filenamev([Utils.homeDir(), ".cli-proxy-api"]);
}

// CLIProxyAPI stores one JSON file per account (`claude-<email>.json`, `codex-<email>-<plan>.json`)
// with a `type` field. When several accounts match, the most recently written one wins: the proxy
// rewrites a file each time it refreshes that account's token.
function findCliProxyAccount(type: string): CliProxyAccount | null {
    const dir = Gio.File.new_for_path(cliProxyAuthDir());
    let enumerator: any;
    try {
        enumerator = dir.enumerate_children(
            "standard::name,standard::type,time::modified",
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
    } catch {
        return null;
    }

    let best: (CliProxyAccount & { mtime: number }) | null = null;
    try {
        let info: any;
        while ((info = enumerator.next_file(null)) !== null) {
            const name: string = info.get_name();
            if (!name.endsWith(".json") || info.get_file_type() !== Gio.FileType.REGULAR) continue;

            const path = GLib.build_filenamev([cliProxyAuthDir(), name]);
            let data: any;
            try {
                data = Utils.readJsonFile(path);
            } catch {
                continue;
            }
            if (!data || typeof data !== "object" || data.disabled === true) continue;

            const fileType = typeof data.type === "string" ? data.type : name.split("-")[0];
            if (fileType !== type) continue;

            const mtime = Number(info.get_attribute_uint64("time::modified"));
            if (!best || mtime > best.mtime) best = { path, data, mtime };
        }
    } finally {
        enumerator.close(null);
    }

    return best ? { path: best.path, data: best.data } : null;
}

export const Credentials = {
    credentialSource,
    cliProxyAuthDir,
    findCliProxyAccount,
};

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const BUS_NAME = "org.kinanl.LinuxUsage.Helper";
const OBJECT_PATH = "/org/kinanl/LinuxUsage/Helper";
const HELPER_TIMEOUT_MS = 8000;
const Me = Extension.lookupByURL(import.meta.url);

const HelperProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.kinanl.LinuxUsage.Helper">
    <method name="SnapshotJson">
      <arg name="snapshot" type="s" direction="out"/>
    </method>
    <method name="RefreshJson">
      <arg name="snapshot" type="s" direction="out"/>
    </method>
  </interface>
</node>`) as any;

function _settings() {
    if (!Me) throw new Error("Extension context is unavailable");
    return Me.getSettings("org.gnome.shell.extensions.linux-usage");
}

class HelperTimeoutError extends Error {
    constructor(action: string) {
        super(`Timed out waiting for the helper to ${action}.`);
        this.name = "HelperTimeoutError";
    }
}

function _withTimeout<T>(promise: Promise<T>, action: string): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HELPER_TIMEOUT_MS, () => {
            if (settled) return GLib.SOURCE_REMOVE;
            settled = true;
            reject(new HelperTimeoutError(action));
            return GLib.SOURCE_REMOVE;
        });

        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                GLib.Source.remove(timeoutId);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                GLib.Source.remove(timeoutId);
                reject(error);
            },
        );
    });
}

function _createProxy() {
    return new Promise((resolve, reject) => {
        try {
            new HelperProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (instance: any, error: unknown) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(instance);
            });
        } catch (error) {
            reject(error);
        }
    });
}

function _runCli(args: string[]) {
    return new Promise((resolve, reject) => {
        const customPath = _settings().get_string("helper-path");
        let command: string[];
        if (customPath && customPath !== "linux-usage-helper" && customPath !== "") {
            command = [customPath].concat(args);
        } else {
            if (!Me) throw new Error("Extension context is unavailable");
            const extensionDir = Me.path;
            const helperScript = `${extensionDir}/helper/helper.js`;
            command = ["gjs", "-m", helperScript].concat(args);
        }
        const subprocess = Gio.Subprocess.new(
            command,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
        subprocess.communicate_utf8_async(null, null, (proc: any, result: unknown) => {
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(result);
                if (!proc.get_successful()) {
                    reject(new Error(stderr || "Helper command failed"));
                    return;
                }
                resolve({
                    snapshot: JSON.parse(stdout),
                    helperMode: "cli",
                    helperLabel: "Helper on demand",
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function _runMethod(methodName: string) {
    try {
        const proxy: any = await _createProxy();
        const result = await new Promise((resolve, reject) => {
            proxy[`${methodName}Remote`]((value: any, error: unknown) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(value[0]);
            });
        });
        return {
            snapshot: JSON.parse(`${result}`),
            helperMode: "dbus",
            helperLabel: "Helper running",
        };
    } catch {
        return _runCli(["snapshot"]);
    }
}

async function getSnapshot() {
    return _withTimeout(_runMethod("SnapshotJson"), "respond");
}

async function refreshSnapshot() {
    return _withTimeout(_runMethod("RefreshJson"), "refresh");
}

function isHelperTimeoutError(error: unknown) {
    return error instanceof HelperTimeoutError || (error instanceof Error && error.name === "HelperTimeoutError");
}

export const HelperClient = {
    getSnapshot,
    refreshSnapshot,
    isHelperTimeoutError,
};

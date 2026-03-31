/* oxlint-disable no-unused-vars */

const Gio = imports.gi.Gio;
const ExtensionUtils = imports.misc.extensionUtils;

const BUS_NAME = "org.kinanl.LinuxUsage.Helper";
const OBJECT_PATH = "/org/kinanl/LinuxUsage/Helper";

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
</node>`);

function _settings() {
  return ExtensionUtils.getSettings("org.gnome.shell.extensions.linux-usage");
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
      const extensionDir = ExtensionUtils.getCurrentExtension().path;
      const helperScript = `${extensionDir}/helper/helper.js`;
      command = ["gjs", helperScript].concat(args);
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
  return _runMethod("SnapshotJson");
}

async function refreshSnapshot() {
  return _runMethod("RefreshJson");
}

var HelperClient = {
  getSnapshot,
  refreshSnapshot,
};

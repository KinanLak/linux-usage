/* oxlint-disable no-unused-vars */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const INTERFACE_XML = `
<node>
  <interface name="org.kinanl.LinuxUsage.Helper">
    <method name="SnapshotJson">
      <arg name="snapshot" type="s" direction="out"/>
    </method>
    <method name="RefreshJson">
      <arg name="snapshot" type="s" direction="out"/>
    </method>
  </interface>
</node>`;

function run(extensionDir: string): void {
  const { Registry } = imports.registry;

  const nodeInfo = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML);
  const connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);

  connection.register_object(
    "/org/kinanl/LinuxUsage/Helper",
    nodeInfo.interfaces[0],
    (
      _conn: any,
      _sender: any,
      _objectPath: any,
      _interfaceName: any,
      methodName: any,
      _parameters: any,
      invocation: any,
    ) => {
      try {
        let snapshot: any;
        if (methodName === "SnapshotJson") {
          snapshot = Registry.fetchCachedOrLive(extensionDir);
        } else if (methodName === "RefreshJson") {
          snapshot = Registry.fetchAll(extensionDir);
        } else {
          invocation.return_error_literal(
            Gio.DBusError,
            Gio.DBusError.UNKNOWN_METHOD,
            `Unknown method: ${methodName}`,
          );
          return;
        }
        invocation.return_value(GLib.Variant.new("(s)", [JSON.stringify(snapshot)]));
      } catch (error: any) {
        invocation.return_error_literal(
          Gio.DBusError,
          Gio.DBusError.FAILED,
          error.message || String(error),
        );
      }
    },
    null,
    null,
  );

  Gio.bus_own_name(
    Gio.BusType.SESSION,
    "org.kinanl.LinuxUsage.Helper",
    Gio.BusNameOwnerFlags.NONE,
    null,
    null,
    null,
  );

  const loop = GLib.MainLoop.new(null, false);
  loop.run();
}

var DbusService = { run };

#!/usr/bin/gjs

import GLib from "gi://GLib";
import System from "system";

import { DbusService } from "./dbus.js";
import { Registry } from "./registry.js";

const scriptDir = GLib.path_get_dirname(System.programInvocationName);

const extensionDir = GLib.path_get_dirname(scriptDir);

const args = ARGV;
const command = args[0] || "snapshot";

if (command === "snapshot") {
  const pretty = args.indexOf("--pretty") >= 0;
  const snapshot = Registry.fetchAll(extensionDir);
  print(pretty ? JSON.stringify(snapshot, null, 2) : JSON.stringify(snapshot));
} else if (command === "probe") {
  const providerId = args[1];
  if (!providerId) {
    printerr("Usage: helper.js probe <provider>");
    System.exit(1);
  }
  const snapshot = Registry.fetchOne(extensionDir, providerId);
  if (!snapshot) {
    printerr(`Unknown provider: ${providerId}`);
    System.exit(1);
  }
  print(JSON.stringify(snapshot, null, 2));
} else if (command === "serve-dbus") {
  DbusService.run(extensionDir);
} else {
  printerr(`Unknown command: ${command}`);
  System.exit(1);
}

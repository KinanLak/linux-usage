#!/usr/bin/gjs

import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import System from "system";

import { buildStandaloneWindow, loadCss } from "./prefs/prefs.js";

const scriptPath = GLib.path_get_dirname(System.programInvocationName);

const app = new Adw.Application({
  application_id: "org.kinanl.LinuxUsage.Preferences",
  flags: Gio.ApplicationFlags.HANDLES_OPEN,
});

let window: any = null;

app.connect("activate", () => {
  if (!window) {
    loadCss(scriptPath);
    window = buildStandaloneWindow(app, scriptPath);
    window.connect("close-request", () => {
      window = null;
      return false;
    });
  }

  window.present();
});

app.run([]);

#!/usr/bin/gjs

imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';

const Adw = imports.gi.Adw;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const System = imports.system;

const scriptPath = GLib.path_get_dirname(System.programInvocationName);
imports.searchPath.unshift(scriptPath);

const prefs = imports.src.prefs.prefs;

const app = new Adw.Application({
    application_id: 'org.kinanl.LinuxUsage.Preferences',
    flags: Gio.ApplicationFlags.HANDLES_OPEN,
});

let window = null;

app.connect('activate', () => {
    if (!window) {
        prefs.loadCss(scriptPath);
        window = prefs.buildStandaloneWindow(app, scriptPath);
        window.connect('close-request', () => {
            window = null;
            return false;
        });
    }

    window.present();
});

app.run([]);

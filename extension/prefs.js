imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';

const Me = imports.misc.extensionUtils.getCurrentExtension();
const prefs = Me.imports.src.prefs.prefs;

function init() {}

function buildPrefsWidget() {
    return prefs.buildPrefsWidget();
}

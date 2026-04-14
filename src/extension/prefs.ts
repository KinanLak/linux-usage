import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { buildPrefsWidget } from "./prefs-widget/prefs.js";

export default class LinuxUsagePreferences extends ExtensionPreferences {
    override getPreferencesWidget(): any {
        return buildPrefsWidget(this.getSettings("org.gnome.shell.extensions.linux-usage"), this.path);
    }
}

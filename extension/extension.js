const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;

const Me = ExtensionUtils.getCurrentExtension();
const { LinuxUsageIndicator } = Me.imports.src.ui.popup;

class LinuxUsageExtension {
    enable() {
        this._indicator = new LinuxUsageIndicator();
        Main.panel.addToStatusArea('linux-usage', this._indicator, 1, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}

function init() {
    return new LinuxUsageExtension();
}

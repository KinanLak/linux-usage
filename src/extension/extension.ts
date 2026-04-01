import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { LinuxUsageIndicator } from "./ui/popup.js";

export default class LinuxUsageExtension extends Extension {
  _indicator: any = null;

  override enable() {
    this._indicator = new LinuxUsageIndicator(0.0, this.metadata.name, true);
    Main.panel.addToStatusArea(this.uuid, this._indicator, 1, "right");
  }

  override disable() {
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
  }
}

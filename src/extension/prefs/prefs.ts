/* oxlint-disable no-unused-vars */

imports.gi.versions.Gtk = "4.0";
imports.gi.versions.Adw = "1";

const Adw = imports.gi.Adw;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const GLib = imports.gi.GLib;

let ExtensionUtils = null;
try {
  ExtensionUtils = imports.misc.extensionUtils;
} catch {
  ExtensionUtils = null;
}

let ProviderCatalog = null;
try {
  ProviderCatalog = imports.providers.catalog.ProviderCatalog;
} catch {
  if (ExtensionUtils)
    ProviderCatalog =
      ExtensionUtils.getCurrentExtension().imports.providers.catalog.ProviderCatalog;
}

const SCHEMA_ID = "org.gnome.shell.extensions.linux-usage";

function buildPrefsWidget() {
  const extensionDir = ExtensionUtils.getCurrentExtension().path;
  loadCss(extensionDir);
  const settings = ExtensionUtils.getSettings(SCHEMA_ID);
  const widget = buildPreferencesContent(settings, { standalone: false, extensionDir });
  widget.connect("realize", () => {
    const root = widget.get_root();
    if (root && root.set_default_size) root.set_default_size(820, 680);
  });
  return widget;
}

function buildStandaloneWindow(application: any, extensionDir: string) {
  const settings = createSettingsForExtension(extensionDir);
  const window = new Adw.ApplicationWindow({
    application,
    title: "Linux Usage Preferences",
    default_width: 860,
    default_height: 700,
  });
  window.set_resizable(false);

  const shell = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    css_classes: ["linux-usage-prefs-shell"],
  });
  shell.append(buildStandaloneTopbar(window));
  shell.append(buildPreferencesContent(settings, { standalone: true, extensionDir }));

  window.set_content(shell);
  return window;
}

function createSettingsForExtension(extensionDir: string) {
  const schemaDir = GLib.build_filenamev([extensionDir, "schemas"]);
  const source = Gio.SettingsSchemaSource.new_from_directory(
    schemaDir,
    Gio.SettingsSchemaSource.get_default(),
    false,
  );
  const schema = source.lookup(SCHEMA_ID, false);
  return new Gio.Settings({ settings_schema: schema });
}

function loadCss(extensionDir: string) {
  const provider = new Gtk.CssProvider();
  provider.load_from_path(GLib.build_filenamev([extensionDir, "prefs.css"]));
  Gtk.StyleContext.add_provider_for_display(
    Gdk.Display.get_default(),
    provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
  );
}

function buildPreferencesContent(
  settings: any,
  options: { standalone: boolean; extensionDir: string },
) {
  const providers = ProviderCatalog.loadProviderCatalog(options.extensionDir);
  const root = new Gtk.ScrolledWindow({
    hscrollbar_policy: Gtk.PolicyType.NEVER,
    propagate_natural_height: true,
    vexpand: true,
    css_classes: ["linux-usage-prefs-root"],
  });

  const clamp = new Adw.Clamp({
    maximum_size: 860,
    tightening_threshold: 640,
    margin_top: 28,
    margin_bottom: 28,
    margin_start: 24,
    margin_end: 24,
  });
  root.set_child(clamp);

  const page = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 26,
    css_classes: ["linux-usage-prefs-page"],
  });
  clamp.set_child(page);

  page.append(buildGeneralSection(settings));
  page.append(buildProvidersSection(settings, providers));

  return root;
}

function buildGeneralSection(settings: any) {
  const section = createSection(
    "General",
    "Core behavior for the helper, refresh cadence, and popup metadata.",
  );

  const helperEntry = new Gtk.Entry({
    hexpand: true,
    text: settings.get_string("helper-path"),
    placeholder_text: "linux-usage-helper",
    css_classes: ["linux-usage-prefs-input"],
  });
  helperEntry.connect("changed", (widget: any) => {
    settings.set_string("helper-path", widget.get_text());
  });
  section.card.append(
    createRow("Helper path", "Command or absolute path used to fetch snapshots.", helperEntry),
  );

  const refreshSpin = Gtk.SpinButton.new_with_range(60, 3600, 30);
  refreshSpin.set_value(settings.get_uint("refresh-interval-seconds"));
  refreshSpin.set_width_chars(6);
  refreshSpin.add_css_class("linux-usage-prefs-input");
  refreshSpin.connect("value-changed", (widget: any) => {
    settings.set_uint("refresh-interval-seconds", widget.get_value_as_int());
  });
  section.card.append(
    createRow("Refresh interval", "Automatic refresh cadence in seconds.", refreshSpin),
  );

  const sourceSwitch = new Gtk.Switch({
    active: settings.get_boolean("show-source-label"),
    valign: Gtk.Align.CENTER,
  });
  sourceSwitch.connect("notify::active", (widget: any) => {
    settings.set_boolean("show-source-label", widget.active);
  });
  section.card.append(
    createRow(
      "Show provider source",
      "Display labels like local session or GitHub token in the popup.",
      sourceSwitch,
    ),
  );

  const extraCreditsSwitch = new Gtk.Switch({
    active: settings.get_boolean("show-extra-credits"),
    valign: Gtk.Align.CENTER,
  });
  extraCreditsSwitch.connect("notify::active", (widget: any) => {
    settings.set_boolean("show-extra-credits", widget.active);
  });
  section.card.append(
    createRow(
      "Show extra credits",
      "Display supplemental credits and extra usage lines in provider details.",
      extraCreditsSwitch,
    ),
  );

  return section.box;
}

function buildProvidersSection(settings: any, providers: any[]) {
  const section = createSection(
    "Providers",
    "Choose which providers appear in the overview and detail tabs.",
  );

  providers.forEach((provider) => {
    const toggle = new Gtk.Switch({
      active: ProviderCatalog.getEnabledProviderIds(settings, providers).includes(provider.id),
      valign: Gtk.Align.CENTER,
    });
    toggle.connect("notify::active", (widget: any) => {
      const current = new Set(ProviderCatalog.getEnabledProviderIds(settings, providers));
      if (widget.active) current.add(provider.id);
      else current.delete(provider.id);
      settings.set_strv(
        "enabled-providers",
        providers.map((entry) => entry.id).filter((id) => current.has(id)),
      );
    });
    section.card.append(createRow(provider.title, provider.description, toggle));
  });

  return section.box;
}

function buildStandaloneTopbar(window: any) {
  const handle = new Gtk.WindowHandle();
  const bar = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    halign: Gtk.Align.FILL,
    css_classes: ["linux-usage-prefs-topbar"],
  });

  const titleBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    hexpand: true,
    spacing: 2,
  });
  titleBox.append(
    new Gtk.Label({
      label: "Linux Usage Preferences",
      xalign: 0,
      css_classes: ["linux-usage-prefs-topbar-title"],
    }),
  );
  titleBox.append(
    new Gtk.Label({
      label: "Popup behavior, providers, and helper settings",
      xalign: 0,
      css_classes: ["linux-usage-prefs-topbar-subtitle"],
    }),
  );

  const closeButton = new Gtk.Button({
    icon_name: "window-close-symbolic",
    valign: Gtk.Align.CENTER,
    css_classes: ["linux-usage-prefs-close-button"],
  });
  closeButton.connect("clicked", () => window.close());

  bar.append(titleBox);
  bar.append(closeButton);
  handle.set_child(bar);
  return handle;
}

function createSection(title: string, description: string) {
  const box = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 12,
  });

  box.append(
    new Gtk.Label({
      label: title,
      xalign: 0,
      css_classes: ["linux-usage-prefs-section-title"],
    }),
  );
  box.append(
    new Gtk.Label({
      label: description,
      xalign: 0,
      wrap: true,
      css_classes: ["linux-usage-prefs-section-description"],
    }),
  );

  const card = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 0,
    css_classes: ["linux-usage-prefs-card"],
  });
  box.append(card);

  return { box, card };
}

function createRow(title: string, description: string, suffixWidget: any) {
  const row = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 18,
    hexpand: true,
    css_classes: ["linux-usage-prefs-row"],
  });

  const textBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 4,
    hexpand: true,
  });
  textBox.append(
    new Gtk.Label({
      label: title,
      xalign: 0,
      css_classes: ["linux-usage-prefs-row-title"],
    }),
  );
  textBox.append(
    new Gtk.Label({
      label: description,
      xalign: 0,
      wrap: true,
      css_classes: ["linux-usage-prefs-row-description"],
    }),
  );
  row.append(textBox);

  const suffixBox = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    valign: Gtk.Align.CENTER,
  });
  suffixBox.append(suffixWidget);
  row.append(suffixBox);

  return row;
}

import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";

import { ProviderCatalog } from "../providers/catalog.js";

const SCHEMA_ID = "org.gnome.shell.extensions.linux-usage";
const REFRESH_INTERVAL_OPTIONS = [
    { value: 30, label: "30 seconds" },
    { value: 60, label: "1 minute" },
    { value: 120, label: "2 minutes" },
    { value: 180, label: "3 minutes" },
    { value: 300, label: "5 minutes" },
    { value: 600, label: "10 minutes" },
    { value: 900, label: "15 minutes" },
];
const SHORT_REFRESH_WARNING_MAX_SECONDS = 120;

function setWidgetCursor(widget: any, cursorName: string) {
    try {
        if (widget && widget.set_cursor_from_name) widget.set_cursor_from_name(cursorName);
    } catch {
        /* ignore cursor assignment failures */
    }
}

function attachCenteredTooltip(widget: any, text: string) {
    widget.set_has_tooltip(true);
    widget.connect("query-tooltip", (_widget: any, _x: number, _y: number, _keyboardMode: boolean, tooltip: any) => {
        const label = new Gtk.Label({
            label: text,
            justify: Gtk.Justification.CENTER,
            wrap: true,
            xalign: 0.5,
        });
        tooltip.set_custom(label);
        return true;
    });
}

export function buildPrefsWidget(settings: any, extensionDir: string) {
    loadCss(extensionDir);
    const widget = buildPreferencesContent(settings, { standalone: false, extensionDir });
    widget.connect("realize", () => {
        const root = widget.get_root() as any;
        if (root?.set_default_size) root.set_default_size(820, 680);
    });
    return widget;
}

export function buildStandaloneWindow(application: any, extensionDir: string) {
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
    if (!schema) throw new Error(`Missing settings schema: ${SCHEMA_ID}`);
    return new Gio.Settings({ settings_schema: schema });
}

export function loadCss(extensionDir: string) {
    const display = Gdk.Display.get_default();
    if (!display) return;
    const provider = new Gtk.CssProvider();
    provider.load_from_path(GLib.build_filenamev([extensionDir, "prefs.css"]));
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

function buildPreferencesContent(settings: any, options: { standalone: boolean; extensionDir: string }) {
    const providers = ProviderCatalog.loadProviderCatalog(options.extensionDir);
    const root = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        propagate_natural_height: true,
        vexpand: true,
        css_classes: ["linux-usage-prefs-root"],
    });
    setWidgetCursor(root, "default");

    const clamp = new Adw.Clamp({
        maximum_size: 860,
        tightening_threshold: 640,
        margin_top: 28,
        margin_bottom: 28,
        margin_start: 24,
        margin_end: 24,
    });
    setWidgetCursor(clamp, "default");
    root.set_child(clamp);

    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 26,
        css_classes: ["linux-usage-prefs-page"],
    });
    setWidgetCursor(page, "default");
    clamp.set_child(page);

    page.append(buildGeneralSection(settings));
    page.append(buildProvidersSection(settings, providers));

    return root;
}

function buildGeneralSection(settings: any) {
    const section = createSection("General", "Refresh cadence and popup metadata.");

    const refreshControl = buildRefreshIntervalControl(settings);
    section.card.append(
        createRow("Refresh interval", "Automatic refresh cadence for provider refreshes.", refreshControl),
    );

    const sourceSwitch = new Gtk.Switch({
        active: settings.get_boolean("show-source-label"),
        valign: Gtk.Align.CENTER,
    });
    setWidgetCursor(sourceSwitch, "pointer");
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
    setWidgetCursor(extraCreditsSwitch, "pointer");
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

    const timeMarkerSwitch = new Gtk.Switch({
        active: settings.get_boolean("show-time-progress-marker"),
        valign: Gtk.Align.CENTER,
    });
    setWidgetCursor(timeMarkerSwitch, "pointer");
    timeMarkerSwitch.connect("notify::active", (widget: any) => {
        settings.set_boolean("show-time-progress-marker", widget.active);
    });
    section.card.append(
        createRow(
            "Show time marker",
            "Display a vertical line in quota bars showing where the current date sits in the active period.",
            timeMarkerSwitch,
        ),
    );

    return section.box;
}

function buildRefreshIntervalControl(settings: any) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        valign: Gtk.Align.CENTER,
    });

    const warning = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        valign: Gtk.Align.CENTER,
        css_classes: ["linux-usage-prefs-warning"],
    });
    attachCenteredTooltip(warning, "Short refresh intervals\nincrease the risk of rate limiting.");
    setWidgetCursor(warning, "help");
    warning.append(
        new Gtk.Image({
            icon_name: "dialog-warning-symbolic",
            css_classes: ["linux-usage-prefs-warning-icon"],
        }),
    );
    setWidgetCursor(warning.get_last_child(), "help");

    const labels = Gtk.StringList.new(REFRESH_INTERVAL_OPTIONS.map((option) => option.label));
    const selectedIndex = refreshIntervalIndex(settings.get_uint("refresh-interval-seconds"));
    const dropdown = new Gtk.DropDown({
        model: labels,
        selected: selectedIndex,
        valign: Gtk.Align.CENTER,
        css_classes: ["linux-usage-prefs-input", "linux-usage-prefs-dropdown"],
    });
    setWidgetCursor(dropdown, "pointer");
    dropdown.set_factory(createRefreshDropdownFactory());
    dropdown.set_list_factory(createRefreshDropdownFactory());

    const syncWarning = (seconds: number) => {
        warning.set_visible(seconds <= SHORT_REFRESH_WARNING_MAX_SECONDS);
    };
    const initialOption = REFRESH_INTERVAL_OPTIONS[selectedIndex] || REFRESH_INTERVAL_OPTIONS[0];
    if (initialOption) syncWarning(initialOption.value);

    dropdown.connect("notify::selected", (widget: any) => {
        const index = widget.get_selected();
        const option = REFRESH_INTERVAL_OPTIONS[index] || REFRESH_INTERVAL_OPTIONS[0];
        if (!option) return;
        settings.set_uint("refresh-interval-seconds", option.value);
        syncWarning(option.value);
    });

    box.append(warning);
    box.append(dropdown);
    return box;
}

function createRefreshDropdownFactory() {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect("setup", (_factory: any, listItem: any) => {
        const label = new Gtk.Label({
            xalign: 0,
            valign: Gtk.Align.CENTER,
        });
        label.add_css_class("linux-usage-prefs-dropdown-label");
        listItem.set_child(label);
    });
    factory.connect("bind", (_factory: any, listItem: any) => {
        const label = listItem.get_child();
        const item = listItem.get_item();
        label.set_label(item ? item.get_string() : "");
    });
    return factory;
}

function refreshIntervalIndex(value: number) {
    const exactIndex = REFRESH_INTERVAL_OPTIONS.findIndex((option) => option.value === value);
    if (exactIndex >= 0) return exactIndex;
    const fallbackIndex = REFRESH_INTERVAL_OPTIONS.findIndex((option) => option.value === 300);
    return fallbackIndex >= 0 ? fallbackIndex : 0;
}

function buildProvidersSection(settings: any, providers: any[]) {
    const section = createSection("Providers", "Choose which providers appear in the overview and detail tabs.");

    providers.forEach((provider) => {
        const toggle = new Gtk.Switch({
            active: ProviderCatalog.getEnabledProviderIds(settings, providers).includes(provider.id),
            valign: Gtk.Align.CENTER,
        });
        setWidgetCursor(toggle, "pointer");
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
    setWidgetCursor(handle, "default");
    const bar = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        halign: Gtk.Align.FILL,
        css_classes: ["linux-usage-prefs-topbar"],
    });
    setWidgetCursor(bar, "default");

    const titleBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        spacing: 2,
    });
    setWidgetCursor(titleBox, "default");
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
    setWidgetCursor(closeButton, "pointer");
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
    setWidgetCursor(box, "default");

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
    setWidgetCursor(card, "default");
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
    setWidgetCursor(row, "default");

    const textBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        hexpand: true,
    });
    setWidgetCursor(textBox, "default");
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
    setWidgetCursor(suffixBox, "default");
    suffixBox.append(suffixWidget);
    row.append(suffixBox);

    return row;
}

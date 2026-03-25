imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';

const Adw = imports.gi.Adw;
const Gtk = imports.gi.Gtk;
const ExtensionUtils = imports.misc.extensionUtils;

function buildPrefsWidget() {
    const settings = ExtensionUtils.getSettings('org.kinanl.linux-usage');

    const page = new Adw.PreferencesPage({
        title: 'Linux Usage',
    });

    const generalGroup = new Adw.PreferencesGroup({
        title: 'General',
        description: 'Configure how the extension talks to the local helper.',
    });

    const helperRow = new Adw.ActionRow({
        title: 'Helper path',
        subtitle: 'Command or absolute path used to fetch snapshots',
    });
    const helperEntry = new Gtk.Entry({
        hexpand: true,
        text: settings.get_string('helper-path'),
    });
    helperEntry.connect('changed', widget => {
        settings.set_string('helper-path', widget.get_text());
    });
    helperRow.add_suffix(helperEntry);
    generalGroup.add(helperRow);

    const refreshRow = new Adw.ActionRow({
        title: 'Refresh interval',
        subtitle: 'Automatic refresh cadence in seconds',
    });
    const refreshSpin = Gtk.SpinButton.new_with_range(60, 3600, 30);
    refreshSpin.set_value(settings.get_uint('refresh-interval-seconds'));
    refreshSpin.connect('value-changed', widget => {
        settings.set_uint('refresh-interval-seconds', widget.get_value_as_int());
    });
    refreshRow.add_suffix(refreshSpin);
    generalGroup.add(refreshRow);

    const sourceRow = new Adw.SwitchRow({
        title: 'Show provider source',
        subtitle: 'Display labels like local session or GitHub token in the popup',
        active: settings.get_boolean('show-source-label'),
    });
    sourceRow.connect('notify::active', widget => {
        settings.set_boolean('show-source-label', widget.active);
    });
    generalGroup.add(sourceRow);

    const providersGroup = new Adw.PreferencesGroup({
        title: 'Providers',
        description: 'Enable or disable individual provider cards in the popup.',
    });

    ['codex', 'claude', 'copilot'].forEach(provider => {
        const row = new Adw.SwitchRow({
            title: provider.charAt(0).toUpperCase() + provider.slice(1),
            active: settings.get_strv('enabled-providers').includes(provider),
        });
        row.connect('notify::active', widget => {
            const current = new Set(settings.get_strv('enabled-providers'));
            if (widget.active)
                current.add(provider);
            else
                current.delete(provider);
            settings.set_strv('enabled-providers', Array.from(current));
        });
        providersGroup.add(row);
    });

    const groupBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 24,
        margin_end: 24,
    });
    page.add(generalGroup);
    page.add(providersGroup);
    groupBox.append(page);
    return groupBox;
}

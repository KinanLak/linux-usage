const { GObject, St, Gio, GLib } = imports.gi;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const { LinuxUsageState } = Me.imports.src.models.state;
const { HelperClient } = Me.imports.src.services.helper_client;
const { ProviderCatalog } = Me.imports.src.providers.catalog;

const PROGRESS_TRACK_WIDTH = 320;

function formatPercent(value) {
    if (value === null || value === undefined)
        return '--';
    return `${Math.round(value)}%`;
}

function humanAge(isoString) {
    if (!isoString)
        return 'Waiting for first refresh';

    const dt = GLib.DateTime.new_from_iso8601(isoString, null);
    if (!dt)
        return 'Recently updated';

    const diff = Math.max(0, Math.floor(GLib.DateTime.new_now_local().to_unix() - dt.to_unix()));
    if (diff < 60)
        return 'Updated just now';
    if (diff < 3600)
        return `Updated ${Math.floor(diff / 60)}m ago`;
    return `Updated ${Math.floor(diff / 3600)}h ago`;
}

function humanReset(resetText, resetAt) {
    if (resetText)
        return resetText;
    if (!resetAt)
        return null;

    const dt = GLib.DateTime.new_from_iso8601(resetAt, null);
    if (!dt)
        return null;

    const diff = Math.max(0, Math.floor(dt.to_unix() - GLib.DateTime.new_now_local().to_unix()));
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    const minutes = Math.floor((diff % 3600) / 60);

    if (diff < 60)
        return 'Resets in <1m';
    if (days > 0)
        return `Resets in ${days}d ${hours}h`;
    if (hours > 0)
        return `Resets in ${hours}h ${minutes}m`;
    return `Resets in ${minutes}m`;
}

function statusLabel(status) {
    switch (status) {
    case 'ok':
        return 'Healthy';
    case 'stale':
        return 'Stale';
    case 'refreshing':
        return 'Refreshing';
    case 'unconfigured':
        return 'Needs setup';
    case 'auth_required':
        return 'Sign in';
    case 'unavailable':
        return 'Unavailable';
    default:
        return 'Issue';
    }
}

function detailStatus(status) {
    switch (status) {
    case 'ok':
        return 'All good';
    case 'stale':
        return 'Showing cached data';
    case 'refreshing':
        return 'Refreshing provider';
    case 'unconfigured':
        return 'Not configured on this machine';
    case 'auth_required':
        return 'Authentication required';
    case 'unavailable':
        return 'Unavailable';
    default:
        return 'Needs attention';
    }
}

function statusClass(status) {
    switch (status) {
    case 'ok':
        return 'linux-usage-pill-ok';
    case 'stale':
        return 'linux-usage-pill-warning';
    case 'refreshing':
        return 'linux-usage-pill-info';
    case 'error':
    case 'auth_required':
        return 'linux-usage-pill-danger';
    default:
        return 'linux-usage-pill-muted';
    }
}

function providerMessageClass(provider, detailed = false) {
    const baseClass = detailed ? 'linux-usage-detail-error' : 'linux-usage-subtle';
    return `${baseClass} ${provider.status === 'stale' ? 'linux-usage-warning' : 'linux-usage-error'}`;
}

function providerColorClass(window) {
    if (window && window.valueLabel === 'Included')
        return 'linux-usage-progress-fill-info';
    const used = window && window.usedPercent !== null && window.usedPercent !== undefined ? window.usedPercent : 0;
    if (used >= 85)
        return 'linux-usage-progress-fill-danger';
    if (used >= 60)
        return 'linux-usage-progress-fill-warning';
    return 'linux-usage-progress-fill';
}

function isExtraCreditsLine(line) {
    return typeof line === 'string' && (line.startsWith('Credits:') || line.startsWith('Extra usage:'));
}

var LinuxUsageIndicator = GObject.registerClass(
class LinuxUsageIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Linux Usage');

        this._settings = ExtensionUtils.getSettings('org.kinanl.linux-usage');
        this._settingsSignals = [];
        this._state = new LinuxUsageState();
        this._providerCatalog = ProviderCatalog.loadProviderCatalog(Me.path);
        this._selectedTab = this._settings.get_string('last-selected-tab') || 'overview';
        this._refreshTimeoutId = 0;

        this.add_style_class_name('linux-usage-popup');

        this._icon = new St.Icon({
            icon_name: 'network-cellular-signal-excellent-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._rebuildMenu();
        });

        this._settingsSignals.push(
            this._settings.connect('changed::show-source-label', () => this._rebuildMenu())
        );
        this._settingsSignals.push(
            this._settings.connect('changed::show-extra-credits', () => this._rebuildMenu())
        );
        this._settingsSignals.push(
            this._settings.connect('changed::enabled-providers', () => this._rebuildMenu())
        );
        this._settingsSignals.push(
            this._settings.connect('changed::refresh-interval-seconds', () => this._scheduleRefresh())
        );

        this._scheduleRefresh();
        this._refresh(false);
    }

    destroy() {
        this._settingsSignals.forEach(signalId => this._settings.disconnect(signalId));
        this._settingsSignals = [];
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = 0;
        }
        super.destroy();
    }

    _scheduleRefresh() {
        if (this._refreshTimeoutId)
            GLib.source_remove(this._refreshTimeoutId);

        const interval = Math.max(60, this._settings.get_uint('refresh-interval-seconds'));
        this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh(force) {
        this._state.loading = true;
        this._rebuildMenu();

        try {
            const result = force ? await HelperClient.refreshSnapshot() : await HelperClient.getSnapshot();
            this._state.snapshot = result.snapshot;
            this._state.helperMode = result.helperMode;
            this._state.helperLabel = result.helperLabel;
            this._state.error = null;
        } catch (error) {
            this._state.error = `${error}`;
            this._state.helperMode = 'unknown';
            this._state.helperLabel = 'Helper unreachable';
        } finally {
            this._state.loading = false;
            this._updateIcon();
            this._rebuildMenu();
        }
    }

    _updateIcon() {
        const providers = this._visibleProviders();
        const degraded = providers.some(provider => ['error', 'auth_required'].includes(provider.status)
            || (provider.status === 'stale' && provider.errorMessage));
        const stale = providers.length > 0 && providers.every(provider => provider.stale);

        if (degraded)
            this._icon.set_icon_name('dialog-warning-symbolic');
        else if (stale)
            this._icon.set_icon_name('view-refresh-symbolic');
        else
            this._icon.set_icon_name('network-cellular-signal-excellent-symbolic');
    }

    _visibleProviders() {
        if (!this._state.snapshot || !this._state.snapshot.providers)
            return [];
        const enabled = new Set(ProviderCatalog.getEnabledProviderIds(this._settings, this._providerCatalog));
        if (this._settings.get_user_value('enabled-providers') === null && enabled.size === 0)
            return this._state.snapshot.providers;
        return this._state.snapshot.providers.filter(provider => enabled.has(provider.providerId));
    }

    _tabIds() {
        const providers = this._visibleProviders().map(provider => provider.providerId);
        if (!providers.length)
            return ['overview'];
        return ['overview'].concat(providers);
    }

    _rebuildMenu() {
        const tabIds = this._tabIds();
        if (!tabIds.includes(this._selectedTab))
            this._selectedTab = tabIds[0];

        this.menu.removeAll();

        this.menu.addMenuItem(this._buildTabsItem());
        this.menu.addMenuItem(this._buildContentItem());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._buildActionsItem());
    }

    _showSourceLabel() {
        return this._settings.get_boolean('show-source-label');
    }

    _showExtraCredits() {
        return this._settings.get_boolean('show-extra-credits');
    }

    _visibleDetailLines(provider) {
        if (!provider.detailLines)
            return [];
        if (this._showExtraCredits())
            return provider.detailLines;
        return provider.detailLines.filter(line => !isExtraCreditsLine(line));
    }

    _updatedText() {
        if (this._state.loading)
            return 'Refreshing now';
        if (this._state.snapshot)
            return humanAge(this._state.snapshot.generatedAt);
        return 'Waiting for first refresh';
    }

    _openPreferences() {
        try {
            const prefsScript = Me.dir.get_child('preferences-app.js').get_path();
            Gio.Subprocess.new(
                ['gjs', prefsScript],
                Gio.SubprocessFlags.NONE
            );
            return;
        } catch (_error) {
        }

        try {
            Gio.Subprocess.new(
                ['gnome-extensions', 'prefs', Me.metadata.uuid],
                Gio.SubprocessFlags.NONE
            );
            return;
        } catch (_error) {
        }

        if (ExtensionUtils.openPrefs)
            ExtensionUtils.openPrefs();
    }

    _buildTabsItem() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const box = new St.BoxLayout({ style_class: 'linux-usage-chip-row' });
        this._tabIds().forEach(tab => {
            const label = tab === 'overview' ? 'Overview' : tab.charAt(0).toUpperCase() + tab.slice(1);
            const button = new St.Button({
                label,
                style_class: `linux-usage-chip ${this._selectedTab === tab ? 'linux-usage-chip-active' : ''}`,
                can_focus: true,
            });
            button.connect('clicked', () => {
                this._selectedTab = tab;
                this._settings.set_string('last-selected-tab', tab);
                this._rebuildMenu();
            });
            box.add_child(button);
        });
        item.add_child(box);
        return item;
    }

    _buildContentItem() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const providers = this._visibleProviders();
        const box = new St.BoxLayout({ vertical: true, style_class: 'linux-usage-section linux-usage-content-card' });

        if (!providers.length) {
            box.add_child(new St.Label({
                text: 'No providers enabled in preferences.',
                style_class: 'linux-usage-subtle',
            }));
            item.add_child(box);
            return item;
        }

        if (this._selectedTab === 'overview') {
            providers.forEach(provider => box.add_child(this._buildOverviewRow(provider)));
        } else {
            const provider = providers.find(entry => entry.providerId === this._selectedTab) || providers[0];
            box.add_child(this._buildProviderCard(provider));
        }

        item.add_child(box);
        return item;
    }

    _buildOverviewRow(provider) {
        const button = new St.Button({ style_class: 'linux-usage-provider-row linux-usage-clickable', can_focus: true, track_hover: true, reactive: true });
        const row = new St.BoxLayout({ vertical: true, style_class: 'linux-usage-overview-row' });
        const header = new St.BoxLayout({ x_expand: true, style_class: 'linux-usage-space-between' });
        header.add_child(new St.Label({ text: provider.title, style_class: 'linux-usage-card-title' }));
        header.add_child(new St.Label({ text: statusLabel(provider.status), style_class: `linux-usage-status-pill ${statusClass(provider.status)}` }));
        row.add_child(header);

        if (!provider.primaryQuota) {
            row.add_child(new St.Label({
                text: detailStatus(provider.status),
                style_class: provider.errorMessage ? providerMessageClass(provider) : 'linux-usage-overview-summary',
            }));
        }

        if (provider.primaryQuota)
            row.add_child(this._buildQuotaBlock(provider.primaryQuota));
        if (provider.errorMessage)
            row.add_child(new St.Label({ text: provider.errorMessage, style_class: providerMessageClass(provider) }));

        button.set_child(row);
        button.connect('clicked', () => {
            this._selectedTab = provider.providerId;
            this._settings.set_string('last-selected-tab', provider.providerId);
            this._rebuildMenu();
        });
        return button;
    }

    _buildProviderCard(provider) {
        const card = new St.BoxLayout({ vertical: true, style_class: 'linux-usage-detail-card' });
        const titleRow = new St.BoxLayout({ style_class: 'linux-usage-space-between' });
        titleRow.add_child(new St.Label({ text: provider.title, style_class: 'linux-usage-card-title' }));
        titleRow.add_child(new St.Label({ text: statusLabel(provider.status), style_class: `linux-usage-status-pill ${statusClass(provider.status)}` }));
        card.add_child(titleRow);

        const meta = [provider.accountLabel, provider.planLabel].filter(Boolean).join(' · ');
        if (meta)
            card.add_child(new St.Label({ text: meta, style_class: 'linux-usage-detail-meta' }));
        if (provider.sourceLabel && this._showSourceLabel())
            card.add_child(new St.Label({ text: provider.sourceLabel, style_class: 'linux-usage-subtle' }));
        card.add_child(new St.Label({ text: detailStatus(provider.status), style_class: 'linux-usage-provider-status-line' }));

        if (provider.primaryQuota)
            card.add_child(this._buildQuotaBlock(provider.primaryQuota));
        if (provider.secondaryQuota)
            card.add_child(this._buildQuotaBlock(provider.secondaryQuota));

        this._visibleDetailLines(provider)
            .forEach(line => card.add_child(new St.Label({ text: line, style_class: 'linux-usage-detail-line' })));
        if (provider.errorMessage)
            card.add_child(new St.Label({ text: provider.errorMessage, style_class: providerMessageClass(provider, true) }));
        if (provider.remediation)
            card.add_child(new St.Label({ text: provider.remediation, style_class: 'linux-usage-detail-remediation' }));

        return card;
    }

    _buildQuotaBlock(window) {
        const box = new St.BoxLayout({ vertical: true, style_class: 'linux-usage-quota-block' });
        const titleRow = new St.BoxLayout({ x_expand: true, style_class: 'linux-usage-space-between' });
        titleRow.add_child(new St.Label({ text: window.label, style_class: 'linux-usage-quota-title' }));
        titleRow.add_child(new St.Label({ text: window.valueLabel || formatPercent(window.usedPercent), style_class: 'linux-usage-quota-value' }));
        box.add_child(titleRow);

        const track = new St.BoxLayout({ style_class: 'linux-usage-progress-track' });
        const normalizedPercent = window.valueLabel === 'Included'
            ? 100
            : Math.max(0, Math.min(100, window.usedPercent || 0));
        const fillWidth = normalizedPercent === 0 ? 0 : Math.round(normalizedPercent * PROGRESS_TRACK_WIDTH / 100);
        const fill = new St.Widget({
            style_class: `linux-usage-progress-fill ${providerColorClass(window)}`,
            style: `width: ${fillWidth}px;`,
        });
        track.add_child(fill);
        box.add_child(track);

        const resetLabel = humanReset(window.resetText, window.resetAt);
        if (resetLabel)
            box.add_child(new St.Label({ text: resetLabel, style_class: 'linux-usage-quota-meta' }));
        return box;
    }

    _buildActionsItem() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const box = new St.BoxLayout({ vertical: true, style_class: 'linux-usage-footer' });

        box.add_child(new St.Label({
            text: `${this._updatedText()}${this._state.helperMode === 'dbus' ? ' · Live helper' : ''}`,
            style_class: 'linux-usage-footer-status',
        }));

        const actions = new St.BoxLayout({ style_class: 'linux-usage-chip-row' });

        const prefsButton = new St.Button({
            label: 'Preferences',
            style_class: 'linux-usage-action-button linux-usage-clickable',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        prefsButton.connect('clicked', () => {
            this._openPreferences();
        });

        const refreshButton = new St.Button({
            label: this._state.loading ? 'Refreshing...' : 'Refresh now',
            style_class: 'linux-usage-primary-button linux-usage-clickable',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        refreshButton.connect('clicked', () => this._refresh(true));

        actions.add_child(refreshButton);
        actions.add_child(prefsButton);
        box.add_child(actions);
        item.add_child(box);
        return item;
    }
});

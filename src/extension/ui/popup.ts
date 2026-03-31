/* oxlint-disable no-unused-vars */

const { GObject, St, Gio, GLib, Clutter, Meta, Pango } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const { LinuxUsageState } = Me.imports.models.state;
const { HelperClient } = Me.imports.services.helper_client;
const { ProviderCatalog } = Me.imports.providers.catalog;

const OVERVIEW_ALERT_THRESHOLD = 80;
const TOOLTIP_OFFSET = 8;
const TOOLTIP_ANIMATION_MS = 120;

type Quota = {
  label: string;
  usedPercent?: number | null;
  valueLabel?: string | null;
  resetText?: string | null;
  resetAt?: string | null;
};

type ProviderSnapshot = {
  providerId: string;
  title: string;
  status: string;
  stale?: boolean;
  errorMessage?: string | null;
  remediation?: string | null;
  accountLabel?: string | null;
  planLabel?: string | null;
  sourceLabel?: string | null;
  detailLines?: string[] | null;
  primaryQuota?: Quota | null;
  secondaryQuota?: Quota | null;
};

type Snapshot = {
  generatedAt?: string | null;
  providers?: ProviderSnapshot[] | null;
};

function fmtPct(v: number | null | undefined) {
  if (v === null || v === undefined) return "--";
  return `${Math.round(v)}%`;
}

function titleCase(text: string | null | undefined) {
  if (!text) return text;
  return text
    .split(/\s+/)
    .map((word) => (word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : word))
    .join(" ");
}

function humanAge(iso: string | null | undefined) {
  if (!iso) return "Waiting for data";
  const dt = GLib.DateTime.new_from_iso8601(iso, null);
  if (!dt) return "Updated";
  const s = Math.max(0, Math.floor(GLib.DateTime.new_now_local().to_unix() - dt.to_unix()));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function humanReset(text: string | null | undefined, at: string | null | undefined) {
  if (text) return text;
  if (!at) return null;
  const dt = GLib.DateTime.new_from_iso8601(at, null);
  if (!dt) return null;
  const s = Math.max(0, Math.floor(dt.to_unix() - GLib.DateTime.new_now_local().to_unix()));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (s < 60) return "Resets in <1m";
  if (d > 0) return `Resets in ${d}d ${h}h`;
  if (h > 0) return `Resets in ${h}h ${m}m`;
  return `Resets in ${m}m`;
}

function wrapLabel(text: string, styleClass: string) {
  const label = new St.Label({
    text,
    style_class: styleClass,
    x_expand: true,
    x_align: Clutter.ActorAlign.START,
  });
  label.clutter_text.set_single_line_mode(false);
  label.clutter_text.set_line_wrap(true);
  label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
  label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
  return label;
}

function statusText(status: string) {
  switch (status) {
    case "ok":
      return "Healthy";
    case "stale":
      return "Stale";
    case "refreshing":
      return "Refreshing";
    case "unconfigured":
      return "Setup needed";
    case "auth_required":
      return "Auth needed";
    case "unavailable":
      return "Offline";
    default:
      return "Issue";
  }
}

function detailStatusText(status: string) {
  switch (status) {
    case "stale":
      return "Showing cached data";
    case "refreshing":
      return "Refreshing provider data";
    case "unconfigured":
      return "Not configured on this machine";
    case "auth_required":
      return "Authentication required";
    case "unavailable":
      return "Provider unavailable";
    case "error":
      return "Something went wrong";
    default:
      return null;
  }
}

function dotClass(status: string) {
  switch (status) {
    case "ok":
      return "lu-dot-ok";
    case "stale":
      return "lu-dot-warn";
    case "refreshing":
      return "lu-dot-info";
    case "error":
    case "auth_required":
      return "lu-dot-err";
    default:
      return "lu-dot-muted";
  }
}

function barColorClass(w: Quota | null | undefined) {
  if (w && w.valueLabel === "Included") return "lu-fill-info";
  const u = quotaPercent(w);
  if (u >= 85) return "lu-fill-danger";
  if (u >= 60) return "lu-fill-warn";
  return "";
}

function quotaPercent(quota: Quota | null | undefined) {
  if (!quota) return 0;
  if (quota.valueLabel === "Included") return 100;
  const used = quota.usedPercent;
  if (used === null || used === undefined || Number.isNaN(used)) return 0;
  return Math.max(0, Math.min(100, used));
}

function isExtraLine(line: unknown) {
  return (
    typeof line === "string" && (line.startsWith("Credits:") || line.startsWith("Extra usage:"))
  );
}

var LinuxUsageIndicator = GObject.registerClass(
  class LinuxUsageIndicator extends PanelMenu.Button {
    _settings: any;
    _settingsSignals: number[];
    _menuSignalId: number;
    _state: any;
    _providerCatalog: any[];
    _selectedProvider: string | null;
    _refreshTimeoutId: number;
    _refreshGeneration: number;
    _destroyed: boolean;
    _icon: any;

    _init() {
      super._init(0.0, "Linux Usage");
      this._settings = ExtensionUtils.getSettings("org.gnome.shell.extensions.linux-usage");
      this._settingsSignals = [];
      this._menuSignalId = 0;
      this._state = new LinuxUsageState();
      this._providerCatalog = ProviderCatalog.loadProviderCatalog(Me.path);
      const saved = this._settings.get_string("last-selected-tab");
      this._selectedProvider = saved === "overview" ? null : saved || null;
      this._refreshTimeoutId = 0;
      this._refreshGeneration = 0;
      this._destroyed = false;

      this.add_style_class_name("lu-popup");
      this._icon = new St.Icon({
        icon_name: "network-cellular-signal-excellent-symbolic",
        style_class: "system-status-icon",
      });
      this.add_child(this._icon);
      this._attachPointerCursor(this);

      this.menu.box.add_style_class_name("lu-menu");

      this._menuSignalId = this.menu.connect("open-state-changed", (_: unknown, open: boolean) => {
        if (open && !this._destroyed) this._rebuildMenu();
      });

      ["show-source-label", "show-extra-credits", "enabled-providers"].forEach((key) =>
        this._settingsSignals.push(
          this._settings.connect(`changed::${key}`, () => this._rebuildMenu()),
        ),
      );
      this._settingsSignals.push(
        this._settings.connect("changed::refresh-interval-seconds", () => this._scheduleRefresh()),
      );

      this._scheduleRefresh();
      void this._refresh(false);
    }

    destroy() {
      this._destroyed = true;
      this._refreshGeneration += 1;
      this._state.loading = false;

      if (this._menuSignalId) {
        this.menu.disconnect(this._menuSignalId);
        this._menuSignalId = 0;
      }

      this._settingsSignals.forEach((id) => this._settings.disconnect(id));
      this._settingsSignals = [];

      if (this._refreshTimeoutId) {
        GLib.Source.remove(this._refreshTimeoutId);
        this._refreshTimeoutId = 0;
      }

      super.destroy();
    }

    _scheduleRefresh() {
      if (this._refreshTimeoutId) {
        GLib.Source.remove(this._refreshTimeoutId);
        this._refreshTimeoutId = 0;
      }

      if (this._destroyed) return;

      const sec = Math.max(60, this._settings.get_uint("refresh-interval-seconds"));
      this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, sec, () => {
        void this._refresh(false);
        return GLib.SOURCE_CONTINUE;
      });
    }

    async _refresh(force: boolean) {
      if (this._destroyed || this._state.loading) return;

      const refreshGeneration = ++this._refreshGeneration;
      this._state.loading = true;
      this._rebuildMenu();

      try {
        const r = force ? await HelperClient.refreshSnapshot() : await HelperClient.getSnapshot();

        if (this._destroyed || refreshGeneration !== this._refreshGeneration) return;

        this._state.snapshot = r.snapshot as Snapshot;
        this._state.helperMode = r.helperMode;
        this._state.helperLabel = r.helperLabel;
        this._state.error = null;
      } catch (e) {
        if (this._destroyed || refreshGeneration !== this._refreshGeneration) return;

        this._state.error = `${e}`;
        this._state.helperMode = "unknown";
        this._state.helperLabel = "Helper unreachable";
      } finally {
        if (!this._destroyed && refreshGeneration === this._refreshGeneration) {
          this._state.loading = false;
          this._updateIcon();
          this._rebuildMenu();
        }
      }
    }

    _updateIcon() {
      const ps = this._visibleProviders();
      const bad = ps.some(
        (p) =>
          ["error", "auth_required"].includes(p.status) || (p.status === "stale" && p.errorMessage),
      );
      const stale = ps.length > 0 && ps.every((p) => p.stale);
      this._icon.set_icon_name(
        bad
          ? "dialog-warning-symbolic"
          : stale
            ? "view-refresh-symbolic"
            : "network-cellular-signal-excellent-symbolic",
      );
    }

    _visibleProviders(): ProviderSnapshot[] {
      if (!this._state.snapshot || !this._state.snapshot.providers) return [];
      const en = new Set(
        ProviderCatalog.getEnabledProviderIds(this._settings, this._providerCatalog),
      );
      if (this._settings.get_user_value("enabled-providers") === null && en.size === 0)
        return this._state.snapshot.providers;
      return this._state.snapshot.providers.filter((p: ProviderSnapshot) => en.has(p.providerId));
    }

    _showExtraCredits() {
      return this._settings.get_boolean("show-extra-credits");
    }

    _showSourceLabel() {
      return this._settings.get_boolean("show-source-label");
    }

    _visibleDetailLines(provider: ProviderSnapshot) {
      if (!provider.detailLines) return [];
      return this._showExtraCredits()
        ? provider.detailLines
        : provider.detailLines.filter((line) => !isExtraLine(line));
    }

    _navigate(providerId: string | null) {
      this._selectedProvider = providerId;
      this._settings.set_string("last-selected-tab", providerId || "overview");
      this._rebuildMenu();
    }

    _rebuildMenu() {
      if (this._destroyed) return;

      const providers = this._visibleProviders();
      if (this._selectedProvider && !providers.find((p) => p.providerId === this._selectedProvider))
        this._selectedProvider = null;

      this.menu.removeAll();

      if (this._selectedProvider) {
        const provider = providers.find((p) => p.providerId === this._selectedProvider);
        if (provider) this.menu.addMenuItem(this._buildDetailView(provider));
      } else {
        this.menu.addMenuItem(this._buildHeader());
        this.menu.addMenuItem(this._buildOverview(providers));
      }

      this.menu.addMenuItem(this._buildFooter());
    }

    _makeItem() {
      const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
      item.add_style_class_name("lu-item");
      item.remove_style_class_name("popup-menu-item");
      if (item._ornamentLabel) item._ornamentLabel.visible = false;
      if (item._ornamentIcon) item._ornamentIcon.visible = false;
      return item;
    }

    _buildHeader() {
      const item = this._makeItem();
      const box = new St.BoxLayout({ style_class: "lu-header", x_expand: true });
      box.add_child(new St.Label({ text: "Linux Usage", style_class: "lu-title", x_expand: true }));
      item.add_child(box);
      return item;
    }

    _buildOverview(providers: ProviderSnapshot[]) {
      const item = this._makeItem();
      const box = new St.BoxLayout({ vertical: true, style_class: "lu-card", x_expand: true });

      if (!providers.length) {
        box.add_child(
          new St.Label({
            text: "No providers enabled.",
            style_class: "lu-empty",
          }),
        );
        box.add_child(
          new St.Label({
            text: "Open Preferences to add one.",
            style_class: "lu-empty-hint",
          }),
        );
        item.add_child(box);
        return item;
      }

      providers.forEach((provider, i) => {
        box.add_child(this._buildOverviewRow(provider));
        if (i < providers.length - 1) box.add_child(new St.Widget({ style_class: "lu-divider" }));
      });

      item.add_child(box);
      return item;
    }

    _buildOverviewRow(provider: ProviderSnapshot) {
      const btn = new St.Button({
        style_class: "lu-row lu-clickable",
        can_focus: true,
        track_hover: true,
        reactive: true,
      });
      this._attachPointerCursor(btn);
      const col = new St.BoxLayout({ vertical: true, style_class: "lu-row-inner", x_expand: true });

      const top = new St.BoxLayout({ style_class: "lu-row-top" });
      top.add_child(
        new St.Label({
          text: provider.title,
          style_class: "lu-row-name",
          x_expand: true,
        }),
      );
      if (provider.status !== "ok") {
        const statusBox = new St.BoxLayout({ style_class: "lu-status-box" });
        statusBox.add_child(
          new St.Label({
            text: "\u25CF",
            style_class: `lu-dot-text ${dotClass(provider.status)}`,
          }),
        );
        statusBox.add_child(
          new St.Label({
            text: statusText(provider.status),
            style_class: "lu-status-label",
          }),
        );
        top.add_child(statusBox);
      }
      top.add_child(
        new St.Icon({
          icon_name: "go-next-symbolic",
          style_class: "lu-chevron",
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );
      col.add_child(top);

      const overviewQuota = this._selectOverviewQuota(provider);
      if (overviewQuota) {
        col.add_child(this._buildBar(overviewQuota));
        col.add_child(this._buildOverviewMeta(overviewQuota));
      } else {
        col.add_child(
          new St.Label({
            text: detailStatusText(provider.status) || statusText(provider.status),
            style_class: "lu-row-meta",
          }),
        );
      }

      if (provider.errorMessage) {
        col.add_child(
          wrapLabel(
            provider.errorMessage,
            provider.status === "stale" ? "lu-warn-text" : "lu-err-text",
          ),
        );
      }

      btn.set_child(col);
      btn.connect("clicked", () => this._navigate(provider.providerId));
      return btn;
    }

    _buildDetailView(provider: ProviderSnapshot) {
      const item = this._makeItem();
      const box = new St.BoxLayout({ vertical: true, style_class: "lu-detail", x_expand: true });

      const back = new St.Button({
        style_class: "lu-back lu-clickable",
        can_focus: true,
        track_hover: true,
        reactive: true,
      });
      this._attachPointerCursor(back);
      const backInner = new St.BoxLayout({ style_class: "lu-back-row" });
      backInner.add_child(new St.Label({ text: "\u2190", style_class: "lu-back-arrow" }));
      backInner.add_child(new St.Label({ text: "Overview", style_class: "lu-back-text" }));
      back.set_child(backInner);
      back.connect("clicked", () => this._navigate(null));
      box.add_child(back);

      const titleRow = new St.BoxLayout({ style_class: "lu-detail-title-row" });
      titleRow.add_child(
        new St.Label({
          text: provider.title,
          style_class: "lu-detail-name",
          x_expand: true,
        }),
      );
      const statusBox = new St.BoxLayout({ style_class: "lu-status-box" });
      statusBox.add_child(
        new St.Label({
          text: "\u25CF",
          style_class: `lu-dot-text ${dotClass(provider.status)}`,
        }),
      );
      statusBox.add_child(
        new St.Label({
          text: statusText(provider.status),
          style_class: "lu-status-label",
        }),
      );
      titleRow.add_child(statusBox);
      box.add_child(titleRow);

      const meta = [provider.accountLabel, titleCase(provider.planLabel)]
        .filter(Boolean)
        .join(" \u00B7 ");
      if (meta) box.add_child(new St.Label({ text: meta, style_class: "lu-detail-meta" }));
      if (provider.sourceLabel && this._showSourceLabel())
        box.add_child(
          new St.Label({ text: provider.sourceLabel, style_class: "lu-detail-source" }),
        );

      const statusMsg = detailStatusText(provider.status);
      if (provider.status === "stale" && provider.remediation) {
        box.add_child(wrapLabel(provider.remediation, "lu-remedy"));
      } else if (statusMsg) {
        box.add_child(new St.Label({ text: statusMsg, style_class: "lu-detail-status" }));
      }

      if (provider.primaryQuota) box.add_child(this._buildQuotaBlock(provider.primaryQuota));
      if (provider.secondaryQuota) box.add_child(this._buildQuotaBlock(provider.secondaryQuota));

      const lines = this._visibleDetailLines(provider);
      if (lines.length > 0) {
        const linesBox = new St.BoxLayout({ vertical: true, style_class: "lu-lines" });
        lines.forEach((line) =>
          linesBox.add_child(new St.Label({ text: line, style_class: "lu-detail-line" })),
        );
        box.add_child(linesBox);
      }

      if (provider.errorMessage) {
        box.add_child(
          wrapLabel(
            provider.errorMessage,
            provider.status === "stale" ? "lu-warn-text" : "lu-err-text",
          ),
        );
      }
      if (provider.remediation && provider.status !== "stale")
        box.add_child(wrapLabel(provider.remediation, "lu-remedy"));

      item.add_child(box);
      return item;
    }

    _selectOverviewQuota(provider: ProviderSnapshot) {
      const quotas = [provider.primaryQuota, provider.secondaryQuota].filter(Boolean) as Quota[];
      if (!quotas.length) return null;

      const highestQuota = quotas.reduce((best, quota) =>
        quotaPercent(quota) > quotaPercent(best) ? quota : best,
      );

      if (quotaPercent(highestQuota) >= OVERVIEW_ALERT_THRESHOLD) return highestQuota;

      return provider.primaryQuota || highestQuota;
    }

    _buildOverviewMeta(q: Quota) {
      const meta = new St.BoxLayout({ style_class: "lu-row-meta-box" });
      const labelClass =
        quotaPercent(q) >= OVERVIEW_ALERT_THRESHOLD ? "lu-row-meta-alert" : "lu-row-meta";

      meta.add_child(
        new St.Label({
          text: q.valueLabel || fmtPct(quotaPercent(q)),
          style_class: "lu-row-meta",
        }),
      );
      meta.add_child(new St.Label({ text: "·", style_class: "lu-row-meta-sep" }));
      meta.add_child(new St.Label({ text: q.label, style_class: labelClass }));

      const reset = humanReset(q.resetText, q.resetAt);
      if (reset) {
        meta.add_child(new St.Label({ text: "·", style_class: "lu-row-meta-sep" }));
        meta.add_child(new St.Label({ text: reset, style_class: "lu-row-meta" }));
      }

      return meta;
    }

    _buildQuotaBlock(q: Quota) {
      const block = new St.BoxLayout({ vertical: true, style_class: "lu-quota" });

      const top = new St.BoxLayout({ style_class: "lu-quota-top" });
      top.add_child(
        new St.Label({
          text: q.label,
          style_class: "lu-quota-label",
          x_expand: true,
        }),
      );
      top.add_child(
        new St.Label({
          text: q.valueLabel || fmtPct(q.usedPercent),
          style_class: "lu-quota-value",
        }),
      );
      block.add_child(top);

      block.add_child(this._buildBar(q));

      const reset = humanReset(q.resetText, q.resetAt);
      if (reset) block.add_child(new St.Label({ text: reset, style_class: "lu-quota-reset" }));

      return block;
    }

    _buildBar(q: Quota) {
      const track = new St.Widget({
        style_class: "lu-bar-track",
        x_expand: true,
        layout_manager: new Clutter.BinLayout(),
        clip_to_allocation: true,
      });
      const pct = quotaPercent(q);
      const fill = new St.Widget({
        style_class: `lu-bar-fill ${barColorClass(q)}`,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
      });
      fill.set_pivot_point(0, 0.5);
      fill.scale_x = pct / 100;
      track.add_child(fill);
      return track;
    }

    _buildFooter() {
      const item = this._makeItem();
      const box = new St.BoxLayout({ style_class: "lu-footer", x_expand: true });

      const left = new St.BoxLayout({ style_class: "lu-footer-left", x_expand: true });
      const helperDotClass =
        this._state.helperMode === "dbus"
          ? "lu-dot-ok"
          : this._state.helperMode === "cli"
            ? "lu-dot-muted"
            : "lu-dot-err";
      left.add_child(
        new St.Widget({
          style_class: `lu-dot-sm ${helperDotClass}`,
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );
      const timeText = this._state.loading
        ? "Refreshing\u2026"
        : humanAge(this._state.snapshot && this._state.snapshot.generatedAt);
      left.add_child(
        new St.Label({
          text: timeText,
          style_class: "lu-footer-time",
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );
      box.add_child(left);

      const actions = new St.BoxLayout({ style_class: "lu-footer-actions" });
      const refreshBtn = new St.Button({
        style_class: "lu-icon-btn lu-clickable",
        can_focus: true,
        track_hover: true,
        reactive: true,
        child: new St.Icon({ icon_name: "view-refresh-symbolic", style_class: "lu-icon-btn-img" }),
      });
      this._attachActionHint(refreshBtn, "Refresh");
      refreshBtn.connect("clicked", () => void this._refresh(true));

      const prefsBtn = new St.Button({
        style_class: "lu-icon-btn lu-clickable",
        can_focus: true,
        track_hover: true,
        reactive: true,
        child: new St.Icon({ icon_name: "emblem-system-symbolic", style_class: "lu-icon-btn-img" }),
      });
      this._attachActionHint(prefsBtn, "Preferences");
      prefsBtn.connect("clicked", () => this._openPreferences());

      const closeBtn = new St.Button({
        style_class: "lu-icon-btn lu-clickable",
        can_focus: true,
        track_hover: true,
        reactive: true,
        child: new St.Icon({ icon_name: "window-close-symbolic", style_class: "lu-icon-btn-img" }),
      });
      this._attachActionHint(closeBtn, "Close");
      closeBtn.connect("clicked", () => this.menu.close());

      actions.add_child(refreshBtn);
      actions.add_child(prefsBtn);
      actions.add_child(closeBtn);
      box.add_child(actions);

      item.add_child(box);
      return item;
    }

    _openPreferences() {
      this.menu.close();

      try {
        const prefsScript = Me.dir.get_child("preferences-app.js").get_path();
        Gio.Subprocess.new(["gjs", prefsScript], Gio.SubprocessFlags.NONE);
        return;
      } catch {}

      try {
        Gio.Subprocess.new(
          ["gnome-extensions", "prefs", Me.metadata.uuid],
          Gio.SubprocessFlags.NONE,
        );
        return;
      } catch {}

      if (ExtensionUtils.openPrefs) ExtensionUtils.openPrefs();
    }

    _attachActionHint(actor: any, label: string) {
      this._attachPointerCursor(actor);
      this._attachTooltip(actor, label);
    }

    _attachPointerCursor(actor: any) {
      actor.connect("enter-event", () => {
        global.display.set_cursor(Meta.Cursor.POINTING_HAND);
        return Clutter.EVENT_PROPAGATE;
      });
      actor.connect("leave-event", () => {
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        return Clutter.EVENT_PROPAGATE;
      });
      actor.connect("destroy", () => global.display.set_cursor(Meta.Cursor.DEFAULT));
    }

    _attachTooltip(actor: any, label: string) {
      const tooltip = new St.Label({
        style_class: "dash-label",
        text: label,
        visible: false,
        opacity: 0,
      });
      Main.uiGroup.add_child(tooltip);

      actor.connect("notify::hover", () => {
        if (actor.hover) {
          tooltip.set({
            text: label,
            visible: true,
            opacity: 0,
          });

          const [stageX, stageY] = actor.get_transformed_position();
          const [actorWidth, actorHeight] = actor.allocation.get_size();
          const [tipWidth, tipHeight] = tooltip.get_size();
          const monitor = Main.layoutManager.findMonitorForActor(actor);
          const x = Math.max(
            monitor.x,
            Math.min(
              stageX + Math.floor((actorWidth - tipWidth) / 2),
              monitor.x + monitor.width - tipWidth,
            ),
          );
          const y =
            stageY - monitor.y > tipHeight + TOOLTIP_OFFSET
              ? stageY - tipHeight - TOOLTIP_OFFSET
              : stageY + actorHeight + TOOLTIP_OFFSET;
          tooltip.set_position(x, y);
        }

        tooltip.ease({
          opacity: actor.hover ? 255 : 0,
          duration: TOOLTIP_ANIMATION_MS,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => {
            tooltip.visible = actor.hover;
          },
        });
      });

      actor.connect("destroy", () => tooltip.destroy());
    }
  },
);

import AppKit
import SwiftUI

/// Menu bar popup: overview or provider detail, then the footer (`_rebuildMenu` in popup.ts).
struct PopupView: View {
    @Environment(UsageStore.self) private var store
    /// Reports the content size so the panel can follow it (overview ↔ detail).
    var onSize: (CGSize) -> Void = { _ in }

    var body: some View {
        // Ticks keep "2m ago", reset countdowns and the time marker live while the popup is open.
        TimelineView(.periodic(from: .now, by: 15)) { context in
            VStack(alignment: .leading, spacing: 0) {
                if let provider = store.selectedSnapshot {
                    DetailView(provider: provider, now: context.date)
                } else {
                    Text(AppInfo.name)
                        .font(.system(size: 15, weight: .heavy))
                        .padding(.horizontal, 10)
                        .padding(.top, 10)
                        .padding(.bottom, 2)
                    OverviewView(now: context.date)
                }
                FooterView(now: context.date)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(width: 400)
        }
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { onSize($0) }
    }
}

// MARK: - Overview

private struct OverviewView: View {
    @Environment(UsageStore.self) private var store
    let now: Date

    var body: some View {
        let providers = store.visibleProviders
        VStack(alignment: .leading, spacing: 2) {
            if let message = Presentation.overviewMessage(store, providers: providers) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(message.title)
                        .font(.system(size: 13))
                        .foregroundStyle(messageColor(message.tone))
                    Text(message.hint)
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            } else {
                ForEach(Array(providers.enumerated()), id: \.element.id) { index, provider in
                    OverviewRow(provider: provider, now: now)
                    if index < providers.count - 1 {
                        Rectangle().fill(Theme.divider).frame(height: 1).padding(.horizontal, 14)
                    }
                }
            }
        }
        .padding(4)
    }

    private func messageColor(_ tone: Presentation.Tone) -> Color {
        switch tone {
        case .error: Theme.errorText
        case .warn: Theme.warnText
        default: Color.secondary
        }
    }
}

private struct OverviewRow: View {
    @Environment(UsageStore.self) private var store
    let provider: ProviderSnapshot
    let now: Date

    var body: some View {
        Button {
            store.navigate(to: provider.providerId)
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Text(provider.title)
                        .font(.system(size: 14, weight: .bold))
                    Spacer(minLength: 0)
                    if provider.status != .ok {
                        StatusBadge(status: provider.status)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }

                if let quota = Presentation.overviewQuota(provider, window: store.settings.overviewQuotaWindow) {
                    QuotaBar(quota: quota, now: now, showTimeMarker: store.settings.showTimeProgressMarker)
                    meta(quota)
                } else {
                    Text(Presentation.detailStatusText(provider.status) ?? Presentation.statusText(provider.status))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                if let error = provider.errorMessage {
                    MessageText(text: error, style: provider.status == .stale ? .warning : .error)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.highlight(cornerRadius: 13))
        .pointingHandCursor()
        .accessibilityHint("Show \(provider.title) details")
    }

    private func meta(_ quota: Quota) -> some View {
        let danger = Presentation.pace(quota, now: now) == .danger
        return HStack(spacing: 4) {
            Text(quota.valueLabel ?? Presentation.formatPercent(Presentation.quotaPercent(quota)))
            separator
            Text(quota.label).foregroundStyle(danger ? Theme.red : Color.secondary)
            if let reset = Presentation.humanReset(quota, now: now) {
                separator
                Text(reset)
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    private var separator: some View {
        Text("·").foregroundStyle(.tertiary)
    }
}

// MARK: - Detail

private struct DetailView: View {
    @Environment(UsageStore.self) private var store
    let provider: ProviderSnapshot
    let now: Date

    var body: some View {
        let settings = store.settings
        VStack(alignment: .leading, spacing: 8) {
            Button {
                store.navigate(to: nil)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.left")
                    Text("Overview")
                }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.blue)
                .frame(height: FooterIconButton.labelHeight)
                .modifier(LegacyPadding(horizontal: 10, vertical: 6))
            }
            .glassButton(.capsule, restingFill: 0.06)
            .padding(.bottom, 2)

            HStack(spacing: 10) {
                Text(provider.title)
                    .font(.system(size: 17, weight: .heavy))
                Spacer(minLength: 0)
                StatusBadge(status: provider.status)
            }

            let meta = [provider.accountLabel, Presentation.titleCase(provider.planLabel)]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            if !meta.isEmpty {
                Text(meta)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if let source = provider.sourceLabel, settings.showSourceLabel {
                Text(source)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.tertiary)
            }

            if provider.status == .stale, let remediation = provider.remediation {
                MessageText(text: remediation, style: .remedy)
            } else if let status = Presentation.detailStatusText(provider.status) {
                Text(status)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }

            if let quota = provider.primaryQuota { QuotaBlock(quota: quota, now: now) }
            if let quota = provider.secondaryQuota { QuotaBlock(quota: quota, now: now) }

            let lines = settings.showExtraCredits
                ? provider.detailLines : provider.detailLines.filter { !Presentation.isExtraLine($0) }
            if !lines.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(lines, id: \.self) { line in
                        Text(line)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
            }

            if let error = provider.errorMessage {
                MessageText(text: error, style: provider.status == .stale ? .warning : .error)
            }
            if let remediation = provider.remediation, provider.status != .stale {
                MessageText(text: remediation, style: .remedy)
            }
        }
        .padding(EdgeInsets(top: 10, leading: 14, bottom: 14, trailing: 14))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct QuotaBlock: View {
    @Environment(UsageStore.self) private var store
    let quota: Quota
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(quota.label)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text(quota.valueLabel ?? Presentation.formatPercent(quota.usedPercent))
                    .font(.system(size: 12.5, weight: .bold))
                    .monospacedDigit()
            }
            QuotaBar(quota: quota, now: now, showTimeMarker: store.settings.showTimeProgressMarker)
            if let reset = Presentation.humanReset(quota, now: now) {
                Text(reset)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(12)
        .glassCard(cornerRadius: 12)
    }
}

// MARK: - Footer

private struct FooterView: View {
    @Environment(UsageStore.self) private var store
    let now: Date

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Theme.color(dotTone))
                .frame(width: 6, height: 6)
            Text(timeText)
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .lineLimit(1)

            Spacer(minLength: 0)

            GlassGroup(spacing: 6) {
                HStack(spacing: 6) { footerControls }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 2)
        .padding(.bottom, 6)
        .background {
            // ⌘Q has no menu to live in for a menu bar app.
            Button("Quit") { NSApp.terminate(nil) }
                .keyboardShortcut("q", modifiers: .command)
                .hidden()
        }
    }

    @ViewBuilder
    private var footerControls: some View {
                if store.selectedSnapshot == nil {
                    let current = store.settings.overviewQuotaWindow
                    Button {
                        store.settings.overviewQuotaWindow = current.toggled
                    } label: {
                        Text(current.label)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.primary.opacity(0.75))
                            .lineLimit(1)
                            .fixedSize()
                            .frame(height: FooterIconButton.labelHeight)
                            .modifier(LegacyPadding(horizontal: 12, vertical: 6))
                    }
                    .glassButton(.capsule, restingFill: 0.08)
                    .help(current.toggled == .session ? "Show session usage" : "Show weekly usage")
                }
                FooterIconButton(symbol: "arrow.clockwise", help: "Refresh", isBusy: store.loading) {
                    store.refresh(force: true)
                }
                .keyboardShortcut("r", modifiers: .command)
                FooterIconButton(symbol: "gearshape", help: "Preferences") {
                    MenuBarPopup.dismiss()
                    PreferencesWindow.shared.show(store: store)
                }
                .keyboardShortcut(",", modifiers: .command)
    }

    private var dotTone: Presentation.Tone {
        if store.loading { return .info }
        switch store.requestState {
        case .timeout: return .warn
        case .error: return .error
        default: return .ok
        }
    }

    private var timeText: String {
        if store.loading { return store.snapshot == nil ? "Loading usage data…" : "Refreshing…" }
        switch store.requestState {
        case .timeout: return "Providers timed out"
        case .error: return "Unable to load usage data"
        default: return Presentation.humanAge(store.snapshot?.generatedAt, now: now)
        }
    }
}

private struct FooterIconButton: View {
    /// Label height shared by every footer control: the glass style pads all of them the same
    /// way, so equal labels give equal buttons.
    static let labelHeight: CGFloat = 18

    let symbol: String
    let help: String
    /// Shows a spinner in place of the symbol, same size, and disables the button.
    var isBusy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.75)
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: Self.labelHeight, height: Self.labelHeight)
            .modifier(LegacyPadding(horizontal: 6, vertical: 6))
        }
        .glassButton(.circle)
        .disabled(isBusy)
        .help(isBusy ? "Refreshing…" : help)
        .accessibilityLabel(isBusy ? "Refreshing" : help)
    }
}

/// The native glass button style pads its label itself; the fallback style doesn't.
private struct LegacyPadding: ViewModifier {
    let horizontal: CGFloat
    let vertical: CGFloat

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content
        } else {
            content.padding(.horizontal, horizontal).padding(.vertical, vertical)
        }
    }
}

@MainActor
enum MenuBarPopup {
    static func dismiss() {
        StatusItemController.shared?.close()
    }
}

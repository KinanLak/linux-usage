import AppKit
import ServiceManagement
import SwiftUI

/// Same settings as `prefs-widget/prefs.ts`, as a native grouped form. Rows are named after what
/// they change; there are no explanatory paragraphs.
struct PreferencesView: View {
    @Environment(AppSettings.self) private var settings

    var body: some View {
        Form {
            generalSection
            menuBarSection
            providersSection
            credentialsSection
            aboutSection
        }
        .formStyle(.grouped)
        .toggleStyle(.switch)
        .frame(width: 520)
        .frame(minHeight: 480, idealHeight: 720)
    }

    // MARK: General

    private var generalSection: some View {
        @Bindable var settings = settings
        return Section("General") {
            LabeledContent("Refresh every") {
                HStack(spacing: 8) {
                    if refreshIntervalBinding.wrappedValue <= AppSettings.shortRefreshWarningMaxSeconds {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.yellow)
                            .help("Short intervals can get you rate-limited.")
                            .accessibilityLabel("Short intervals can get you rate-limited.")
                    }
                    Picker("Refresh every", selection: refreshIntervalBinding) {
                        ForEach(AppSettings.refreshIntervalOptions, id: \.value) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                    .labelsHidden()
                    .fixedSize()
                    .pointingHandCursor()
                }
            }
            Toggle("Show data source in details", isOn: $settings.showSourceLabel).pointingHandCursor()
            Toggle("Show credits and extra usage", isOn: $settings.showExtraCredits).pointingHandCursor()
            Toggle("Show elapsed time in quota bars", isOn: $settings.showTimeProgressMarker).pointingHandCursor()
            LaunchAtLoginToggle()
        }
    }

    /// Unknown stored values display as the 5 minute default, like the GTK dropdown.
    private var refreshIntervalBinding: Binding<Int> {
        Binding {
            let value = settings.refreshIntervalSeconds
            return AppSettings.refreshIntervalOptions.contains { $0.value == value } ? value : 300
        } set: {
            settings.refreshIntervalSeconds = $0
        }
    }

    // MARK: Menu bar

    private var menuBarSection: some View {
        @Bindable var settings = settings
        return Section("Menu bar") {
            Toggle("Show usage percentage", isOn: $settings.panelShowUsage).pointingHandCursor()
            Picker("Percentage of", selection: $settings.panelProvider) {
                Text("Most used provider").tag("auto")
                ForEach(ProviderCatalog.all) { provider in
                    Text(provider.title).tag(provider.id)
                }
            }
            .disabled(!settings.panelShowUsage)
            .pointingHandCursor()
        }
    }

    // MARK: Providers

    private var providersSection: some View {
        Section("Providers") {
            ForEach(ProviderCatalog.all) { provider in
                Toggle(
                    provider.title,
                    isOn: Binding {
                        settings.isProviderEnabled(provider.id)
                    } set: {
                        settings.setProvider(provider.id, enabled: $0)
                    }
                )
                .pointingHandCursor()
            }
        }
    }

    // MARK: Credentials

    private var credentialsSection: some View {
        @Bindable var settings = settings
        return Section("Credentials") {
            Picker("Read tokens from", selection: $settings.credentialSource) {
                ForEach(CredentialSource.allCases) { source in
                    Text(source.label).tag(source)
                }
            }
            .pointingHandCursor()
            if settings.credentialSource.usesServer {
                CliProxyServerRows()
            }
        }
    }

    // MARK: About

    private var aboutSection: some View {
        Section {
            HStack {
                Text("\(AppInfo.name) \(AppInfo.version)")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Quit \(AppInfo.name)") { NSApp.terminate(nil) }
                    .pointingHandCursor()
            }
        }
    }
}

/// Server URL and management key for the `CLIProxyAPI server` source. Both read as plain values
/// with a pencil button; editing swaps in a field with confirm and cancel buttons.
private struct CliProxyServerRows: View {
    private enum Field { case url, key }

    @Environment(AppSettings.self) private var settings
    @Environment(UsageStore.self) private var store
    @State private var editing: Field?
    @State private var draft = ""
    @State private var hasKey = false
    @State private var saving = false
    @State private var error: (field: Field, text: String)?
    @FocusState private var focused: Field?

    var body: some View {
        Group {
            LabeledContent {
                if editing == .url {
                    editor {
                        TextField("Server", text: $draft, prompt: Text("https://host:8317"))
                    }
                } else {
                    value(displayURL ?? "Not set", isSet: displayURL != nil) { begin(.url) }
                }
            } label: {
                label("Server", for: .url)
            }

            LabeledContent {
                if editing == .key {
                    editor {
                        SecureField("Management key", text: $draft, prompt: Text("Secret key"))
                    }
                } else {
                    value(hasKey ? "Saved in Keychain" : "Not set", isSet: hasKey, symbol: hasKey ? "lock.fill" : nil) {
                        begin(.key)
                    }
                }
            } label: {
                label("Management key", for: .key)
            }
        }
        .task { hasKey = await ManagementKeyStore.read() != nil }
    }

    /// `host:port`, without the scheme.
    private var displayURL: String? {
        guard !settings.cliProxyURL.isEmpty else { return nil }
        guard let url = URL(string: settings.cliProxyURL), let host = url.host else { return settings.cliProxyURL }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    @ViewBuilder
    private func label(_ title: String, for field: Field) -> some View {
        Text(title)
        if let error, error.field == field {
            Text(error.text).foregroundStyle(Theme.errorText)
        }
    }

    private func value(_ text: String, isSet: Bool, symbol: String? = nil, edit: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
            Text(text)
                .foregroundStyle(isSet ? Color.secondary : Color(nsColor: .tertiaryLabelColor))
                .lineLimit(1)
                .truncationMode(.middle)
            InlineIconButton(symbol: "pencil", help: "Edit", action: edit)
        }
    }

    private func editor<Input: View>(@ViewBuilder _ input: () -> Input) -> some View {
        HStack(spacing: 6) {
            input()
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .frame(width: 230)
                .focused($focused, equals: editing)
                .onSubmit(commit)
                .onExitCommand(perform: cancel)
            InlineIconButton(symbol: "checkmark", help: "Save", action: commit)
                .disabled(saving)
            InlineIconButton(symbol: "xmark", help: "Cancel", action: cancel)
        }
    }

    private func begin(_ field: Field) {
        error = nil
        draft = field == .url ? settings.cliProxyURL : ""
        editing = field
        DispatchQueue.main.async { focused = field }
    }

    private func cancel() {
        editing = nil
        draft = ""
    }

    private func commit() {
        guard let field = editing, !saving else { return }
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        switch field {
        case .url:
            guard value.isEmpty || CliProxyServer.normalizeURL(value) != nil else {
                error = (.url, "Invalid server URL.")
                return
            }
            settings.cliProxyURL = CliProxyServer.normalizeURL(value) ?? ""  // triggers a refresh
            error = nil
            cancel()
        case .key:
            guard !value.isEmpty else {
                cancel()
                return
            }
            saving = true
            Task {
                defer { saving = false }
                guard await ManagementKeyStore.save(value) else {
                    error = (.key, "Couldn't save the key in the Keychain.")
                    return
                }
                hasKey = true
                error = nil
                cancel()
                store.refresh(force: true)
            }
        }
    }
}

/// Small borderless symbol button used inside form rows.
private struct InlineIconButton: View {
    let symbol: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .help(help)
        .accessibilityLabel(help)
        .pointingHandCursor()
    }
}

/// macOS addition: GNOME starts extensions with the shell, a menu bar app needs a login item.
private struct LaunchAtLoginToggle: View {
    @State private var enabled = SMAppService.mainApp.status == .enabled
    @State private var error: String?

    var body: some View {
        Toggle(isOn: Binding { enabled } set: { update($0) }) {
            Text("Open at login")
            if let error {
                Text(error).foregroundStyle(Theme.errorText)
            }
        }
        .pointingHandCursor()
    }

    private func update(_ value: Bool) {
        do {
            if value { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        enabled = SMAppService.mainApp.status == .enabled
    }
}

/// AppKit-owned window: SwiftUI `Settings` scenes don't reliably come forward in an accessory app.
@MainActor
final class PreferencesWindow {
    static let shared = PreferencesWindow()

    private var window: NSWindow?

    func show(store: UsageStore) {
        if window == nil {
            let controller = NSHostingController(
                rootView: PreferencesView().environment(store.settings).environment(store)
            )
            controller.sizingOptions = [.preferredContentSize]
            let window = NSWindow(contentViewController: controller)
            window.title = "\(AppInfo.name) Preferences"
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.isReleasedWhenClosed = false
            window.center()
            self.window = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

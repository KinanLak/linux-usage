import AppKit

enum AppInfo {
    static let name = "Linux Usage"
    static let bundleIdentifier = "io.github.kinanlak.linux-usage"

    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }
}

@main
enum Main {
    /// `LinuxUsage snapshot [--pretty]` and `LinuxUsage probe <provider>` mirror the GNOME helper CLI;
    /// anything else launches the menu bar app.
    @MainActor
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        switch arguments.first {
        case "snapshot", "probe":
            runCLI(arguments)
        default:
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            app.delegate = AppDelegate.shared
            app.run()
        }
    }

    private static func runCLI(_ arguments: [String]) {
        let source = CredentialSource.current()
        Task.detached {
            let options = await ProviderOptions.current(source)
            let encoder = JSONEncoder()
            encoder.outputFormatting = arguments.contains("--pretty") || arguments.first == "probe"
                ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]

            let data: Data?
            if arguments.first == "probe" {
                guard let id = arguments.dropFirst().first, let snapshot = await Registry.fetchOne(id, options: options)
                else {
                    FileHandle.standardError.write(Data("Usage: LinuxUsage probe <\(ProviderCatalog.all.map(\.id).joined(separator: "|"))>\n".utf8))
                    exit(1)
                }
                data = try? encoder.encode(snapshot)
            } else {
                data = try? encoder.encode(await Registry.fetchAll(options: options))
            }
            FileHandle.standardOutput.write((data ?? Data()) + Data("\n".utf8))
            exit(0)
        }
        dispatchMain()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static let shared = AppDelegate()

    private var store: UsageStore?
    private var statusItem: StatusItemController?

    func applicationDidFinishLaunching(_: Notification) {
        NSApp.mainMenu = Self.mainMenu()
        let store = UsageStore(settings: AppSettings())
        #if DEBUG
            if DebugHooks.useSample { store.showSample(DebugHooks.sampleSnapshot(), busy: DebugHooks.arguments.contains("--busy")) } else { store.start() }
        #else
            store.start()
        #endif
        self.store = store
        statusItem = StatusItemController(store: store)
        #if DEBUG
            DebugHooks.afterLaunch(store: store)
        #endif
    }

    /// Never shown (accessory app), but routes ⌘Q, ⌘W and the Edit shortcuts the text fields need.
    private static func mainMenu() -> NSMenu {
        let main = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: "Quit \(AppInfo.name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu: app, title: AppInfo.name)

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(submenu: edit, title: "Edit")

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        main.addItem(submenu: window, title: "Window")
        return main
    }
}

private extension NSMenu {
    func addItem(submenu: NSMenu, title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        addItem(item)
    }
}

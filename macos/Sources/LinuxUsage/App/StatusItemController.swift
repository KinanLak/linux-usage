import AppKit
import Observation
import SwiftUI

/// The menu bar item and its popup. AppKit-owned rather than a SwiftUI `MenuBarExtra`, so the
/// popup gets a real Liquid Glass panel (rounded, system shadow), opens and closes on demand, and
/// the item can show a provider logo next to the percentage.
@MainActor
final class StatusItemController: NSObject {
    static private(set) var shared: StatusItemController?

    private let store: UsageStore
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let panel: PopupPanel
    private let hosting: NSHostingView<AnyView>
    private var monitors: [Any] = []
    private var resignObserver: NSObjectProtocol?
    private var contentSize = CGSize(width: 400, height: 300)

    private static let gap: CGFloat = 6
    private static let screenMargin: CGFloat = 8

    init(store: UsageStore) {
        self.store = store
        hosting = NSHostingView(rootView: AnyView(EmptyView()))
        panel = PopupPanel()
        super.init()

        hosting.rootView = AnyView(
            PopupView(onSize: { [weak self] size in self?.resize(to: size) })
                .environment(store)
        )
        hosting.sizingOptions = []
        panel.setContent(hosting)

        if let button = statusItem.button {
            button.target = self
            button.action = #selector(toggle)
            button.sendAction(on: [.leftMouseDown, .rightMouseDown])
            button.imagePosition = .imageLeading
        }
        updateButton()
        Self.shared = self
    }

    var isOpen: Bool { panel.isVisible }

    @objc func toggle() {
        isOpen ? close() : open()
    }

    func open() {
        guard !isOpen else { return }
        resize(to: contentSize)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        statusItem.button?.highlight(true)

        // Click anywhere else, Escape, or another app taking focus closes it, like a menu.
        let mouse: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mouse, handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown], handler: {
            [weak self] event in
            let isKey = event.type == .keyDown
            let isEscape = isKey && event.keyCode == 53
            let location = event.locationInWindow
            let window = event.window
            let consumed = MainActor.assumeIsolated { () -> Bool in
                guard let self else { return false }
                let inShadow = !isKey && window === self.panel && !self.panel.surfaceFrame.contains(location)
                guard isEscape || inShadow else { return false }
                self.close()
                return true
            }
            return consumed ? nil : event
        }) {
            monitors.append(local)
        }
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification, object: panel, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
    }

    func close() {
        guard isOpen else { return }
        panel.orderOut(nil)
        statusItem.button?.highlight(false)
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
        resignObserver = nil
    }

    /// Keeps the panel's top edge under the menu bar item while its content grows or shrinks.
    private func resize(to size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        contentSize = size
        // An item hidden behind the notch or a menu bar manager sits off screen: use the top right
        // of the main screen instead.
        let anchor = statusItem.button?.window?.frame ?? .zero
        let center = NSPoint(x: anchor.midX, y: anchor.midY)
        let itemScreen = NSScreen.screens.first { $0.frame.contains(center) }
        let onScreen = itemScreen != nil
        guard let screen = itemScreen ?? NSScreen.main ?? NSScreen.screens.first else { return }
        let visible = screen.visibleFrame
        var x = onScreen ? anchor.minX : visible.maxX
        x = min(x, visible.maxX - size.width - Self.screenMargin)
        x = max(x, visible.minX + Self.screenMargin)
        let top = (onScreen ? anchor.minY : visible.maxY) - Self.gap
        panel.place(surface: NSRect(x: x, y: top - size.height, width: size.width, height: size.height))
    }

    // MARK: - Menu bar item

    /// Re-renders the item whenever something it reads changes (Observation tracking).
    private func updateButton() {
        withObservationTracking {
            render()
        } onChange: { [weak self] in
            Task { @MainActor in self?.updateButton() }
        }
    }

    private func render() {
        guard let button = statusItem.button else { return }
        let usage = store.trayUsage
        let image = usage.flatMap { ProviderIcons.menuBarImage(for: $0.providerId) }
            ?? NSImage(systemSymbolName: store.trayIcon.symbol, accessibilityDescription: nil)
        image?.isTemplate = true
        button.image = image

        if let text = usage?.text {
            let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .medium)
            button.attributedTitle = NSAttributedString(string: " \(text)", attributes: [.font: font])
        } else {
            button.title = ""
        }

        let provider = usage.flatMap { usage in store.visibleProviders.first { $0.providerId == usage.providerId } }
        button.setAccessibilityLabel(
            [AppInfo.name, provider?.title, usage?.text].compactMap { $0 }.joined(separator: ", ")
        )
    }
}

/// Borderless panel that can take keyboard focus (shortcuts, text selection) without a title bar.
/// The window is larger than the visible surface: the glass draws its own shadow, which needs a
/// transparent margin to fade out instead of ending in faint square corners at the window edge.
private final class PopupPanel: NSPanel {
    private static let cornerRadius: CGFloat = 18
    /// Room for the glass shadow, which falls mostly downwards.
    private static let margin = NSEdgeInsets(top: 16, left: 24, bottom: 36, right: 24)

    private let surface = NSView()

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .popUpMenu
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        acceptsMouseMovedEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        animationBehavior = .utilityWindow
        let root = NSView()
        root.addSubview(surface)
        contentView = root
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// The visible popup, in window coordinates.
    var surfaceFrame: NSRect { surface.frame }

    /// Positions the visible surface at `frame` (screen coordinates) and sizes the window around it.
    func place(surface frame: NSRect) {
        let m = Self.margin
        let window = NSRect(
            x: frame.minX - m.left, y: frame.minY - m.bottom,
            width: frame.width + m.left + m.right, height: frame.height + m.top + m.bottom
        )
        setFrame(window, display: false)
        // The frame view doesn't keep a custom content view in sync with borderless resizes.
        contentView?.frame = NSRect(origin: .zero, size: window.size)
        surface.frame = NSRect(x: m.left, y: m.bottom, width: frame.width, height: frame.height)
        displayIfNeeded()
    }

    /// Liquid Glass on macOS 26+, the menu material before. The SwiftUI view sits above the
    /// background rather than inside `NSGlassEffectView.contentView`, which insets its content.
    func setContent(_ view: NSView) {
        let background: NSView
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.cornerRadius = Self.cornerRadius
            background = glass
        } else {
            let effect = NSVisualEffectView()
            effect.material = .menu
            effect.state = .active
            effect.blendingMode = .behindWindow
            effect.wantsLayer = true
            effect.layer?.cornerRadius = Self.cornerRadius
            effect.layer?.cornerCurve = .continuous
            effect.layer?.masksToBounds = true
            background = effect
            // No glass shadow before macOS 26: draw one on the surface itself.
            surface.wantsLayer = true
            surface.shadow = {
                let shadow = NSShadow()
                shadow.shadowBlurRadius = 16
                shadow.shadowOffset = NSSize(width: 0, height: -6)
                shadow.shadowColor = NSColor.black.withAlphaComponent(0.25)
                return shadow
            }()
        }
        for child in [background, view] {
            child.frame = surface.bounds
            child.autoresizingMask = [.width, .height]
            surface.addSubview(child)
        }
        // Anything drawn outside the rounded shape (SwiftUI glass backdrops included) is clipped.
        view.wantsLayer = true
        view.layer?.cornerRadius = Self.cornerRadius
        view.layer?.cornerCurve = .continuous
        view.layer?.masksToBounds = true
    }
}

import AppKit
import SwiftUI

/// Palette from `stylesheet.css`, with darker light-mode variants so text stays readable on a
/// light menu background.
enum Theme {
    static let green = adaptive(light: (0.10, 0.62, 0.40), dark: (78 / 255, 205 / 255, 150 / 255))
    static let yellow = adaptive(light: (0.86, 0.58, 0.0), dark: (1.0, 200 / 255, 80 / 255))
    static let blue = adaptive(light: (0.10, 0.45, 0.95), dark: (100 / 255, 160 / 255, 1.0))
    static let red = adaptive(light: (0.86, 0.22, 0.22), dark: (250 / 255, 110 / 255, 110 / 255))
    static let errorText = adaptive(light: (0.80, 0.18, 0.18), dark: (1.0, 155 / 255, 155 / 255))
    static let warnText = adaptive(light: (0.70, 0.45, 0.0), dark: (1.0, 210 / 255, 130 / 255))

    static let track = Color.primary.opacity(0.08)
    static let timeFill = Color.primary.opacity(0.14)
    static let marker = Color.primary.opacity(0.9)
    static let card = Color.primary.opacity(0.04)
    static let hover = Color.primary.opacity(0.07)
    static let pressed = Color.primary.opacity(0.03)
    static let divider = Color.primary.opacity(0.06)

    static func color(_ tone: Presentation.Tone) -> Color {
        switch tone {
        case .ok: green
        case .warn: yellow
        case .info: blue
        case .error: red
        case .muted: Color.secondary
        }
    }

    private static func adaptive(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(
            nsColor: NSColor(name: nil) { appearance in
                let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                let (r, g, b) = isDark ? dark : light
                return NSColor(srgbRed: r, green: g, blue: b, alpha: 1)
            }
        )
    }
}

/// Hover and press highlight shared by the popup's clickable rows and buttons (`.lu-clickable`).
struct HighlightButtonStyle<S: Shape>: ButtonStyle {
    let shape: S

    func makeBody(configuration: Configuration) -> some View {
        HighlightBody(configuration: configuration, shape: shape)
    }

    private struct HighlightBody: View {
        let configuration: Configuration
        let shape: S
        @State private var hovering = false

        var body: some View {
            configuration.label
                .contentShape(shape)
                .background(
                    shape.fill(configuration.isPressed ? Theme.pressed : hovering ? Theme.hover : Color.clear)
                )
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
        }
    }
}

extension ButtonStyle where Self == HighlightButtonStyle<RoundedRectangle> {
    static func highlight(cornerRadius: CGFloat) -> Self {
        HighlightButtonStyle(shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

extension ButtonStyle where Self == HighlightButtonStyle<Capsule> {
    static var highlightCapsule: Self { HighlightButtonStyle(shape: Capsule()) }
}

struct StatusBadge: View {
    let status: ProviderStatus

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Theme.color(Presentation.statusTone(status)))
                .frame(width: 7, height: 7)
            Text(Presentation.statusText(status))
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Error, warning and remediation text. Backticked commands render as code and can be copied.
struct MessageText: View {
    enum Style { case error, warning, remedy }

    let text: String
    let style: Style

    var body: some View {
        Text(Self.attributed(text))
            .font(.system(size: 12))
            .italic(style == .remedy)
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    private var color: Color {
        switch style {
        case .error: Theme.errorText
        case .warning: Theme.warnText
        case .remedy: Color.secondary
        }
    }

    private static func attributed(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

// MARK: - Pointer cursor

extension View {
    /// Pointing-hand cursor over clickable elements (`cursor: pointer` in the GNOME stylesheet).
    func pointingHandCursor() -> some View { modifier(PointingHandCursor()) }
}

/// Re-applied on every mouse move: `pointerStyle(.link)` and `NSCursor.push`/`pop` lose track
/// in the popup panel (the cursor stuck after the first hover), and AppKit's cursor rects reset
/// the cursor to the arrow on their own schedule.
private struct PointingHandCursor: ViewModifier {
    @State private var inside = false

    func body(content: Content) -> some View {
        content
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    inside = true
                    NSCursor.pointingHand.set()
                case .ended:
                    inside = false
                    NSCursor.arrow.set()
                }
            }
            // A row that disappears under the mouse (overview → detail) never gets `.ended`.
            .onDisappear {
                if inside { NSCursor.arrow.set() }
            }
    }
}

// MARK: - Liquid Glass (macOS 26+, plain fallback before)

/// Groups glass controls so neighbouring shapes blend and morph together.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 8
    @ViewBuilder var content: Content

    var body: some View {
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// Native Liquid Glass button (`.buttonStyle(.glass)`, which handles the press feedback) with a
/// light tint on hover. Before macOS 26, a tinted shape with the same hover and press states.
struct GlassButton: ViewModifier {
    enum Shape { case circle, capsule }

    let shape: Shape
    /// Fill at rest without Liquid Glass (labelled controls have one, icon buttons don't).
    var restingFill: Double = 0
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    func body(content: Content) -> some View {
        styled(content)
            .onHover { hovering = $0 }
            .modifier(ConditionalPointingHand(enabled: isEnabled))
    }

    @ViewBuilder
    private func styled(_ content: Content) -> some View {
        let lifted = hovering && isEnabled
        if #available(macOS 26.0, *) {
            content
                .buttonStyle(.glass(lifted ? .regular.tint(Color.primary.opacity(0.08)) : .regular))
                .buttonBorderShape(shape == .circle ? .circle : .capsule)
        } else if shape == .circle {
            content.buttonStyle(TintedShapeStyle(shape: Circle(), restingFill: restingFill, hovering: lifted))
        } else {
            content.buttonStyle(TintedShapeStyle(shape: Capsule(), restingFill: restingFill, hovering: lifted))
        }
    }
}

private struct TintedShapeStyle<S: Shape>: ButtonStyle {
    let shape: S
    let restingFill: Double
    let hovering: Bool

    func makeBody(configuration: Configuration) -> some View {
        let fill = configuration.isPressed ? restingFill + 0.04 : hovering ? restingFill + 0.08 : restingFill
        configuration.label
            .contentShape(shape)
            .background(shape.fill(Color.primary.opacity(fill)))
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

private struct ConditionalPointingHand: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled { content.pointingHandCursor() } else { content }
    }
}

extension View {
    func glassButton(_ shape: GlassButton.Shape, restingFill: Double = 0) -> some View {
        modifier(GlassButton(shape: shape, restingFill: restingFill))
    }
}

extension View {
    /// Glass surface for content cards, the flat tinted card before macOS 26.
    @ViewBuilder
    func glassCard(cornerRadius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(macOS 26.0, *) {
            glassEffect(.regular, in: shape)
        } else {
            background(shape.fill(Theme.card))
        }
    }

}

import SwiftUI

/// Usage bar with the optional elapsed-time fill and marker (`_buildBar` in popup.ts).
struct QuotaBar: View {
    let quota: Quota
    let now: Date
    let showTimeMarker: Bool

    private static let height: CGFloat = 6
    private static let markerWidth: CGFloat = 4

    var body: some View {
        let used = Presentation.quotaPercent(quota)
        let time = showTimeMarker && quota.valueLabel != "Included"
            ? Presentation.timeProgressPercent(quota, now: now) : nil

        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.track)

                if let time, time > 0 {
                    Capsule()
                        .fill(Theme.timeFill)
                        .frame(width: min(width, width * time / 100 + Self.markerWidth / 2))
                }

                Capsule()
                    .fill(Theme.color(Presentation.barTone(quota, now: now)))
                    .frame(width: max(0, min(width, width * used / 100)))

                if let time, time > 0, time < 100 {
                    Capsule()
                        .fill(Theme.marker)
                        .frame(width: Self.markerWidth)
                        .offset(x: max(0, min(width - Self.markerWidth, width * time / 100 - Self.markerWidth / 2)))
                }
            }
            .animation(.easeOut(duration: 0.25), value: used)
        }
        .frame(height: Self.height)
        .clipShape(Capsule())
        .accessibilityElement()
        .accessibilityLabel(quota.label)
        .accessibilityValue(quota.valueLabel ?? Presentation.formatPercent(used))
    }
}

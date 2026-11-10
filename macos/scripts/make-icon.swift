// Renders the app icon (two quota bars with a time marker, as in the popup) into an .iconset.
// Usage: swift scripts/make-icon.swift <output.iconset>
import AppKit

let output = CommandLine.arguments.dropFirst().first ?? "AppIcon.iconset"
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

func render(size: Int) -> Data {
    let s = CGFloat(size)
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext

    // macOS icon grid: 824/1024 body with a continuous-corner rounded rectangle.
    let inset = s * 100 / 1024
    let body = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let path = CGPath(roundedRect: body, cornerWidth: body.width * 0.225, cornerHeight: body.width * 0.225, transform: nil)

    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -s * 0.01), blur: s * 0.03, color: color(0, 0, 0, 0.35))
    context.addPath(path)
    context.setFillColor(color(28, 31, 38))
    context.fillPath()
    context.restoreGState()

    context.saveGState()
    context.addPath(path)
    context.clip()
    let gradient = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
        colors: [color(52, 57, 70), color(22, 24, 30)] as CFArray, locations: [0, 1]
    )!
    context.drawLinearGradient(
        gradient, start: CGPoint(x: 0, y: body.maxY), end: CGPoint(x: 0, y: body.minY), options: []
    )
    context.restoreGState()

    // Two bars: session (green, on pace) and weekly (yellow, ahead of pace), each with a time marker.
    let barX = body.minX + body.width * 0.17
    let barWidth = body.width * 0.66
    let barHeight = body.height * 0.095
    let bars: [(y: CGFloat, used: CGFloat, time: CGFloat, fill: CGColor)] = [
        (body.minY + body.height * 0.58, 0.62, 0.72, color(78, 205, 150)),
        (body.minY + body.height * 0.32, 0.40, 0.28, color(255, 200, 80)),
    ]
    for bar in bars {
        let track = CGRect(x: barX, y: bar.y, width: barWidth, height: barHeight)
        let radius = barHeight / 2
        context.addPath(CGPath(roundedRect: track, cornerWidth: radius, cornerHeight: radius, transform: nil))
        context.setFillColor(color(255, 255, 255, 0.10))
        context.fillPath()

        let fill = CGRect(x: barX, y: bar.y, width: barWidth * bar.used, height: barHeight)
        context.addPath(CGPath(roundedRect: fill, cornerWidth: radius, cornerHeight: radius, transform: nil))
        context.setFillColor(bar.fill)
        context.fillPath()

        let markerWidth = barHeight * 0.42
        let marker = CGRect(
            x: barX + barWidth * bar.time - markerWidth / 2, y: bar.y - barHeight * 0.35,
            width: markerWidth, height: barHeight * 1.7
        )
        context.addPath(CGPath(roundedRect: marker, cornerWidth: markerWidth / 2, cornerHeight: markerWidth / 2, transform: nil))
        context.setFillColor(color(255, 255, 255, 0.95))
        context.fillPath()
    }

    return bitmap.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        try render(size: base * scale).write(to: URL(fileURLWithPath: "\(output)/\(name)"))
    }
}

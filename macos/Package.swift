// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LinuxUsage",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "LinuxUsage",
            path: "Sources/LinuxUsage"
        ),
    ]
)

// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ClaudeStatusBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ClaudeStatusBar",
            path: "Sources"
        )
    ]
)

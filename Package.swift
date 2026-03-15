// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "claude-cue",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ClaudeCue",
            path: "Sources"
        )
    ]
)

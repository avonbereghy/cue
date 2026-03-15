// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Cue",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Cue",
            path: "Sources"
        )
    ]
)

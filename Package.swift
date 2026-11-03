// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ProclaimTap",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "ProclaimTap", targets: ["ProclaimTap"])],
    targets: [
        .target(name: "TapCore"),
        .executableTarget(name: "ProclaimTap", dependencies: ["TapCore"]),
        .executableTarget(name: "TapChecks", dependencies: ["TapCore"], path: "Tests/TapCoreTests")
    ]
)

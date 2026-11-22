// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "gbrain-apple-helper",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "gbrain-apple-helper", targets: ["gbrain-apple-helper"])],
    targets: [
        .target(name: "HelperCore", linkerSettings: [.linkedLibrary("sqlite3")]),
        .executableTarget(name: "gbrain-apple-helper", dependencies: ["HelperCore"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
    ]
)

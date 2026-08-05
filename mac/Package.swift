// swift-tools-version: 5.9
import PackageDescription

// Foundation-owned scaffold. Track A owns everything under mac/Sources and mac/Tests
// after this point, including adding targets.
//
// NOTE ON DISTRIBUTION: the shipping app cannot be a bare SwiftPM executable. TCC
// grants bind to a bundled executable, and CLI binaries dropped off the Full Disk
// Access list in macOS 26.1-26.2. All privileged I/O happens inside the .app bundle.
// BoiKit is a library so the logic is testable from `swift test` without the bundle.

let package = Package(
    name: "BoiKit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "BoiKit", targets: ["BoiKit"]),
        .executable(name: "boi-cli", targets: ["BoiCLI"]),
        // The shipping binary. `mac/scripts/build-app.sh` wraps it in Boi.app, because
        // all privileged I/O must happen inside a bundle -- see the note above. The
        // LaunchAgent invokes THIS binary with --sync, never a helper: TCC is
        // per-responsible-process and children do not inherit the grant.
        .executable(name: "BoiApp", targets: ["BoiApp"]),
        .executable(name: "BoiWakeHelper", targets: ["BoiWakeHelper"]),
    ],
    targets: [
        .target(name: "BoiKit"),
        .executableTarget(name: "BoiCLI", dependencies: ["BoiKit"]),
        .executableTarget(name: "BoiApp", dependencies: ["BoiKit"]),
        .executableTarget(
            name: "BoiWakeHelper",
            dependencies: ["BoiKit"],
            exclude: ["app.boi.mac.wake-helper.plist"]
        ),
        .testTarget(name: "BoiKitTests", dependencies: ["BoiKit"]),
    ]
)

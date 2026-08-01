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
    ],
    targets: [
        .target(name: "BoiKit"),
        .testTarget(name: "BoiKitTests", dependencies: ["BoiKit"]),
    ]
)

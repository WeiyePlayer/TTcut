// swift-tools-version: 5.10
import PackageDescription
import Foundation
let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vendor/native").path

let package = Package(
    name: "TTcutNative", platforms: [.macOS("15.0")],
    products: [.library(name: "TTcutCore", targets: ["TTcutCore"]), .library(name: "TTcutMedia", targets: ["TTcutMedia"]), .library(name: "TTNative", targets: ["TTNative"]), .executable(name: "TTcutWorker", targets: ["TTcutWorker"]), .executable(name: "TTcutMediaWorker", targets: ["TTcutMediaWorker"])],
    targets: [
        .target(name: "TTcutCore", path: "Sources/Core"),
        .target(name: "TTcutMedia", dependencies: ["TTcutCore"], path: "Sources/Media"),
        .target(name: "TTNative", path: "Sources/NativeBridge", publicHeadersPath: "include",
                cxxSettings: [.unsafeFlags(["-I" + native + "/include", "-I" + native + "/include/opencv4"])],
                linkerSettings: [.unsafeFlags(["-L" + native + "/lib", "-Xlinker", "-rpath", "-Xlinker", native + "/lib"]),
                                 .linkedLibrary("avformat"), .linkedLibrary("avcodec"), .linkedLibrary("avfilter"), .linkedLibrary("avutil"),
                                 .linkedLibrary("opencv_imgproc"), .linkedLibrary("opencv_core"), .linkedLibrary("z"),
                                 .unsafeFlags([native + "/lib/opencv4/3rdparty/libtegra_hal.a"]), .linkedFramework("Accelerate")]),
        .executableTarget(name: "TTcutWorker", dependencies: ["TTcutCore", "TTNative"], path: "Sources/Worker"),
        .executableTarget(name: "TTcutMediaWorker", dependencies: ["TTcutCore", "TTcutMedia"], path: "Sources/MediaWorker"),
        .testTarget(name: "TTcutCoreTests", dependencies: ["TTcutCore"], path: "Tests/Core", resources: [.copy("Fixtures")]),
        .testTarget(name: "TTcutMediaTests", dependencies: ["TTcutCore", "TTcutMedia", "TTNative"], path: "Tests/Media", resources: [.copy("Fixtures")])
    ], cxxLanguageStandard: .cxx17
)

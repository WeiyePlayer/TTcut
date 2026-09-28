import Foundation
import TTcutCore
import XCTest

@testable import TTcutMedia

final class ScoreboardExportTests: XCTestCase {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
  var paths: RuntimePaths {
    RuntimePaths(ffmpeg: root.appendingPathComponent("Vendor/native/bin/ffmpeg"),
      ffprobe: root.appendingPathComponent("Vendor/native/bin/ffprobe"),
      worker: root.appendingPathComponent(".build/debug/TTcutWorker"),
      models: root.appendingPathComponent("Resources/Models/compiled"))
  }
  func testBothStrategiesBurnPerSegmentOverlaysAndRetainAudio() async throws {
    guard ProcessInfo.processInfo.environment["TTCUT_NATIVE_TESTS"] == "1" else {
      throw XCTSkip("Requires bundled FFmpeg; use TTCUT_NATIVE_TESTS=1")
    }
    let folder = root.appendingPathComponent("output/tests/scoreboard-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let source = folder.appendingPathComponent("source.mp4")
    _ = try await ProcessRunner.run(paths.ffmpeg, ["-v", "error", "-f", "lavfi", "-i",
      "color=c=gray:s=640x360:r=30:d=4", "-f", "lavfi", "-i", "sine=duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source.path])
    let boardPaths = ["red", "blue"].map { folder.appendingPathComponent($0 + ".png") }
    for (color, file) in zip(["red", "blue"], boardPaths) {
      _ = try await ProcessRunner.run(paths.ffmpeg, ["-v", "error", "-f", "lavfi", "-i",
        "color=c=\(color):s=179x34", "-frames:v", "1", "-pix_fmt", "rgb24", file.path])
    }
    let video = try await MediaProbe(paths: paths).inspect(source)
    let exporter = MediaExporter(paths: paths)
    let overlays = boardPaths.map { ScoreboardOverlay(x: 0.1, y: 0.1, scale: 1, imagePath: $0.path) }
    for strategy in [ExportStrategy.fastSegmented, .compatible] {
      let output = folder.appendingPathComponent(strategy.rawValue + ".mp4")
      try await exporter.merged(video: video, ranges: [CutRange(0.5, 1.5), CutRange(2.5, 3.5)],
        destination: output, strategy: strategy, scoreboards: overlays)
      let actual = try await exporter.validate(output, source: video, duration: 2, segments: 2)
      XCTAssertTrue(actual.hasAudio)
      for (time, channel) in [("0.5", 0), ("1.5", 2)] {
        let frame = try await ProcessRunner.run(paths.ffmpeg, ["-v", "error", "-ss", time,
          "-i", output.path, "-frames:v", "1", "-vf", "crop=4:4:70:40", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
        let pixels = Array(frame.stdout)
        XCTAssertEqual(pixels.count, 48)
        XCTAssertGreaterThan(pixels[channel], 180, "Overlay must change at the segment boundary")
        XCTAssertLessThan(pixels[1], 50)
      }
    }
  }

  func testNativeRotatedDimensionsAreNotRotatedTwice() {
    var video = VideoInfo()
    video.width = 360; video.height = 640; video.rotation = 90
    let overlay = ScoreboardOverlay(x: 0.5, y: 0.25, scale: 1, imagePath: "/tmp/board.png")
    XCTAssertEqual(MediaExporter.scoreboardFilter(video: video, score: overlay),
      "overlay=x=180:y=160:shortest=1:format=auto")
  }

  func testRotatedAndHDROverlaysUseDisplayGeometryAndPreserveFormat() async throws {
    guard ProcessInfo.processInfo.environment["TTCUT_NATIVE_TESTS"] == "1" else {
      throw XCTSkip("Requires bundled FFmpeg; use TTCUT_NATIVE_TESTS=1")
    }
    let folder = root.appendingPathComponent("output/tests/scoreboard-format-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    for kind in ["rotated", "hdr10", "hlg"] {
      let source = folder.appendingPathComponent(kind + ".mp4")
      let base = folder.appendingPathComponent(kind + "-base.mp4")
      let hdr = kind != "rotated"
      var args = ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30:d=2",
        "-c:v", hdr ? "libx265" : "libx264", "-preset", "ultrafast", "-pix_fmt", hdr ? "yuv420p10le" : "yuv420p"]
      if hdr {
        let transfer = kind == "hdr10" ? "smpte2084" : "arib-std-b67"
        args += ["-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc",
          "-tag:v", "hvc1", "-x265-params", "pools=2:frame-threads=2:log-level=error"]
      }
      _ = try await ProcessRunner.run(paths.ffmpeg, args + [hdr ? source.path : base.path])
      if !hdr {
        _ = try await ProcessRunner.run(paths.ffmpeg, ["-v", "error", "-display_rotation:v:0", "90",
          "-i", base.path, "-c", "copy", source.path])
      }
      let video = try await MediaProbe(paths: paths).inspect(source)
      let board = folder.appendingPathComponent(kind + "-board.png")
      let width = Int((Double(video.width) * 0.28).rounded())
      let height = Int((Double(width) / 5.2).rounded())
      _ = try await ProcessRunner.run(paths.ffmpeg, ["-v", "error", "-f", "lavfi", "-i",
        "color=c=red:s=\(width)x\(height),format=rgb24", "-frames:v", "1", board.path])
      let result = folder.appendingPathComponent(kind + "-result.mp4")
      let exporter = MediaExporter(paths: paths)
      try await exporter.merged(video: video, ranges: [CutRange(0.5, 1.5)], destination: result,
        strategy: .fastSegmented, scoreboards: [ScoreboardOverlay(x: 0.5, y: 0.25, scale: 1, imagePath: board.path)])
      let actual = try await exporter.validate(result, source: video, duration: 1, segments: 1)
      XCTAssertEqual(actual.width, video.width); XCTAssertEqual(actual.height, video.height)
      XCTAssertEqual(actual.hdr, video.hdr); XCTAssertEqual(actual.bitDepth, video.bitDepth)
      XCTAssertEqual(actual.videoCodec, video.videoCodec)
      let x = video.width / 2 + 5, y = video.height / 4 + 5
      let frame = try await ProcessRunner.run(paths.ffmpeg, ["-v", "error", "-ss", "0.5", "-i",
        result.path, "-frames:v", "1", "-vf", "crop=4:4:\(x):\(y)", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
      let pixels = Array(frame.stdout)
      XCTAssertEqual(pixels.count, 48); XCTAssertGreaterThan(pixels[0], pixels[1] + 50)
    }
  }

  func testRejectsMismatchedAndInvalidScoreboardsBeforeExport() async throws {
    let exporter = MediaExporter(paths: paths)
    for overlays in [[], [ScoreboardOverlay(x: .nan, y: 0, scale: 1, imagePath: "/tmp/board.png")]] {
      do {
        try await exporter.merged(video: VideoInfo(), ranges: [CutRange(0, 1)],
          destination: URL(fileURLWithPath: "/tmp/unused-scoreboard.mp4"),
          strategy: .fastSegmented, scoreboards: overlays)
        XCTFail("Invalid scoreboard was accepted")
      } catch let error as TTError { XCTAssertEqual(error.code, "INVALID_SCOREBOARD") }
    }
  }
}

import TTNative
import TTcutCore
import XCTest

@testable import TTcutMedia

final class MediaIntegrationTests: XCTestCase {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()
  var paths: RuntimePaths {
    RuntimePaths(
      ffmpeg: root.appendingPathComponent("Vendor/native/bin/ffmpeg"),
      ffprobe: root.appendingPathComponent("Vendor/native/bin/ffprobe"),
      worker: root.appendingPathComponent(".build/debug/TTcutWorker"),
      models: root.appendingPathComponent("Resources/Models/compiled"))
  }
  func workspace() throws -> URL {
    guard ProcessInfo.processInfo.environment["TTCUT_NATIVE_TESTS"] == "1" else {
      throw XCTSkip("Run with TTCUT_NATIVE_TESTS=1 after preparing native dependencies")
    }
    let url = root.appendingPathComponent("output/tests/" + UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
  func generate(
    _ url: URL, hdr: HDRKind = .sdr, size: String = "640x360", duration: String = "4",
    fps: String = "30", audio: Bool = true
  ) async throws {
    let ten = hdr != .sdr
    var args = [
      "-v", "error", "-y", "-f", "lavfi", "-i",
      "testsrc2=size=\(size):rate=\(fps):duration=\(duration)",
    ]
    if audio {
      args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=\(duration)"]
    }
    args += [
      "-c:v", ten ? "libx265" : "libx264", "-preset", "ultrafast", "-threads", "2", "-pix_fmt",
      ten ? "yuv420p10le" : "yuv420p", "-g", "30",
    ]
    if ten {
      args += [
        "-color_primaries", "bt2020", "-color_trc", hdr == .hdr10 ? "smpte2084" : "arib-std-b67",
        "-colorspace", "bt2020nc", "-color_range", "tv", "-tag:v", "hvc1", "-x265-params",
        "pools=2:frame-threads=2:log-level=error:colorprim=bt2020:colormatrix=bt2020nc:transfer=\(hdr == .hdr10 ? "smpte2084":"arib-std-b67")"
          + (hdr == .hdr10
            ? ":hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400"
            : ""),
      ]
    }
    if audio { args += ["-c:a", "aac", "-ac", "2"] }
    _ = try await ProcessRunner.run(paths.ffmpeg, args + [url.path])
  }
  func testBothExportStrategiesAndAudio() async throws {
    let folder = try workspace()
    let source = folder.appendingPathComponent("source.mp4")
    try await generate(source)
    let video = try await MediaProbe(paths: paths).inspect(source)
    let exporter = MediaExporter(paths: paths)
    XCTAssertEqual(video.width, 640)
    XCTAssertEqual(video.bitDepth, 8)
    XCTAssertTrue(video.hasAudio)
    let ranges = [CutRange(0.4, 1.3), CutRange(2.1, 3.4)]
    for strategy in [ExportStrategy.fastSegmented, .compatible] {
      let output = folder.appendingPathComponent(strategy.rawValue + ".mp4")
      try await exporter.merged(
        video: video, ranges: ranges, destination: output, strategy: strategy)
      let actual = try await exporter.validate(output, source: video, duration: 2.2, segments: 2)
      XCTAssertEqual(actual.audioChannels, 2)
    }
  }
  func testExportEncodingUsesInputSeekAndAutomaticThreading() throws {
    var video = VideoInfo(path: "/tmp/source.mp4")
    video.videoCodec = "hevc"
    let input = MediaExporter.inputArguments(video, seekStart: 12.25)
    XCTAssertEqual(input, ["-copyts", "-ss", "12.250000000", "-i", video.path])
    XCTAssertEqual(
      MediaExporter.inputArguments(video, seekStart: 0), ["-copyts", "-i", video.path])

    let encoding = try MediaExporter.encoding(video)
    XCTAssertFalse(encoding.contains("-threads"))
    let x265Index = try XCTUnwrap(encoding.firstIndex(of: "-x265-params"))
    let x265 = encoding[x265Index + 1]
    XCTAssertFalse(x265.contains("pools="))
    XCTAssertFalse(x265.contains("frame-threads="))
  }
  func testHDR10AndHLGPreserveStaticMetadata() async throws {
    let folder = try workspace()
    let exporter = MediaExporter(paths: paths)
    for hdr in [HDRKind.hdr10, .hlg] {
      let source = folder.appendingPathComponent(hdr.rawValue + ".mp4")
      try await generate(source, hdr: hdr, size: "256x144", duration: "2", fps: "12")
      let video = try await MediaProbe(paths: paths).inspect(source)
      XCTAssertEqual(video.hdr, hdr)
      XCTAssertEqual(video.bitDepth, 10)
      if hdr == .hdr10 {
        XCTAssertNotNil(video.masteringDisplay)
        XCTAssertEqual(video.maxCLL, "1000,400")
      }
      let output = folder.appendingPathComponent(hdr.rawValue + "-cut.mp4")
      try await exporter.merged(
        video: video, ranges: [CutRange(0.25, 1.75)], destination: output, strategy: .compatible)
      _ = try await exporter.validate(output, source: video, duration: 1.5, segments: 1)
      let reader = try XCTUnwrap(tt_reader_open(source.path, 0, 1, video.fps))
      defer { tt_reader_close(reader) }
      var frame = TTFrame()
      XCTAssertEqual(tt_reader_next(reader, &frame), 1, String(cString: tt_last_error()))
      XCTAssertEqual(frame.width, 256)
    }
  }

  func testDynamicHDRExportIsRejectedBeforeCopyOrEncoding() async throws {
    var video = VideoInfo(path: "/nonexistent/dynamic-hdr.mp4")
    video.width = 320
    video.height = 180
    video.duration = 2
    video.fps = 12
    let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
    for kind in [HDRKind.dolbyVision, .hdr10Plus] {
      video.hdr = kind
      XCTAssertThrowsError(try MediaExporter.encoding(video)) {
        XCTAssertEqual(($0 as? TTError)?.code, "DYNAMIC_HDR_UNSUPPORTED")
      }
      for strategy in [ExportStrategy.fastSegmented, .compatible] {
        do {
          try await MediaExporter(paths: paths).merged(
            video: video, ranges: [CutRange(0, 1)], destination: destination, strategy: strategy)
          XCTFail("Dynamic metadata would be lost during export")
        } catch let error as TTError {
          XCTAssertEqual(error.code, "DYNAMIC_HDR_UNSUPPORTED")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
      }
    }
  }

  func testHDR10PlusCanBeProbedPreviewedAndAnalyzed() async throws {
    let folder = try workspace()
    let raw = folder.appendingPathComponent("hdr10.hevc")
    _ = try await ProcessRunner.run(paths.ffmpeg, [
      "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=2",
      "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
      "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
      "-color_range", "tv", "-x265-params",
      "pools=2:frame-threads=2:log-level=error:hdr10=1:bframes=0:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
      "-f", "hevc", raw.path,
    ])
    // Valid SMPTE 2094-40 payload serialized by libavutil's av_dynamic_hdr_plus_to_t35:
    // one window, 1000-nit target, maxSCL 0.1, average maxRGB 0.05, 99th percentile 0.1.
    let metadata: [UInt8] = [
      0xb5, 0x00, 0x3c, 0x00, 0x01, 0x04, 0x01, 0x40, 0x00, 0x1f, 0x40, 0x4e, 0x20,
      0x27, 0x10, 0x13, 0x88, 0x04, 0xe2, 0x07, 0x18, 0x9c, 0x40, 0x00, 0x00,
    ]
    var escaped: [UInt8] = []
    var zeros = 0
    for byte in [UInt8(4), UInt8(metadata.count)] + metadata + [0x80] {
      if zeros >= 2 && byte <= 3 { escaped.append(3); zeros = 0 }
      escaped.append(byte)
      zeros = byte == 0 ? zeros + 1 : 0
    }
    let sei: [UInt8] = [0, 0, 0, 1, 0x4e, 1] + escaped
    let bytes = [UInt8](try Data(contentsOf: raw))
    var tagged = Data()
    var index = 0
    var last = 0
    var inserted = 0
    while index + 5 < bytes.count {
      let prefix = bytes[index] == 0 && bytes[index + 1] == 0
        ? (bytes[index + 2] == 1 ? 3 : bytes[index + 2] == 0 && bytes[index + 3] == 1 ? 4 : 0) : 0
      if prefix == 0 { index += 1; continue }
      if (bytes[index + prefix] >> 1) & 0x3f <= 31 {
        tagged.append(contentsOf: bytes[last..<index])
        tagged.append(contentsOf: sei)
        last = index
        inserted += 1
      }
      index += prefix + 2
    }
    tagged.append(contentsOf: bytes[last...])
    XCTAssertEqual(inserted, 24)
    let taggedRaw = folder.appendingPathComponent("hdr10plus.hevc")
    try tagged.write(to: taggedRaw)
    let source = folder.appendingPathComponent("hdr10plus.mp4")
    _ = try await ProcessRunner.run(paths.ffmpeg, [
      "-v", "error", "-y", "-r", "12", "-i", taggedRaw.path, "-c", "copy", "-tag:v", "hvc1", source.path,
    ])

    let identity = try SourceIdentity(url: source)
    let video = try await MediaProbe(paths: paths).inspect(source)
    XCTAssertEqual(video.hdr, .hdr10Plus)
    XCTAssertEqual(video.colorTransfer, "smpte2084")
    XCTAssertEqual(video.bitDepth, 10)
    XCTAssertEqual(video.frameCount, 24)
    let reader = try XCTUnwrap(tt_reader_open(source.path, 0, 1, video.fps))
    defer { tt_reader_close(reader) }
    var decoded = 0
    while true {
      var frame = TTFrame()
      let status = tt_reader_next(reader, &frame)
      XCTAssertGreaterThanOrEqual(status, 0, String(cString: tt_last_error()))
      if status <= 0 { break }
      XCTAssertEqual(frame.width, 320)
      decoded += 1
    }
    XCTAssertEqual(decoded, 24)

    let previewPath = folder.appendingPathComponent("preview.mp4")
    try await MediaPreview.render(video: video, paths: paths, destination: previewPath)
    let preview = try await MediaProbe(paths: paths).inspect(previewPath)
    XCTAssertEqual(preview.hdr, .sdr)
    XCTAssertEqual(preview.videoCodec, "h264")
    let cover = folder.appendingPathComponent("cover.jpg")
    try await MediaExporter(paths: paths).cover(video: video, destination: cover)
    XCTAssertTrue(FileManager.default.fileExists(atPath: cover.path))

    var request = AnalysisRequest(
      taskID: UUID().uuidString, operation: "analyze", video: video, modelsDirectory: paths.models.path)
    request.calibration = Calibration(width: 320, height: 180, points: [
      Point(40, 40), Point(280, 40), Point(300, 160), Point(20, 160),
    ])
    request.rallyRecognitionMethod = .continuousVisibility
    let result = try await AnalysisClient.run(request, paths: paths) { _ in }
    XCTAssertEqual(result.type, "result")
    XCTAssertNotNil(result.visibilityRallies)
    request.operation = "calibrate"
    do {
      let calibration = try await AnalysisClient.run(request, paths: paths) { _ in }
      XCTAssertEqual(calibration.tableSamples?.count, 11)
    } catch let error as TTError {
      // Synthetic pattern footage is not a real table; the HDR gate must not prevent inference.
      XCTAssertEqual(error.code, "AUTO_CALIBRATION_FAILED")
    }
    XCTAssertEqual(identity.currentStatus, .available)
  }

  func testSynthetic8KCut() async throws {
    let folder = try workspace()
    let source = folder.appendingPathComponent("8k.mp4")
    try await generate(source, size: "7680x4320", duration: "2", fps: "1", audio: false)
    let video = try await MediaProbe(paths: paths).inspect(source)
    XCTAssertEqual(video.width, 7680)
    let output = folder.appendingPathComponent("8k-cut.mp4")
    try await MediaExporter(paths: paths).merged(
      video: video, ranges: [CutRange(0, 1)], destination: output, strategy: .compatible)
    let result = try await MediaProbe(paths: paths).inspect(output)
    XCTAssertEqual(result.width, 7680)
    XCTAssertEqual(result.height, 4320)
  }
  func testSynthetic8KTenBitHEVCHDR() async throws {
    let folder = try workspace()
    let source = folder.appendingPathComponent("8k-hdr.mp4")
    try await generate(
      source, hdr: .hdr10, size: "7680x4320", duration: "2", fps: "1", audio: false)
    let video = try await MediaProbe(paths: paths).inspect(source)
    XCTAssertEqual(video.bitDepth, 10)
    XCTAssertEqual(video.hdr, .hdr10)
    let output = folder.appendingPathComponent("8k-hdr-cut.mp4")
    let exporter = MediaExporter(paths: paths)
    try await exporter.merged(
      video: video, ranges: [CutRange(0, 1)], destination: output, strategy: .compatible)
    let actual = try await exporter.validate(output, source: video, duration: 1, segments: 1)
    XCTAssertEqual(actual.width, 7680)
    XCTAssertEqual(actual.videoCodec, "hevc")
    XCTAssertEqual(actual.maxCLL, "1000,400")
  }
  func testMissingAnalysisModelProducesTypedFailureWithoutTouchingSource() async throws {
    let folder = try workspace()
    let source = folder.appendingPathComponent("failure-source.mp4")
    try await generate(source, duration: "2", audio: false)
    let video = try await MediaProbe(paths: paths).inspect(source)
    let calibration = Calibration(
      width: 640, height: 360,
      points: [Point(100, 120), Point(540, 120), Point(590, 320), Point(50, 320)])
    var analysis = AnalysisRequest(
      taskID: UUID().uuidString, operation: "analyze", video: video,
      modelsDirectory: folder.appendingPathComponent("missing-models").path)
    analysis.calibration = calibration
    do {
      _ = try await AnalysisClient.run(analysis, paths: paths) { _ in }
      XCTFail("Missing model succeeded")
    } catch let error as TTError { XCTAssertFalse(error.code.isEmpty) }
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
  }
  func testNativeWorkerSyntheticVideoAndProtocol() async throws {
    let folder = try workspace()
    let source = folder.appendingPathComponent("worker.mp4")
    try await generate(source, duration: "1", fps: "8", audio: false)
    let video = try await MediaProbe(paths: paths).inspect(source)
    var request = AnalysisRequest(
      taskID: UUID().uuidString, operation: "analyze", video: video,
      modelsDirectory: paths.models.path)
    request.calibration = Calibration(
      width: 640, height: 360,
      points: [Point(100, 120), Point(540, 120), Point(590, 320), Point(50, 320)])
    let result = try await AnalysisClient.run(request, paths: paths) { _ in }
    XCTAssertEqual(result.type, "result")
    XCTAssertNotNil(result.rallies)
    XCTAssertNotNil(result.bounceTimes)
    request.rallyRecognitionMethod = .continuousVisibility
    let continuous = try await AnalysisClient.run(request, paths: paths) { _ in }
    XCTAssertEqual(continuous.type, "result")
    XCTAssertNotNil(continuous.visibilityRallies)
    XCTAssertNotNil(continuous.bounceTimes)
    request.rallyRecognitionMethod = nil
    request.mode = .twoStage
    let second = try await AnalysisClient.run(request, paths: paths) { _ in }
    XCTAssertEqual(second.type, "result")
    // Pattern footage need not contain a valid table: either a result or a typed calibration error is acceptable.
    request.operation = "calibrate"
    do {
      let table = try await AnalysisClient.run(request, paths: paths) { _ in }
      try table.calibration?.validate()
      XCTAssertEqual(table.tableSamples?.count, 11)
    } catch let error as TTError { XCTAssertEqual(error.code, "AUTO_CALIBRATION_FAILED") }
  }
  func testCancellationStopsProcess() async throws {
    _ = try workspace()
    let task = Task {
      try await ProcessRunner.run(
        paths.ffmpeg,
        [
          "-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30", "-f", "null",
          "-",
        ])
    }
    try await Task.sleep(nanoseconds: 300_000_000)
    task.cancel()
    do {
      _ = try await task.value
      XCTFail("Cancelled FFmpeg succeeded")
    } catch is CancellationError {} catch { XCTFail("\(error)") }
  }
  func testVFRNormalizationProducesCFRMedia() async throws {
    let folder = try workspace()
    let source = folder.appendingPathComponent("vfr.mp4")
    _ = try await ProcessRunner.run(
      paths.ffmpeg,
      [
        "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3", "-vf",
        "select=if(lt(t\\,1)\\,1\\,not(mod(n\\,3)))", "-fps_mode", "vfr", "-c:v", "libx264",
        "-preset", "ultrafast", source.path,
      ])
    let video = try await MediaProbe(paths: paths).inspect(source)
    XCTAssertTrue(video.variableFrameRate)
    let destination = folder.appendingPathComponent("normalized.mp4")
    let exporter = MediaExporter(paths: paths)
    try await exporter.encode(
      video: video, ranges: [CutRange(0, video.duration)], destination: destination,
      normalizeFPS: true)
    let normalized = try await exporter.validate(
      destination, source: video, duration: video.duration, segments: 1)
    XCTAssertFalse(normalized.variableFrameRate)
    XCTAssertNotEqual(normalized.path, source.path)
    XCTAssertEqual(video.path, source.path)
  }
  func testTenBitSDRMultichannelAndRotatedSAR() async throws {
    let folder = try workspace()
    let source = folder.appendingPathComponent("tenbit.mp4")
    _ = try await ProcessRunner.run(
      paths.ffmpeg,
      [
        "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2", "-f",
        "lavfi", "-i", "anullsrc=channel_layout=5.1:sample_rate=48000", "-t", "2", "-vf",
        "setsar=4/3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-c:a",
        "aac", "-ac", "6", source.path,
      ])
    let rotated = folder.appendingPathComponent("rotated.mp4")
    _ = try await ProcessRunner.run(
      paths.ffmpeg,
      [
        "-v", "error", "-y", "-display_rotation:v:0", "90", "-i", source.path, "-map", "0", "-c",
        "copy", rotated.path,
      ])
    let video = try await MediaProbe(paths: paths).inspect(rotated)
    XCTAssertEqual(video.bitDepth, 10)
    XCTAssertEqual(video.audioChannels, 6)
    XCTAssertEqual(video.width, 180)
    XCTAssertEqual(video.height, 320)
    let output = folder.appendingPathComponent("rotated-cut.mp4")
    let exporter = MediaExporter(paths: paths)
    try await exporter.merged(
      video: video, ranges: [CutRange(0.25, 1.75)], destination: output, strategy: .compatible)
    let result = try await exporter.validate(output, source: video, duration: 1.5, segments: 1)
    XCTAssertEqual(result.rotation, 0)
    XCTAssertEqual(result.bitDepth, 10)
    XCTAssertEqual(result.audioChannels, 6)
    XCTAssertEqual(VideoInfo.ratio(result.sar), 0.75, accuracy: 0.0001)
  }
}

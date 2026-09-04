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
  func testFailureIsolationAndPartialArtifactRecovery() async throws {
    let folder = try workspace()
    let source = folder.appendingPathComponent("failure-source.mp4")
    try await generate(source, duration: "2", audio: false)
    let video = try await MediaProbe(paths: paths).inspect(source)
    let calibration = Calibration(
      width: 640, height: 360,
      points: [Point(100, 120), Point(540, 120), Point(590, 320), Point(50, 320)])
    let result = AnalysisResult(
      source: try SourceIdentity(url: source), sourceVideo: video, video: video,
      processing: ProcessingMedia(mode: .originalCFR, path: video.path), calibration: calibration,
      mode: .full, rallies: [], bounceTimes: [])
    let clips = [
      CustomClip(id: "manual", sourceRallyID: nil, index: 1, bounceCount: 0, start: 0.25, end: 1.25)
    ]
    var broken = paths
    broken.ffmpeg = folder.appendingPathComponent("missing-ffmpeg")
    let request = ExportRequest(
      result: result, mode: .custom, threshold: 5, settings: Settings(), clips: clips,
      outputs: ExportOutputs(combined: false, rallyVideos: true, xml: true), destination: folder)
    let partial = try await MediaExporter(paths: broken).exportResult(request)
    XCTAssertEqual(partial.files, ["TTcut.xml"])
    XCTAssertEqual(partial.warnings.count, 1)
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: partial.folder.appendingPathComponent("TTcut.xml").path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
    let unwritable = folder.appendingPathComponent("not-a-directory")
    try Data([1]).write(to: unwritable)
    var badDestination = request
    badDestination.destination = unwritable
    do {
      _ = try await MediaExporter(paths: paths).exportResult(badDestination)
      XCTFail("File used as output directory")
    } catch { XCTAssertEqual(try Data(contentsOf: unwritable), Data([1])) }
    var analysis = AnalysisRequest(
      taskID: UUID().uuidString, operation: "analyze", video: video,
      modelsDirectory: folder.appendingPathComponent("missing-models").path)
    analysis.calibration = calibration
    do {
      _ = try await AnalysisClient.run(analysis, paths: paths) { _ in }
      XCTFail("Missing model succeeded")
    } catch let error as TTError { XCTAssertFalse(error.code.isEmpty) }
    try Data([2, 3]).write(to: source)
    do {
      _ = try await MediaExporter(paths: paths).exportResult(request)
      XCTFail("Changed source accepted")
    } catch let error as TTError { XCTAssertEqual(error.code, "SOURCE_CHANGED_OR_MISSING") }
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
    request.mode = .twoStage
    let second = try await AnalysisClient.run(request, paths: paths) { _ in }
    XCTAssertEqual(second.type, "result")
    // Pattern footage need not contain a valid table: either a result or a typed calibration error is acceptable.
    request.operation = "calibrate"
    do {
      let table = try await AnalysisClient.run(request, paths: paths) { _ in }
      try table.calibration?.validate()
      XCTAssertEqual(table.tableSamples?.count, 5)
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
  func testVFRNormalizationAndProvenance() async throws {
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
    let store = HistoryStore(root: folder.appendingPathComponent("state"))
    let (normalized, media) = try await MediaExporter(paths: paths).processing(
      source: video, normalize: true, store: store)
    XCTAssertEqual(media.mode, .normalizedCFR, media.warning ?? "")
    XCTAssertFalse(normalized.variableFrameRate)
    XCTAssertNotEqual(normalized.path, source.path)
    XCTAssertEqual(video.path, source.path)
    let (cached, cachedMedia) = try await MediaExporter(paths: paths).processing(
      source: video, normalize: true, store: store)
    XCTAssertEqual(cached.path, normalized.path)
    XCTAssertEqual(media.cacheKey, cachedMedia.cacheKey)
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
  func testXMLAndManualArtifactExports() async throws {
    let folder = try workspace()
    let source = folder.appendingPathComponent("manual.mp4")
    try await generate(source)
    let video = try await MediaProbe(paths: paths).inspect(source)
    let calibration = Calibration(
      width: 640, height: 360,
      points: [Point(100, 100), Point(540, 100), Point(590, 320), Point(50, 320)])
    let value = AnalysisResult(
      source: try SourceIdentity(url: source), sourceVideo: video, video: video,
      processing: ProcessingMedia(mode: .originalCFR, path: source.path), calibration: calibration,
      mode: .full, rallies: [], bounceTimes: [])
    let clips = [
      CustomClip(id: "manual", sourceRallyID: nil, index: 1, bounceCount: 0, start: 0.5, end: 1.5)
    ]
    let request = ExportRequest(
      result: value, mode: .custom, threshold: 5, settings: Settings(), clips: clips,
      outputs: ExportOutputs(combined: false, rallyVideos: true, xml: true), destination: folder)
    let output = try await MediaExporter(paths: paths).export(request)
    let xml = try String(contentsOf: output.appendingPathComponent("TTcut.xml"))
    XCTAssertTrue(xml.contains("<xmeml version=\"4\">"))
    XCTAssertTrue(xml.contains("<timebase>30</timebase>"))
    XCTAssertTrue(xml.contains("<in>15</in>"))
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: output.appendingPathComponent("001_回合001.mp4").path))
  }
}

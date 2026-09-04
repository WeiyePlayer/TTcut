import XCTest

@testable import TTcutCore

final class ParityTests: XCTestCase {
  func testActiveProcessingMediaLeaseSurvivesHistoryCleanup() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = HistoryStore(root: root)
    let key = String(repeating: "a", count: 64)
    let directory = await store.processingRoot.appendingPathComponent(key)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("processing.mp4")
    try Data([1, 2, 3]).write(to: file)
    let media = ProcessingMedia(mode: .normalizedCFR, path: file.path, cacheKey: key)
    let first = await store.retainMedia(media)
    let second = await store.retainMedia(media)
    try await store.cleanupUnreferencedMedia()
    XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    try await store.releaseMedia(first)
    XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    try await store.releaseMedia(second)
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
  }
  struct Fixture: Decodable {
    var calibration: Calibration
    var roi: AnalysisROI
    var cases: [Case]
    struct Case: Decodable {
      var name: String
      var points: [TrajectoryPoint]
      var expected: [Int]
    }
  }
  func testPythonBounceAndROIParity() throws {
    let url = Bundle.module.url(
      forResource: "python-parity", withExtension: "json", subdirectory: "Fixtures")!
    let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    let roi = try AnalysisROI(calibration: fixture.calibration)
    XCTAssertEqual(
      [roi.x, roi.y, roi.width, roi.height, roi.modelWidth, roi.modelHeight],
      [
        fixture.roi.x, fixture.roi.y, fixture.roi.width, fixture.roi.height, fixture.roi.modelWidth,
        fixture.roi.modelHeight,
      ])
    for item in fixture.cases {
      XCTAssertEqual(
        try BounceDetector.detect(item.points, calibration: fixture.calibration), item.expected,
        item.name)
    }
  }
  func testHistoryRecoveryAndSourceProtection() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("source.mp4")
    try Data("source-file".utf8).write(to: source)
    let identity = try SourceIdentity(url: source)
    let store = HistoryStore(root: root.appendingPathComponent("state"))
    var video = VideoInfo(path: source.path)
    video.width = 640
    video.height = 360
    video.duration = 10
    let calibration = Calibration(
      width: 640, height: 360,
      points: [Point(100, 100), Point(540, 100), Point(590, 320), Point(50, 320)])
    let record = AnalysisResult(
      source: identity, sourceVideo: video, video: video,
      processing: ProcessingMedia(mode: .originalCFR, path: source.path), calibration: calibration,
      mode: .full, rallies: [Rally(index: 1, start: 2, end: 4, bounceCount: 3)],
      bounceTimes: [2, 3, 4])
    try await store.save(record, cover: Data([1, 2, 3]))
    let corrupt = await store.root.appendingPathComponent(
      "history/records/" + UUID().uuidString + ".json")
    try Data("{broken record".utf8).write(to: corrupt)
    let path = await store.root.appendingPathComponent("history/index.json")
    try Data("corrupted".utf8).write(to: path)
    let entries = try await store.list()
    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries.first?.status, .available)
    XCTAssertFalse(FileManager.default.fileExists(atPath: corrupt.path))
    let quarantined = try FileManager.default.contentsOfDirectory(
      at: await store.root.appendingPathComponent("history/quarantine"),
      includingPropertiesForKeys: nil)
    XCTAssertEqual(quarantined.count, 1)
    try await store.delete(record.id)
    XCTAssertEqual(try Data(contentsOf: source), Data("source-file".utf8))
    let empty = try await store.list()
    XCTAssertTrue(empty.isEmpty)
    XCTAssertEqual(
      try HistoryStore.cacheKey(identity: identity, rate: "30/1", encoder: "libx264"),
      try HistoryStore.cacheKey(identity: identity, rate: "30/1", encoder: "libx264"))
  }
}

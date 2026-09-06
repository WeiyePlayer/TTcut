import XCTest

@testable import TTcutCore

final class VisibilityRalliesTests: XCTestCase {
  struct StabilityFixture: Decodable {
    struct CalibrationValue: Decodable {
      var videoWidth: Int
      var videoHeight: Int
      var points: [String: [Double]]
    }
    var calibrations: [CalibrationValue]
    var fps: Double
    var trajectory: [[Double]]
    var expected: [[Double?]]
  }
  let fps = 10.0
  let motion = VisibilityMotionConfig(analysisWidthPixels: 200, analysisHeightPixels: 100)

  func point(
    _ frame: Int, _ visible: Bool, x: Double = 100, y: Double = 20, fps: Double = 10
  ) -> TrajectoryPoint {
    TrajectoryPoint(
      frame: frame, time: Double(frame) / fps, x: x, y: y,
      confidence: visible ? 1 : 0, visible: visible)
  }

  func points(_ xs: [Double?]) -> [TrajectoryPoint] {
    xs.enumerated().map { frame, x in
      point(frame, x != nil, x: x ?? 0)
    }
  }

  func fullFrameCalibration() -> Calibration {
    Calibration(
      width: 200, height: 100,
      points: [Point(0, 0), Point(199, 0), Point(199, 99), Point(0, 99)])
  }

  func testContinuousVisibilityConfirmationOcclusionAndEOFBoundaries() throws {
    XCTAssertEqual(
      try VisibilityRallies.detect([point(0, true), point(1, false), point(2, true)], fps: fps),
      [])
    XCTAssertEqual(
      try VisibilityRallies.detect(
        [point(0, true), point(1, true)] + (2...6).map { point($0, false) }, fps: fps),
      [VisibilityRally(startFrame: 0, endFrame: 1, startTime: 0, endTime: 0.1)])
    XCTAssertEqual(
      try VisibilityRallies.detect(
        [point(0, true), point(1, true)] + (2...5).map { point($0, false) }
          + [point(6, true)], fps: fps),
      [VisibilityRally(startFrame: 0, endFrame: 6, startTime: 0, endTime: 0.6)])
    XCTAssertEqual(
      try VisibilityRallies.detect([point(0, true), point(1, true), point(2, true)], fps: fps),
      [VisibilityRally(startFrame: 0, endFrame: 2, startTime: 0, endTime: 0.2)])
  }

  func testContinuousVisibilityMotionGateMatchesPythonCases() throws {
    let oneWay = (0..<10).map {
      point($0, true, x: Double($0 * 20), y: $0.isMultiple(of: 2) ? 20 : 60)
    }
    XCTAssertEqual(
      try VisibilityRallies.detect(oneWay, fps: fps, motionConfig: motion), [])

    let exchange = [0, 30, 60, 90, 60, 30, 0, 30, 60].enumerated().map {
      point($0.offset, true, x: Double($0.element))
    }
    XCTAssertEqual(
      try VisibilityRallies.detect(exchange, fps: fps, motionConfig: motion).count, 1)

    let shortMonotonic = (0..<6).map { point($0, true, x: Double($0 * 15)) }
    let qualifiedMonotonic = (0..<7).map { point($0, true, x: Double($0 * 15)) }
    XCTAssertEqual(
      try VisibilityRallies.detect(shortMonotonic, fps: fps, motionConfig: motion), [])
    XCTAssertEqual(
      try VisibilityRallies.detect(qualifiedMonotonic, fps: fps, motionConfig: motion).count, 1)
  }

  func testContinuousVisibilityBridgesOnlyNearbyQualifiedFragments() throws {
    let left = [0, 30, 60, 90, 60, 30, 0]
    let nearby = [60, 90, 120, 150, 120, 90, 60]
    let distant = [150, 180, 210, 240, 210, 180, 150]
    func trajectory(_ right: [Int]) -> [TrajectoryPoint] {
      left.enumerated().map { point($0.offset, true, x: Double($0.element)) }
        + (7..<20).map { point($0, false) }
        + zip(20..<27, right).map { point($0.0, true, x: Double($0.1)) }
    }
    let merged = try VisibilityRallies.detect(
      trajectory(nearby), fps: fps, motionConfig: motion)
    XCTAssertEqual(merged.map { [$0.startFrame, $0.endFrame] }, [[0, 26]])
    XCTAssertEqual(
      try VisibilityRallies.detect(trajectory(distant), fps: fps, motionConfig: motion).count, 2)
  }

  func testEndOnViewAndVisibilityROIStabilizationMatchPython() throws {
    XCTAssertTrue(try VisibilityRallies.isEndOnTableView([
      Point(764, 410), Point(1193, 413), Point(1208, 599), Point(740, 599),
    ]))
    XCTAssertFalse(try VisibilityRallies.isEndOnTableView([
      Point(692, 298), Point(933, 314), Point(827, 416), Point(465, 381),
    ]))
    let calibration = Calibration(
      width: 960, height: 544,
      points: [
        Point(508.6426635694928, 298.08026842173183),
        Point(669.2662279003742, 312.6824106336301),
        Point(540.0934314105045, 378.95367144147633),
        Point(310.9521228545618, 346.37966189185704),
      ])
    let roi = try AnalysisROI(calibration: calibration).stabilizedForVisibility(
      sourceWidth: 960, sourceHeight: 544)
    XCTAssertEqual([roi.x, roi.y, roi.x + roi.width, roi.y + roi.height], [224, 176, 704, 416])
  }

  func testBlurBallRefinementRejectsOneWayFragmentAndKeepsReturn() throws {
    let calibration = Calibration(
      width: 200, height: 100,
      points: [Point(170, 20), Point(199, 20), Point(199, 90), Point(170, 90)])
    let oneWay = points([
      0, 20, 40, 60, 80, 100, 120, nil, 130, 135, 140, nil, 145, 148, 150,
    ])
    XCTAssertEqual(
      try BlurBallVisibilityRallies.detect(
        oneWay, fps: fps, calibration: calibration, motionConfig: motion),
      [])
    let returning = points([
      0, 20, 40, 60, 80, 100, 120, nil, 120, 100, 80, 60, 40, 20, 0, nil, 0, 10, 20,
    ])
    XCTAssertEqual(
      try BlurBallVisibilityRallies.detect(
        returning, fps: fps, calibration: calibration, motionConfig: motion).count,
      1)
  }

  func testBlurBallRefinementSplitsLongCandidateAtObservedIdleBreak() throws {
    var xs = [Double?](repeating: nil, count: 121)
    xs.replaceSubrange(0..<10, with: [0, 20, 40, 60, 80, 100, 120, 100, 80, 60])
    xs.replaceSubrange(60..<70, with: [0, 20, 40, 60, 80, 100, 120, 100, 80, 60])
    for frame in stride(from: 14, to: 60, by: 5) { xs[frame] = 100 }
    for frame in stride(from: 74, to: 121, by: 5) { xs[frame] = 100 }
    let rallies = try BlurBallVisibilityRallies.detect(
      points(xs), fps: fps, calibration: fullFrameCalibration(), motionConfig: motion)
    XCTAssertEqual(rallies.map { [$0.startTime, $0.endTime] }, [[0, 0.9], [5.9, 6.9]])
  }

  func testRealTrajectoryBoundariesMatchPythonReference() throws {
    let repository = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let fixtureURL = repository.appendingPathComponent(
      "worker/tests/fixtures/visibility-stability-c51.json.gz")
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
    process.arguments = ["-dc", fixtureURL.path]
    process.standardOutput = output
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let fixture = try decoder.decode(StabilityFixture.self, from: data)
    let points = fixture.trajectory.map {
      TrajectoryPoint(
        frame: Int($0[0]), time: $0[1], x: $0[3], y: $0[4],
        confidence: $0.count > 6 ? $0[6] : 0, visible: $0[2] == 1)
    }
    for value in fixture.calibrations.dropFirst().prefix(2) {
      let ordered = ["top_left", "top_right", "bottom_right", "bottom_left"].map {
        Point(value.points[$0]![0], value.points[$0]![1])
      }
      let calibration = Calibration(
        width: value.videoWidth, height: value.videoHeight, points: ordered)
      let roi = try AnalysisROI(calibration: calibration).stabilizedForVisibility(
        sourceWidth: value.videoWidth, sourceHeight: value.videoHeight)
      let rallies = try BlurBallVisibilityRallies.detect(
        points, fps: fixture.fps, calibration: calibration,
        motionConfig: VisibilityMotionConfig(
          analysisWidthPixels: Double(roi.width), analysisHeightPixels: Double(roi.height)))
      XCTAssertEqual(rallies.count, fixture.expected.count)
      for (rally, expected) in zip(rallies, fixture.expected) {
        XCTAssertEqual(rally.startTime, expected[0]!, accuracy: 1e-9)
        XCTAssertEqual(rally.endTime, expected[1]!, accuracy: 1e-9)
        if let expectedLeadIn = expected[2] {
          XCTAssertEqual(rally.leadInStartTime!, expectedLeadIn, accuracy: 1e-9)
        }
      }
    }
  }
}

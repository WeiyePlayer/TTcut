import XCTest

@testable import TTcutCore

final class SourceTimeRalliesTests: XCTestCase {
  let config = VisibilityMotionConfig(analysisWidthPixels: 200, analysisHeightPixels: 100)
  let calibration = Calibration(
    width: 200, height: 100, points: [Point(0, 0), Point(199, 0), Point(199, 99), Point(0, 99)])
  func observations(_ fps: Double, seconds: Double = 6) -> [TrajectoryPoint] {
    (0..<Int(seconds * fps)).map { frame in
      let time = Double(frame) / fps
      let held = time >= 2 && time < 4
      return TrajectoryPoint(
        frame: frame, time: time, x: held ? 100 : 100 + 80 * sin(time * .pi * 2), y: 40,
        confidence: 1, visible: true)
    }
  }

  func testClockRetainsNativeLowCadenceAndSourceObservations() throws {
    for fps in [12.0, 15, 24, 30, 60, 120] {
      var points = observations(fps)
      points[0].visible = false
      let clock = try SourceTimeRallies.clock(points)
      XCTAssertEqual(clock.hz, min(30, fps), accuracy: 0.000001)
      if fps <= 30 { XCTAssertEqual(clock.source, points) }
      XCTAssertFalse(clock.points[0].visible)
      XCTAssertEqual(clock.points.map(\.frame), Array(clock.points.indices))
      XCTAssertEqual(clock.points.map(\.time), clock.source.map(\.time))
      XCTAssertTrue(clock.source.allSatisfy { points.contains($0) })
    }
    let rounded = observations(30).map { point in
      var copy = point
      copy.time = (point.time * 1000).rounded() / 1000
      return copy
    }
    XCTAssertEqual(try SourceTimeRallies.clock(rounded).source, rounded)
    let dropped = observations(120).map { point in
      var copy = point
      if point.time >= 1 && point.time < 2 { copy.visible = false }
      return copy
    }
    let selected = try SourceTimeRallies.clock(dropped).points
    XCTAssertFalse(selected.filter { $0.time >= 1 && $0.time < 2 }.contains(where: \.visible))
  }

  func testInvalidTimesFailInsteadOfProducingSuccessfulEmptyResults() {
    for time in [Double.nan, .infinity, -1, 0] {
      XCTAssertThrowsError(
        try SourceTimeRallies.clock([
          TrajectoryPoint(frame: 0, time: 0), TrajectoryPoint(frame: 1, time: time),
        ]))
    }
    XCTAssertThrowsError(
      try SourceTimeRallies.clock([
        TrajectoryPoint(frame: 0, time: 0), TrajectoryPoint(frame: 0, time: 1),
      ]))
  }

  func testHighFrameRateDecisionsKeepOriginalFramesAndSplitHeldBall() throws {
    var reference: [VisibilityRally] = []
    for fps in [30.0, 60, 120] {
      let points = observations(fps)
      let result = try SourceTimeRallies.detect(
        points, calibration: calibration, motionConfig: config)
      XCTAssertEqual(result.rallies.count, 2, "fps=\(fps): \(result.rallies)")
      XCTAssertEqual(result.pauses.count, 1)
      XCTAssertTrue(result.pauses.contains { $0.start < 3 && $0.end > 3 })
      XCTAssertTrue(
        result.rallies.allSatisfy { rally in
          points[rally.startFrame].time == rally.startTime
            && points[rally.endFrame].time == rally.endTime
            && !result.pauses.contains { rally.startTime < $0.end && rally.endTime >= $0.start }
        })
      // This trajectory has no landing; continuous visibility must still keep the rallies.
      XCTAssertEqual(result.bounceTimes, [])
      if fps == 30 { reference = result.rallies }
      for (rally, baseline) in zip(result.rallies, reference) {
        XCTAssertEqual(rally.startTime, baseline.startTime, accuracy: 1 / 30)
        XCTAssertEqual(rally.endTime, baseline.endTime, accuracy: 1 / 30)
      }
    }
  }

  func testPauseNeedsObservedSupportAndNeverCutsAFlightOrEndOnView() throws {
    let staticPoints = observations(30, seconds: 2).map { point in
      var copy = point
      copy.x = 100
      return copy
    }
    XCTAssertEqual(SourceTimeRallies.observedPauses(staticPoints, config: config).count, 1)
    let missing = staticPoints.map { point in
      var copy = point
      copy.visible = point.frame.isMultiple(of: 6)
      return copy
    }
    XCTAssertEqual(SourceTimeRallies.observedPauses(missing, config: config), [])
    let briefDropouts = staticPoints.map { point in
      var copy = point
      copy.visible = !point.frame.isMultiple(of: 10)
      return copy
    }
    XCTAssertEqual(SourceTimeRallies.observedPauses(briefDropouts, config: config).count, 1)
    XCTAssertEqual(
      SourceTimeRallies.observedPauses(observations(30, seconds: 2), config: config), [])
    var endOn = config
    endOn.verticalExchangeEnabled = true
    XCTAssertEqual(SourceTimeRallies.observedPauses(staticPoints, config: endOn), [])
    let vertical = staticPoints.map { point in
      var copy = point
      copy.y = 50 + 40 * sin(point.time * .pi * 4)
      return copy
    }
    XCTAssertEqual(SourceTimeRallies.observedPauses(vertical, config: config), [])
  }

  func testPR115RealCachedTrajectoryPreservesReviewedMotionAndRemovesHeldPauses() throws {
    // Windows DirectML detections from the supplied 30 fps conversion, NOT a new
    // Core ML inference or validation of the unavailable original 120 fps video.
    let url = Bundle.module.url(
      forResource: "pr115-source-time", withExtension: "json", subdirectory: "Fixtures")!
    let fixture = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let rows = fixture["trajectory"] as! [[Double]]
    let points = rows.map {
      TrajectoryPoint(
        frame: Int($0[0]), time: $0[1], x: $0[3], y: $0[4], confidence: $0[5], visible: $0[2] == 1)
    }
    let value = fixture["calibration"] as! [String: Any]
    let corners = value["points"] as! [String: [Double]]
    let calibration = Calibration(
      width: value["video_width"] as! Int, height: value["video_height"] as! Int,
      points: ["top_left", "top_right", "bottom_right", "bottom_left"].map {
        Point(corners[$0]![0], corners[$0]![1])
      })
    let motion = fixture["motion_config"] as! [String: Any]
    let config = VisibilityMotionConfig(
      analysisWidthPixels: motion["analysis_width_pixels"] as! Double,
      analysisHeightPixels: motion["analysis_height_pixels"] as! Double)
    let result = try SourceTimeRallies.detect(
      points, calibration: calibration, motionConfig: config)
    for time in fixture["reviewed_pause_times"] as! [Double] {
      XCTAssertTrue(
        result.pauses.contains { $0.start <= time && time < $0.end }, "Missing pause \(time)")
      XCTAssertFalse(result.rallies.contains { $0.startTime <= time && time <= $0.endTime })
    }
    for core in fixture["reviewed_motion_cores"] as! [[Double]] {
      XCTAssertTrue(
        result.rallies.contains { $0.startTime <= core[0] && $0.endTime >= core[1] },
        "Missing motion \(core): \(result.rallies)")
    }
    XCTAssertTrue(
      result.bounceTimes.allSatisfy { time in
        !result.pauses.contains { $0.start <= time && time < $0.end }
      })
  }
}

import XCTest

@testable import TTcutCore

final class ParityTests: XCTestCase {
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
}

import XCTest

@testable import TTcutMedia

final class MediaProbeTests: XCTestCase {
  func testFrameSamplingIsBoundedAcrossTheVideo() {
    let intervals = MediaProbe.frameSampleIntervals(duration: 1_200).split(separator: ",")

    XCTAssertEqual(intervals.count, 5)
    XCTAssertEqual(intervals.first, "0.000000%+#8")
    XCTAssertEqual(intervals.last, "1140.000000%+#8")
    XCTAssertTrue(intervals.allSatisfy { $0.hasSuffix("%+#8") })
  }
}

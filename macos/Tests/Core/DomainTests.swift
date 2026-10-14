import XCTest

@testable import TTcutCore

final class DomainTests: XCTestCase {
  func testDynamicHDRDoesNotPreventVideoAnalysisValidation() throws {
    var video = VideoInfo(path: "/tmp/hdr.mp4")
    video.width = 320
    video.height = 180
    video.duration = 2
    video.fps = 12
    for kind in [HDRKind.sdr, .hdr10, .hlg, .dolbyVision, .hdr10Plus] {
      video.hdr = kind
      XCTAssertNoThrow(try video.validate(), kind.rawValue)
      if kind == .dolbyVision || kind == .hdr10Plus {
        XCTAssertThrowsError(try video.validateHDRExport()) {
          XCTAssertEqual(($0 as? TTError)?.code, "DYNAMIC_HDR_UNSUPPORTED")
        }
      } else {
        XCTAssertNoThrow(try video.validateHDRExport())
      }
    }
    video.width = 0
    XCTAssertThrowsError(try video.validate()) {
      XCTAssertEqual(($0 as? TTError)?.code, "INVALID_VIDEO")
    }
  }

  func testRefinementClampsAndUnionsAndEmptyStaysEmpty() {
    XCTAssertEqual(Segments.refinement([], duration: 10), [])
    let rallies = [
      Rally(index: 1, start: 0.2, end: 2, bounceCount: 2),
      Rally(index: 2, start: 3, end: 9.5, bounceCount: 2),
    ]
    XCTAssertEqual(Segments.refinement(rallies, duration: 10), [CutRange(0, 10)])
  }

  func testCalibrationRejectsWrongOrdering() {
    let good = Calibration(
      width: 1000, height: 800,
      points: [Point(200, 100), Point(800, 100), Point(900, 650), Point(100, 650)])
    XCTAssertNoThrow(try good.validate())
    var bad = good
    bad.points.swapAt(1, 2)
    XCTAssertThrowsError(try bad.validate())
  }

  func testCopyRequiresAudioAndVideoBoundaries() {
    var video = VideoInfo()
    video.keyframes = [0, 1, 2]
    video.audioCodec = "aac"
    XCTAssertFalse(Segments.canCopy([CutRange(0, 2)], video: video))
    video.audioBoundaries = [0, 2]
    XCTAssertTrue(Segments.canCopy([CutRange(0, 2)], video: video))
    video.variableFrameRate = true
    XCTAssertFalse(Segments.canCopy([CutRange(0, 2)], video: video))
  }
}

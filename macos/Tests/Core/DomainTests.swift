import XCTest

@testable import TTcutCore

final class DomainTests: XCTestCase {
  func testFiveSecondGroupingBoundaryAndTail() {
    let a = Rally(id: "a", index: 1, start: 10, end: 12, bounceCount: 4)
    let b = Rally(id: "b", index: 2, start: 17, end: 19, bounceCount: 6)
    XCTAssertEqual(
      Segments.groups([b, a], pre: 0, post: 0, duration: 40),
      [CutRange(10, 13, clipIDs: ["a"]), CutRange(17, 20, clipIDs: ["b"])])
    var touching = b
    touching.start = 16.999
    XCTAssertEqual(
      Segments.groups([a, touching], pre: 0, post: 0, duration: 40),
      [CutRange(10, 20, clipIDs: ["a", "b"])])
  }
  func testExpandedRangesUnionAndClipAtEnd() {
    let rallies = [
      Rally(id: "a", index: 1, start: 1, end: 4, bounceCount: 3),
      Rally(id: "b", index: 2, start: 9, end: 11, bounceCount: 7),
    ]
    XCTAssertEqual(
      Segments.groups(rallies, pre: 2.5, post: 2, duration: 12),
      [CutRange(0, 12, clipIDs: ["a", "b"])])
    XCTAssertEqual(try Segments.selected(rallies, mode: .highlight, threshold: 3).map(\.id), ["b"])
  }
  func testManualBounceCountIsHalfOpenAndCannotOverlapDeselectedClip() {
    let existing = CustomClip(
      id: "a", sourceRallyID: "a", index: 1, bounceCount: 3, start: 2, end: 4)
    var deselected = existing
    deselected.selected = false
    XCTAssertNil(Clips.addManual([deselected], at: 3, duration: 10, bounceTimes: []))
    let added = Clips.addManual(
      [], at: 1, duration: 10, bounceTimes: [0.9, 1, 1.5, 2], id: "manual")!
    XCTAssertEqual(added[0].bounceCount, 2)
    XCTAssertEqual(added[0].end, 2)
  }
  func testCustomValidationRejectsOverlapDuplicateAndSubframe() {
    let rally = Rally(id: "r", index: 1, start: 1, end: 3, bounceCount: 3)
    let a = CustomClip(id: "a", sourceRallyID: "r", index: 1, bounceCount: 3, start: 1, end: 3)
    let b = CustomClip(id: "b", sourceRallyID: nil, index: 2, bounceCount: 1, start: 2.5, end: 4)
    XCTAssertThrowsError(try Clips.validate([a, b], rallies: [rally], duration: 10, fps: 30))
    var tiny = b
    tiny.start = 5
    tiny.end = 5.01
    XCTAssertThrowsError(try Clips.validate([tiny], rallies: [], duration: 10, fps: 30))
    var adjacent = b
    adjacent.start = 3
    XCTAssertEqual(
      try Clips.validate([a, adjacent], rallies: [rally], duration: 10, fps: 30).count, 2)
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

import XCTest

@testable import TTcutCore

final class TableAggregationTests: XCTestCase {
  func testGeometricConsensusRejectsStrongerInconsistentCornerPeaks() throws {
    let expected = [
      Point(250, 120), Point(390, 130), Point(520, 360), Point(120, 340),
    ]
    let transform = try Homography(
      from: TableAggregation.semanticCornerIndices.map { TableAggregation.tableKeypoints[$0] },
      to: expected)
    let projected = Dictionary(uniqueKeysWithValues: TableAggregation.planarKeypointIndices.map {
      ($0, transform.apply(TableAggregation.tableKeypoints[$0]))
    })
    let distractors = [
      4: Point(40, 50), 5: Point(600, 55), 1: Point(560, 330), 0: Point(80, 350),
    ]
    let samples = (1...11).map { sampleIndex -> TableCandidateSample in
      var candidates = [[TablePeakCandidate]](repeating: [], count: 13)
      for pointIndex in TableAggregation.planarKeypointIndices {
        candidates[pointIndex] = [
          TablePeakCandidate(point: projected[pointIndex]!, activation: 0.7)
        ]
        if let distractor = distractors[pointIndex] {
          candidates[pointIndex].insert(
            TablePeakCandidate(point: distractor, activation: 1.1), at: 0)
        }
      }
      return TableCandidateSample(
        label: String(format: "sample_%02d", sampleIndex), candidates: candidates)
    }

    let result = try TableAggregation.calibration(samples, width: 640, height: 480)

    XCTAssertEqual(result.semanticSupport, 11)
    XCTAssertGreaterThanOrEqual(result.score, 5.5)
    XCTAssertEqual(result.cornerCandidateCounts, [2, 2, 2, 2])
    for (actual, reference) in zip(result.calibration.points, expected) {
      XCTAssertEqual(actual.x, reference.x, accuracy: 1e-6)
      XCTAssertEqual(actual.y, reference.y, accuracy: 1e-6)
    }
  }

  func testGeometricConsensusRequiresElevenSamplesAndTenSemanticPoints() throws {
    let empty = TableCandidateSample(
      label: "sample_01", candidates: [[TablePeakCandidate]](repeating: [], count: 13))
    XCTAssertThrowsError(try TableAggregation.calibration(Array(repeating: empty, count: 10), width: 640, height: 480))
    XCTAssertThrowsError(try TableAggregation.calibration(Array(repeating: empty, count: 11), width: 640, height: 480))
  }

  func testGeometricConsensusRequiresFixedSampleOrder() {
    let samples = (1...11).map { sampleIndex in
      TableCandidateSample(
        label: String(format: "sample_%02d", sampleIndex),
        candidates: [[TablePeakCandidate]](repeating: [], count: 13))
    }
    var reordered = samples
    reordered.swapAt(0, 1)

    XCTAssertThrowsError(
      try TableAggregation.calibration(reordered, width: 640, height: 480))
  }
}

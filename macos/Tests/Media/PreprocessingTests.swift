import TTNative
import XCTest

final class PreprocessingTests: XCTestCase {
  struct Fixture: Decodable {
    var blur: [Float]
    var tableIndices: [Int]
    var tableValues: [Float]
    var heatmap: [Float]
    var detections: [[Double]]
  }
  func testOriginalPythonPreprocessingAndHeatmapDecoding() throws {
    let url = Bundle.module.url(
      forResource: "preprocessing", withExtension: "json", subdirectory: "Fixtures")!
    let expected = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    let bytes: [UInt8] = (0..<(64 * 48 * 3)).map { index in
      let x = index / 3 % 64
      let y = index / 192
      let channel = index % 3
      return UInt8((x * 17 + y * 29 + channel * 71) % 256)
    }
    bytes.withUnsafeBufferPointer { pixels in
      var frame = TTFrame(
        bytes: pixels.baseAddress, width: 64, height: 48, stride: 192, index: 0, time: 0)
      var blur = [Float](repeating: 0, count: 3 * 40 * 24)
      XCTAssertEqual(tt_prepare_blurball(&frame, 3, 4, 57, 40, 40, 24, &blur), 0)
      XCTAssertEqual(blur.count, expected.blur.count)
      XCTAssertLessThanOrEqual(zip(blur, expected.blur).map { abs($0 - $1) }.max()!, 1e-6)
      var table = [Float](repeating: 0, count: 3 * 1600 * 896)
      XCTAssertEqual(tt_prepare_table(&frame, &table), 0)
      for (index, value) in zip(expected.tableIndices, expected.tableValues) {
        XCTAssertEqual(table[index], value, accuracy: 1e-6, "Table input at \(index)")
      }
    }
    var output = [TTDetection](repeating: TTDetection(), count: 16)
    let count = tt_decode_heatmap(expected.heatmap, 40, 24, 0.5, 3, 4, 57, 40, &output, 16)
    XCTAssertEqual(Int(count), expected.detections.count)
    for (actual, reference) in zip(output.prefix(Int(max(0, count))), expected.detections) {
      XCTAssertEqual(actual.x, reference[0], accuracy: 1e-5)
      XCTAssertEqual(actual.y, reference[1], accuracy: 1e-5)
      XCTAssertEqual(actual.confidence, reference[2], accuracy: 1e-5)
    }
  }
}

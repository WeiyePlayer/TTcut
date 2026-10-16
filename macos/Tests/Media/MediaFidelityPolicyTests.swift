import Foundation
import XCTest
import TTcutCore
@testable import TTcutMedia

final class MediaFidelityPolicyTests: XCTestCase {
  func testSharedWindowsAndMacEncodingPolicy() throws {
    struct Case: Decodable {
      let name: String, codec: String, hdr: HDRKind, depth: Int, chroma: String
      let encoder: String?, error: String?
    }
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: root.appendingPathComponent("tests/fixtures/export-fidelity-policy.json")))
    for test in cases {
      var video = VideoInfo(path: "source.mp4")
      video.videoCodec = test.codec; video.hdr = test.hdr; video.bitDepth = test.depth; video.chroma = test.chroma
      video.variableFrameRate = true
      if let error = test.error {
        XCTAssertThrowsError(try MediaExporter.encoding(video), test.name) {
          XCTAssertEqual(($0 as? TTError)?.code, error, test.name)
        }
      } else {
        let args = try MediaExporter.encoding(video)
        XCTAssertEqual(args[args.firstIndex(of: "-c:v")! + 1], test.encoder, test.name)
        XCTAssertTrue(args.contains("filter"), "VFR encoder time base must preserve timestamps")
        if test.encoder == "libx265" { XCTAssertTrue(args.contains("hvc1"), test.name) }
      }
    }
  }
}

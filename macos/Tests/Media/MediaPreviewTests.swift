import TTcutCore
import XCTest

@testable import TTcutMedia

final class MediaPreviewTests: XCTestCase {
  func testVideoTimelineIgnoresContainerAndAudioTailAndAcceptsFullRange() throws {
    var source = VideoInfo()
    source.duration = 100
    source.videoDuration = 90
    source.videoStart = 10
    var preview = VideoInfo()
    preview.duration = 101
    preview.videoDuration = 90.05
    preview.pixelFormat = "yuvj420p"
    XCTAssertNoThrow(try MediaPreview.validate(source: source, preview: preview))
    preview.videoDuration = 85
    XCTAssertThrowsError(try MediaPreview.validate(source: source, preview: preview))
    preview.videoDuration = 90
    preview.pixelFormat = "yuv420p10le"
    XCTAssertThrowsError(try MediaPreview.validate(source: source, preview: preview))
  }
  func testFrameCountFallbackDoesNotGuessFromContainerDuration() throws {
    var source = VideoInfo()
    source.duration = 100
    source.frameCount = 2700
    source.fps = 30
    var preview = source
    preview.duration = 90
    preview.frameCount = 2699
    XCTAssertNoThrow(try MediaPreview.validate(source: source, preview: preview))
    preview.frameCount = 2400
    XCTAssertThrowsError(try MediaPreview.validate(source: source, preview: preview))
    source.frameCount = nil
    XCTAssertNoThrow(try MediaPreview.validate(source: source, preview: preview))
  }
}

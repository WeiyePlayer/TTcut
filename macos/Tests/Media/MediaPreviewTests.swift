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

  /// Preview proxies and covers use the export tone-map rule: HLG (DV 8.4) keeps scene colour, PQ desaturates.
  func testPreviewAndCoverShareTheExportToneMapPerTransfer() throws {
    let cases: [(String, HDRKind, String, DolbyVisionInfo?, String)] = [
      ("HDR10+", .hdr10Plus, "smpte2084", nil, "tonemap=tonemap=hable:desat=2"),
      ("Dolby Vision 8.1", .dolbyVision, "smpte2084", DolbyVisionInfo(profile: 8, baseLayerPresent: true, signalCompatibilityID: 1), "tonemap=tonemap=hable:desat=2"),
      ("Dolby Vision 8.4", .dolbyVision, "arib-std-b67", DolbyVisionInfo(profile: 8, baseLayerPresent: true, signalCompatibilityID: 4), "tonemap=tonemap=hable:desat=0"),
      ("HLG", .hlg, "arib-std-b67", nil, "tonemap=tonemap=hable:desat=0"),
    ]
    for (name, hdr, transfer, dolbyVision, expected) in cases {
      var video = VideoInfo(path: "source.mp4")
      video.hdr = hdr
      video.colorTransfer = transfer
      video.dolbyVision = dolbyVision
      let tonemaps = { (filter: String) in filter.split(separator: ",").map(String.init).filter { $0.hasPrefix("tonemap=") } }
      XCTAssertEqual(tonemaps(MediaPreview.toneFilter(video)), [expected], "\(name) preview")
      XCTAssertEqual(tonemaps(MediaExporter.coverToneFilter(video)), [expected], "\(name) cover")
    }
    var sdr = VideoInfo(path: "source.mp4")
    sdr.hdr = .sdr
    XCTAssertEqual(MediaPreview.toneFilter(sdr), "")
    XCTAssertEqual(MediaExporter.coverToneFilter(sdr), "")
  }
}

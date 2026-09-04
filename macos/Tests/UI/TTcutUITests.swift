import XCTest

@MainActor final class TTcutUITests: XCTestCase {
  func launch(video: String? = nil, review: Bool = false, analyzing: Bool = false) -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchEnvironment["TTCUT_UI_TEST_ROOT"] =
      NSTemporaryDirectory() + "ttcut-ui-" + UUID().uuidString
    if let video {
      app.launchEnvironment[review ? "TTCUT_UI_TEST_REVIEW_VIDEO" : "TTCUT_UI_TEST_VIDEO"] = video
    }
    if analyzing { app.launchEnvironment["TTCUT_UI_TEST_ANALYZING"] = "1" }
    app.launch()
    return app
  }
  func fixtureVideo() throws -> URL {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let fixtures = root.appendingPathComponent("output/tests")
    let videos = FileManager.default.enumerator(at: fixtures, includingPropertiesForKeys: nil)!
      .allObjects.compactMap { $0 as? URL }.filter { $0.lastPathComponent == "source.mp4" }
    return try XCTUnwrap(videos.first)
  }
  func testReviewCountsSelectionAndTimelineZoom() throws {
    let app = launch(video: try fixtureVideo().path, review: true)
    let highlights = app.descendants(matching: .any).matching(identifier: "精彩回合").firstMatch
    XCTAssertTrue(highlights.waitForExistence(timeout: 20))
    XCTAssertFalse(app.descendants(matching: .any)["videoMonitor"].exists)
    XCTAssertFalse(app.buttons["新建任务"].exists)
    highlights.click()
    XCTAssertTrue(app.staticTexts["符合要求的回合：1 个"].waitForExistence(timeout: 5))
    let threshold = app.popUpButtons["highlightThreshold"]
    threshold.click()
    app.menuItems["7 板"].click()
    XCTAssertTrue(app.staticTexts["符合要求的回合：0 个"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["开始剪辑"].isEnabled)
    threshold.click()
    app.menuItems["3 板"].click()
    XCTAssertTrue(app.staticTexts["符合要求的回合：2 个"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "弹跳")).firstMatch.exists)
    capture(app, "highlight-count")
    app.descendants(matching: .any).matching(identifier: "自定义").firstMatch.click()
    let all = app.buttons["toggleAllRallies"]
    XCTAssertTrue(all.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["3 / 3 回合"].exists)
    all.click()
    XCTAssertTrue(app.staticTexts["0 / 3 回合"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["开始剪辑"].isEnabled)
    all.click()
    XCTAssertTrue(app.staticTexts["3 / 3 回合"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["开始剪辑"].isEnabled)
    let first = app.descendants(matching: .any).matching(identifier: "timeline.clip.ui-0").firstMatch
    XCTAssertTrue(first.waitForExistence(timeout: 5))
    let originalWidth = first.frame.width
    app.buttons["timeline.zoomIn"].click()
    app.buttons["timeline.zoomIn"].click()
    XCTAssertTrue(app.staticTexts["400%"].waitForExistence(timeout: 5))
    XCTAssertGreaterThan(first.frame.width, originalWidth * 3.5)
    first.click()
    XCTAssertTrue(app.textFields["开始"].waitForExistence(timeout: 5))
    let startField = app.textFields["开始"]
    let endField = app.textFields["结束"]
    let start = try XCTUnwrap(Double(startField.value as? String ?? ""))
    let end = try XCTUnwrap(Double(endField.value as? String ?? ""))
    let pixelsPerSecond = first.frame.width / (end - start)
    let handle = app.descendants(matching: .any).matching(identifier: "timeline.start.ui-0").firstMatch
    let origin = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    origin.press(forDuration: 0.1, thenDragTo: origin.withOffset(CGVector(dx: 40, dy: 0)))
    let adjusted = try XCTUnwrap(Double(startField.value as? String ?? ""))
    XCTAssertEqual(adjusted - start, 40 / pixelsPerSecond, accuracy: 0.02)
    capture(app, "timeline-zoomed")
    app.buttons["timeline.fitAll"].click()
    XCTAssertTrue(app.staticTexts["100%"].waitForExistence(timeout: 5))
    XCTAssertEqual(first.frame.width, originalWidth - (adjusted - start) * pixelsPerSecond / 4, accuracy: 2)
    XCTAssertFalse(app.buttons["timeline.zoomOut"].isEnabled)
    capture(app, "custom-selection-and-fit")
  }
  func testAnalysisHasNoExtraPreviewOrFooter() throws {
    let app = launch(video: try fixtureVideo().path, review: true, analyzing: true)
    XCTAssertTrue(app.staticTexts["正在分析"].waitForExistence(timeout: 20))
    XCTAssertFalse(app.descendants(matching: .any)["videoMonitor"].exists)
    XCTAssertFalse(app.buttons["新建任务"].exists)
    XCTAssertFalse(app.staticTexts["macOS · Apple Silicon"].exists)
    capture(app, "analysis-progress-only")
  }
  func capture(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testNavigationAndUnconfiguredUpdates() {
    let app = launch()
    XCTAssertTrue(app.buttons["selectVideos"].waitForExistence(timeout: 10))
    capture(app, "home")
    app.buttons["设置"].click()
    XCTAssertTrue(app.staticTexts["更新尚未配置"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["检查更新"].isEnabled)
    capture(app, "settings")
    app.buttons["历史剪辑"].click()
    XCTAssertTrue(app.staticTexts["还没有历史记录"].waitForExistence(timeout: 5))
    capture(app, "history")
  }
  func testManualCalibrationAndTimeline() throws {
    let video = try fixtureVideo()
    let app = launch(video: video.path)
    let surface = app.descendants(matching: .any)["calibrationSurface"]
    XCTAssertTrue(surface.waitForExistence(timeout: 20))
    for point in [
      CGVector(dx: 0.2, dy: 0.35), CGVector(dx: 0.8, dy: 0.35), CGVector(dx: 0.9, dy: 0.9),
      CGVector(dx: 0.1, dy: 0.9),
    ] { surface.coordinate(withNormalizedOffset: point).click() }
    XCTAssertTrue(app.buttons["开始分析"].isEnabled)
    capture(app, "manual-calibration")
    app.buttons["开始分析"].click()
    let custom = app.descendants(matching: .any).matching(identifier: "自定义").firstMatch
    XCTAssertTrue(custom.waitForExistence(timeout: 60))
    custom.click()
    XCTAssertTrue(app.buttons["增加回合"].waitForExistence(timeout: 10))
    app.buttons["增加回合"].click()
    capture(app, "custom-timeline")
    XCTAssertTrue(app.staticTexts["手动回合"].waitForExistence(timeout: 5))
  }
}

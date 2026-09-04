import XCTest

@MainActor final class TTcutUITests: XCTestCase {
  func launch(video: String? = nil) -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchEnvironment["TTCUT_UI_TEST_ROOT"] =
      NSTemporaryDirectory() + "ttcut-ui-" + UUID().uuidString
    if let video { app.launchEnvironment["TTCUT_UI_TEST_VIDEO"] = video }
    app.launch()
    return app
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
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let fixtures = root.appendingPathComponent("output/tests")
    let videos = FileManager.default.enumerator(at: fixtures, includingPropertiesForKeys: nil)!
      .allObjects.compactMap { $0 as? URL }.filter { $0.lastPathComponent == "source.mp4" }
    let video = try XCTUnwrap(videos.first)
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

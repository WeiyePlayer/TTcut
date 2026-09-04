#if DEBUG
  import SwiftUI
  import AppKit
  import TTcutCore
  import TTcutMedia

  /// Rendering-only QA for this app's own views. Does not automate the desktop or replace interaction tests.
  @MainActor enum SnapshotSuite {
    /// Explicit synthetic results for UI interaction tests; never used by a Release build.
    static func prepareReview(state: AppState, video: URL) async throws {
      guard let paths = state.runtime else { throw TTError("NO_RUNTIME") }
      let info = try await MediaProbe(paths: paths).inspect(video)
      let calibration = Calibration(
        width: info.width, height: info.height,
        points: [Point(0, 0), Point(Double(info.width), 0),
          Point(Double(info.width), Double(info.height)), Point(0, Double(info.height))])
      let rallies = [3, 5, 7].enumerated().map { index, count in
        Rally(id: "ui-\(index)", index: index + 1,
          start: info.duration * (Double(index) * 0.3 + 0.05),
          end: info.duration * (Double(index) * 0.3 + 0.15), bounceCount: count)
      }
      state.source = info
      state.calibration = calibration
      state.result = AnalysisResult(
        source: try SourceIdentity(url: video), sourceVideo: info, video: info,
        processing: ProcessingMedia(mode: .originalCFR, path: info.path),
        calibration: calibration, mode: .full, rallies: rallies, bounceTimes: [])
      state.custom = Clips.draft(
        rallies: rallies, pre: 0, post: 0, duration: info.duration, fps: info.fps)
      state.flow = .review
      state.playback.load(video: info, paths: paths)
    }
    static func run(state: AppState, directory: URL, video: URL?) async {
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try await capture(state, "home", in: directory)
        state.page = .settings
        try await capture(state, "settings", in: directory)
        state.settings.language = "en"
        try await capture(state, "settings-en", in: directory)
        state.settings.language = "zh-CN"
        state.page = .history
        try await capture(state, "history-empty", in: directory)
        if let video, let paths = state.runtime {
          let info = try await MediaProbe(paths: paths).inspect(video)
          let image = directory.appendingPathComponent("source-preview.jpg")
          try await MediaExporter(paths: paths).cover(video: info, destination: image)
          state.source = info
          state.previewImage = NSImage(contentsOf: image)
          state.calibration = Calibration(
            width: info.width, height: info.height,
            points: [
              Point(Double(info.width) * 0.2, Double(info.height) * 0.35),
              Point(Double(info.width) * 0.8, Double(info.height) * 0.35),
              Point(Double(info.width) * 0.9, Double(info.height) * 0.9),
              Point(Double(info.width) * 0.1, Double(info.height) * 0.9),
            ])
          state.page = .cut
          state.flow = .calibration
          try await capture(state, "calibration", in: directory)
          let rallies = [
            Rally(id: "fixture-a", index: 1, start: 0.3, end: 1.2, bounceCount: 4),
            Rally(id: "fixture-b", index: 2, start: 2, end: 3, bounceCount: 6),
          ]
          let result = AnalysisResult(
            source: try SourceIdentity(url: video), sourceVideo: info, video: info,
            processing: ProcessingMedia(mode: .originalCFR, path: info.path),
            calibration: state.calibration!, mode: .full, rallies: rallies,
            bounceTimes: [0.3, 0.6, 0.9, 1.2, 2, 2.2, 2.4, 2.6, 2.8, 3])
          state.result = result
          state.custom = Clips.draft(
            rallies: rallies, pre: 0.1, post: 0.1, duration: info.duration, fps: info.fps)
          state.flow = .review
          state.mode = .all
          try await capture(state, "review-all", in: directory)
          state.mode = .highlight
          try await capture(state, "review-highlights", in: directory)
          state.flow = .analyzing
          state.stage = "正在分析"
          state.progress = 0.4
          try await capture(state, "analyzing", in: directory)
          state.flow = .review
          state.mode = .custom
          state.playback.load(video: info, paths: paths)
          try await capture(state, "custom", in: directory)
          state.settings.language = "en"
          try await capture(state, "custom-en", in: directory)
          state.settings.language = "zh-CN"
          try await state.store.save(result, cover: Data(contentsOf: image))
          await state.refreshHistory()
          state.page = .history
          try await capture(state, "history", in: directory)
          state.batch = [
            BatchItem(url: video, status: .manualRequired, error: "自动标定未找到一致球桌，请手动补充。"),
            BatchItem(url: video, status: .done, result: result),
          ]
          state.page = .batch
          try await capture(state, "batch", in: directory)
        }
        try Data("Rendering completed; fixtures are synthetic, not inference claims.\n".utf8).write(
          to: directory.appendingPathComponent("result.txt"))
      } catch {
        try? Data(error.localizedDescription.utf8).write(
          to: directory.appendingPathComponent("error.txt"))
      }
      NSApp.terminate(nil)
    }
    static func capture(_ state: AppState, _ name: String, in folder: URL) async throws {
      let host = NSHostingView(
        rootView: RootView().environmentObject(state).environment(
          \.locale, Locale(identifier: state.settings.language)
        ).environment(\.colorScheme, .light))
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.borderless],
        backing: .buffered, defer: false)
      window.appearance = NSAppearance(named: .aqua)
      window.contentView = host
      window.orderBack(nil)
      host.frame = NSRect(x: 0, y: 0, width: 1280, height: 800)
      try await Task.sleep(nanoseconds: 300_000_000)
      host.layoutSubtreeIfNeeded()
      host.displayIfNeeded()
      guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
        throw TTError("SNAPSHOT_FAILED")
      }
      host.cacheDisplay(in: host.bounds, to: bitmap)
      guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw TTError("SNAPSHOT_FAILED")
      }
      try png.write(to: folder.appendingPathComponent(name + ".png"))
      window.orderOut(nil)
    }
  }
#endif

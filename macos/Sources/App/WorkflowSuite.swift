#if DEBUG
  import AppKit
  import AVFoundation
  import TTcutCore
  import TTcutMedia

  /// In-process application workflow checks. This does not claim mouse/keyboard UI automation.
  @MainActor enum WorkflowSuite {
    static func require(_ condition: Bool, _ message: String) throws {
      if !condition { throw TTError("WORKFLOW_ASSERTION", message) }
    }
    static func settle(_ state: AppState) async throws {
      let deadline = Date().addingTimeInterval(90)
      while state.busy && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
      try require(!state.busy, "Workflow did not finish within the test timeout")
    }
    static func run(state: AppState, directory: URL) async {
      var passed = [String]()
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let paths = state.runtime else { throw TTError("TEST_RUNTIME_MISSING") }
        let source = directory.appendingPathComponent("workflow-source.mp4")
        _ = try await ProcessRunner.run(
          paths.ffmpeg,
          [
            "-v", "error", "-y", "-f", "lavfi", "-i",
            "testsrc2=size=640x360:rate=8:duration=3", "-c:v", "libx264", "-preset", "ultrafast",
            source.path,
          ])
        state.load(directory.appendingPathComponent("missing.mp4"), automatic: false)
        try await settle(state)
        try require(state.flow == .idle && state.message != nil, "Missing source was not reported")
        passed.append("missing input returns to idle with an error")
        state.load(source, automatic: false)
        try await settle(state)
        try require(
          state.flow == .calibration && state.source != nil && state.previewImage != nil,
          "Manual calibration did not receive video and preview")
        passed.append("source load and calibration preview")
        let playbackDeadline = Date().addingTimeInterval(10)
        while state.playback.player.currentItem?.status != .readyToPlay && Date() < playbackDeadline
        {
          try await Task.sleep(nanoseconds: 50_000_000)
        }
        try require(
          state.playback.player.currentItem?.status == .readyToPlay,
          "AVPlayer did not prepare the video")
        state.playback.seek(0.5)
        state.playback.toggle()
        try await Task.sleep(nanoseconds: 400_000_000)
        try require(state.playback.time > 0.6, "Video playback or seek did not advance")
        state.playback.player.pause()
        passed.append("AVPlayer readiness, seek and playback clock")
        let calibration = Calibration(
          width: 640, height: 360,
          points: [Point(100, 120), Point(540, 120), Point(590, 320), Point(50, 320)])
        state.calibration = calibration
        state.analyze()
        try await settle(state)
        try require(
          state.flow == .review && state.result?.modelDigests == AppState.modelDigests,
          "Native analysis did not reach review: \(state.message ?? "")")
        passed.append("native worker analysis to review with model provenance")
        state.mode = .custom
        state.custom = []
        state.addManualClip(at: 0.5)
        try require(
          state.custom.count == 1 && state.custom[0].isManual, "Manual clip was not added")
        state.export(
          outputs: ExportOutputs(combined: false, rallyVideos: true, xml: true), to: directory)
        try await settle(state)
        guard let exported = state.destination else {
          throw TTError("WORKFLOW_NO_OUTPUT", state.message ?? "")
        }
        try require(
          state.flow == .complete
            && FileManager.default.fileExists(
              atPath: exported.appendingPathComponent("TTcut.xml").path),
          "Custom export did not finish")
        await state.refreshHistory()
        try require(state.history.count == 1, "Exported analysis was not visible in history")
        passed.append("manual clip, segmented MP4/XML export and history visibility")
        let entry = state.history[0]
        state.reset()
        state.openHistory(entry)
        try await settle(state)
        try require(
          state.result?.id == entry.id && state.flow == .review,
          "History did not reopen the saved analysis")
        try require(
          !state.custom.contains(where: \.isManual), "Session-only manual draft survived reopening")
        try await state.store.delete(entry.id)
        await state.refreshHistory()
        try require(
          state.history.isEmpty && FileManager.default.fileExists(atPath: source.path)
            && FileManager.default.fileExists(atPath: exported.path),
          "History delete affected originals or exports")
        passed.append("history reuse, fresh draft and non-destructive deletion")
        state.reset()
        state.load(source, automatic: false)
        state.cancel()
        try await settle(state)
        try require(state.result == nil, "Cancelled source load populated an analysis")
        passed.append("cancellation releases busy state without stale results")
        let second = directory.appendingPathComponent("workflow-second.mp4")
        try FileManager.default.copyItem(at: source, to: second)
        state.batch = [
          BatchItem(url: source, calibration: calibration, mode: .analyzeOnly),
          BatchItem(url: second, calibration: calibration, mode: .analyzeOnly),
          BatchItem(url: directory.appendingPathComponent("missing-batch.mp4"), mode: .analyzeOnly),
        ]
        state.page = .batch
        state.runBatch()
        try await settle(state)
        try require(
          state.batch[0].status == .done && state.batch[1].status == .done
            && state.batch[2].status == .failed,
          "Batch failure prevented valid items completing")
        try require(
          state.batch[0].result?.modelDigests == AppState.modelDigests,
          "Batch model provenance missing")
        passed.append("serial batch analysis, isolated failure and provenance")
        // Recover a queued item through the same manual calibration callbacks as the UI.
        state.batch[2].url = second
        state.batch[2].status = .manualRequired
        let recoveryID = state.batch[2].id
        state.manuallyCalibrateBatch(recoveryID)
        try await settle(state)
        state.calibration = calibration
        state.analyze()
        try await settle(state)
        try require(
          state.batch[2].status == .pending && state.batch[2].result != nil
            && state.editingBatchID == nil, "Manual batch recovery did not requeue its analysis")
        state.runBatch()
        try await settle(state)
        try require(
          state.batch.allSatisfy { $0.status == .done }, "Recovered batch did not complete")
        passed.append("manual batch recovery and continuation")
        state.reviewBatch(recoveryID)
        try await settle(state)
        try require(
          state.flow == .review && state.result?.id == state.batch[2].result?.id,
          "Batch result did not open in the editor")
        passed.append("batch review uses the correct processing media")
        try HistoryStore.atomicWrite(
          Report(passed: true, checks: passed, error: nil),
          to: directory.appendingPathComponent("workflow.json"))
      } catch {
        try? HistoryStore.atomicWrite(
          Report(passed: false, checks: passed, error: error.localizedDescription),
          to: directory.appendingPathComponent("workflow.json"))
      }
      state.playback.stop()
      NSApp.terminate(nil)
    }
    struct Report: Codable {
      var passed: Bool
      var checks: [String]
      var error: String?
    }
  }
#endif

import AVKit
import AppKit
import SwiftUI
import TTcutCore
import TTcutMedia

enum Page: String, CaseIterable {
  case cut = "自动剪辑"
  case batch = "批量任务"
  case history = "历史剪辑"
  case settings = "设置"
}
enum Flow { case idle, calibration, analyzing, review, exporting, complete }

@MainActor final class AppState: ObservableObject {
  @Published var page: Page = .cut
  @Published var flow: Flow = .idle
  @Published var source: VideoInfo?
  @Published var previewImage: NSImage?
  @Published var busy = false
  private var originalVideo: VideoInfo?
  private var originalIdentity: SourceIdentity?
  private var processingMedia: ProcessingMedia?
  private var processingLease: UUID?
  private var tableSamples: [TableSample] = []
  @Published var result: AnalysisResult?
  @Published var calibration: Calibration?
  @Published var custom: [CustomClip] = []
  @Published var mode: CutMode = .all
  @Published var highlightThreshold = 5
  @Published var progress = 0.0
  @Published var stage = ""
  @Published var message: String? {
    didSet { if let message { Task { await DiagnosticLog.shared.write("application", message) } } }
  }
  @Published var destination: URL?
  @Published var history: [HistoryEntry] = []
  @Published var settings = Settings()
  @Published var batch: [BatchItem] = []
  @Published var batchDestination: URL?
  var editingBatchID: UUID?
  private(set) var activeTask: Task<Void, Never>?
  private var activityID = UUID()
  let store: HistoryStore
  let playback = PlaybackController()
  let runtime: RuntimePaths?
  static let modelDigests = [
    "BlurBall": "3545206c7155194ea654899d33579c88c9fd8e82c632cbdbae3b0c0ec3f2985f",
    "Table": "160e1a9b2d0236b501dc4a4d38bbfb39315eeef6de5d8c11770452623ff102df",
  ]
  init() {
    #if DEBUG
      if let testRoot = ProcessInfo.processInfo.environment["TTCUT_UI_TEST_ROOT"] {
        store = HistoryStore(root: URL(fileURLWithPath: testRoot))
      } else if Bundle.main.object(forInfoDictionaryKey: "TTcutUpdateTest") as? Bool == true,
        let testRoot = Bundle.main.object(forInfoDictionaryKey: "TTcutUpdateTestRoot") as? String
      {
        store = HistoryStore(root: URL(fileURLWithPath: testRoot))
      } else {
        store = HistoryStore()
      }
    #else
      store = HistoryStore()
    #endif
    runtime = try? RuntimePaths.bundled()
    Task {
      settings = await store.settings()
      await refreshHistory()
      #if DEBUG
        UpdateTestDriver.startIfConfigured()
        if let directory = ProcessInfo.processInfo.environment["TTCUT_RUN_WORKFLOW_TESTS"] {
          await WorkflowSuite.run(state: self, directory: URL(fileURLWithPath: directory))
          return
        }
        if let directory = ProcessInfo.processInfo.environment["TTCUT_RENDER_SNAPSHOTS"] {
          let video = ProcessInfo.processInfo.environment["TTCUT_SNAPSHOT_VIDEO"].map {
            URL(fileURLWithPath: $0)
          }
          await SnapshotSuite.run(
            state: self, directory: URL(fileURLWithPath: directory), video: video)
          return
        }
        if let path = ProcessInfo.processInfo.environment["TTCUT_UI_TEST_VIDEO"] {
          load(URL(fileURLWithPath: path), automatic: false)
        }
      #endif
    }
  }
  var english: Bool { settings.language == "en" }
  func chooseFiles(multiple: Bool = false) -> [URL] {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = multiple
    panel.allowedContentTypes = [.movie, .mpeg4Movie, .quickTimeMovie]
    panel.allowsOtherFileTypes = true
    return panel.runModal() == .OK ? panel.urls : []
  }
  func openVideo() {
    guard !busy else { return }
    let urls = chooseFiles(multiple: true)
    acceptVideos(urls)
  }
  func acceptVideos(_ urls: [URL]) {
    guard !busy else { return }
    let urls = urls.filter(\.isFileURL)
    if urls.count > 1 {
      for url in urls where !batch.contains(where: { $0.url == url }) {
        batch.append(BatchItem(url: url))
      }
      page = .batch
    } else if let url = urls.first {
      load(url)
    }
  }
  func load(_ url: URL, automatic: Bool? = nil) {
    guard !busy else { return }
    guard let runtime else {
      message = "应用内置组件不完整 / Bundled components are missing"
      return
    }
    cancel()
    message = nil
    source = nil
    result = nil
    destination = nil
    calibration = nil
    previewImage = nil
    tableSamples = []
    originalIdentity = nil
    custom = []
    flow = .idle
    busy = true
    activeTask = Task {
      defer { busy = false }
      do {
        try? await store.releaseMedia(processingLease)
        processingLease = nil
        stage = english ? "Reading video" : "正在读取视频"
        let original = try await MediaProbe(paths: runtime).inspect(url)
        originalIdentity = try SourceIdentity(url: url)
        let pair = try await MediaExporter(paths: runtime).processing(
          source: original, normalize: settings.normalizeVFR, store: store)
        source = pair.0
        originalVideo = original
        processingMedia = pair.1
        processingLease = await store.retainMedia(pair.1)
        playback.load(video: pair.0, paths: runtime)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(
          UUID().uuidString + ".jpg")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try await MediaExporter(paths: runtime).cover(video: pair.0, destination: temporary)
        previewImage = NSImage(contentsOf: temporary)
        if let warning = pair.1.warning { message = warning }
        flow = .calibration
        if automatic ?? settings.automaticCalibration {
          await automaticCalibration(original: original, processing: pair.1)
        }
      } catch is CancellationError {} catch {
        message = error.localizedDescription
        flow = .idle
      }
    }
  }
  func request(_ operation: String, video: VideoInfo, calibration: Calibration? = nil)
    -> AnalysisRequest
  {
    var value = AnalysisRequest(
      taskID: UUID().uuidString, operation: operation, video: video,
      modelsDirectory: runtime!.models.path)
    value.calibration = calibration
    value.mode = settings.analysisMode
    return value
  }
  func automaticCalibration(original: VideoInfo? = nil, processing: ProcessingMedia? = nil) async {
    guard let source, let runtime else { return }
    let generation = activityID
    do {
      stage = english ? "Identifying table" : "正在识别球桌"
      progress = 0
      let event = try await AnalysisClient.run(request("calibrate", video: source), paths: runtime)
      { [weak self] event in
        Task { @MainActor in
          guard let self, self.activityID == generation else { return }
          self.stage = self.label(event.stage)
          self.progress = Double(event.current ?? 0) / Double(max(1, event.total ?? 1))
        }
      }
      guard let found = event.calibration else { throw TTError("AUTO_CALIBRATION_FAILED") }
      calibration = found
      tableSamples = event.tableSamples ?? []
    } catch is CancellationError {} catch {
      message =
        (english
          ? "Automatic calibration failed. Adjust four corners manually.\n" : "自动标定失败，请手动调整四角。\n")
        + error.localizedDescription
    }
  }
  func analyze() {
    guard !busy else { return }
    guard let source, let calibration, let runtime else {
      message = english ? "Complete table calibration first." : "请先完成球桌标定"
      return
    }
    do { try calibration.validate() } catch {
      message = error.localizedDescription
      return
    }
    cancel()
    flow = .analyzing
    progress = 0
    message = nil
    busy = true
    let generation = activityID
    activeTask = Task {
      defer { busy = false }
      do {
        let event = try await AnalysisClient.run(
          request("analyze", video: source, calibration: calibration), paths: runtime
        ) { [weak self] event in
          Task { @MainActor in
            guard let self, self.activityID == generation else { return }
            self.stage = self.label(event.stage)
            self.progress = Double(event.current ?? 0) / Double(max(1, event.total ?? 1))
          }
        }
        guard let rallies = event.rallies, let bounceTimes = event.bounceTimes else {
          throw TTError("ANALYSIS_RESULT_INVALID")
        }
        let original = originalVideo ?? source
        let identity = try originalIdentity ?? SourceIdentity(url: original.url)
        guard identity.currentStatus == .available else { throw TTError("SOURCE_CHANGED") }
        let processing =
          processingMedia
          ?? ProcessingMedia(
            mode: source.variableFrameRate ? .originalVFR : .originalCFR, path: source.path)
        let value = AnalysisResult(
          source: identity, sourceVideo: original, video: source, processing: processing,
          calibration: calibration, mode: settings.analysisMode, rallies: rallies,
          bounceTimes: bounceTimes, tableSamples: tableSamples,
          modelDigests: Self.modelDigests, visibleInHistory: !rallies.isEmpty)
        result = value
        custom = Clips.draft(
          rallies: rallies, pre: settings.preRoll, post: settings.postRoll,
          duration: source.duration, fps: source.fps)
        if let id = editingBatchID, let index = batch.firstIndex(where: { $0.id == id }) {
          batch[index].result = value
          batch[index].calibration = calibration
          batch[index].status = .pending
          batch[index].error = nil
          editingBatchID = nil
        }
        try await store.save(value)
        if !rallies.isEmpty {
          do {
            let cover = try await coverData(video: source, runtime: runtime, value: value)
            try await store.save(value, cover: cover)
          } catch is CancellationError { throw CancellationError() } catch {
            message = "分析已保存，封面生成失败：" + error.localizedDescription
          }
        }
        flow = .review
        await refreshHistory()
      } catch is CancellationError { flow = .calibration } catch {
        message = error.localizedDescription
        flow = .calibration
      }
    }
  }
  func coverData(video: VideoInfo, runtime: RuntimePaths, value: AnalysisResult) async throws
    -> Data?
  {
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString + ".jpg")
    defer { try? FileManager.default.removeItem(at: tmp) }
    try await MediaExporter(paths: runtime).cover(video: video, destination: tmp)
    return try? Data(contentsOf: tmp)
  }
  func export(outputs: ExportOutputs, to selectedDirectory: URL? = nil) {
    guard !busy else { return }
    guard let result, let runtime else { return }
    let directory: URL
    if let selectedDirectory {
      directory = selectedDirectory
    } else {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.canCreateDirectories = true
      guard panel.runModal() == .OK, let selected = panel.url else { return }
      directory = selected
    }
    cancel()
    flow = .exporting
    progress = 0
    message = nil
    busy = true
    let generation = activityID
    let request = ExportRequest(
      result: result, mode: mode, threshold: highlightThreshold, settings: settings, clips: custom,
      outputs: outputs, destination: directory)
    activeTask = Task {
      defer { busy = false }
      do {
        let exported = try await MediaExporter(paths: runtime).exportResult(request) {
          [weak self] value in
          Task { @MainActor in if self?.activityID == generation { self?.progress = value } }
        }
        destination = exported.folder
        flow = .complete
        var warnings = exported.warnings
        do { try await store.markExported(id: result.id, path: exported.folder.path) } catch {
          warnings.append("导出文件已保留，历史更新失败：" + error.localizedDescription)
        }
        if !warnings.isEmpty { message = warnings.joined(separator: "\n") }
        await refreshHistory()
      } catch is CancellationError { flow = .review } catch {
        message = error.localizedDescription
        flow = .review
      }
    }
  }
  func addManualClip(at time: Double) {
    if let source, let result,
      let next = Clips.addManual(
        custom, at: time, duration: source.duration, bounceTimes: result.bounceTimes)
    {
      custom = next
    } else {
      message = english ? "No one-second gap is available." : "当前没有可容纳一秒回合的空隙"
    }
  }
  func cancel() {
    activityID = UUID()
    activeTask?.cancel()
    activeTask = nil
  }
  func retryCalibration() {
    guard !busy else { return }
    busy = true
    activeTask = Task {
      defer { busy = false }
      await automaticCalibration()
    }
  }
  func reset() {
    cancel()
    playback.stop()
    source = nil
    result = nil
    calibration = nil
    previewImage = nil
    originalVideo = nil
    originalIdentity = nil
    processingMedia = nil
    let lease = processingLease
    processingLease = nil
    Task { try? await store.releaseMedia(lease) }
    tableSamples = []
    custom = []
    editingBatchID = nil
    flow = .idle
    message = nil
    progress = 0
  }
  func refreshHistory() async {
    do { history = try await store.list() } catch { message = error.localizedDescription }
  }
  func openHistory(_ entry: HistoryEntry) {
    guard !busy else { return }
    busy = true
    Task {
      defer { busy = false }
      do {
        let record = try await store.open(entry.id)
        let oldLease = processingLease
        processingLease = await store.retainMedia(record.processing)
        try? await store.releaseMedia(oldLease)
        source = record.video
        originalVideo = record.sourceVideo
        originalIdentity = record.source
        processingMedia = record.processing
        tableSamples = record.tableSamples
        calibration = record.calibration
        result = record
        custom = Clips.draft(
          rallies: record.rallies, pre: settings.preRoll, post: settings.postRoll,
          duration: record.video.duration, fps: record.video.fps)
        if let runtime { playback.load(video: record.video, paths: runtime) }
        flow = .review
        page = .cut
      } catch { message = error.localizedDescription }
    }
  }
  func deleteHistory(_ id: String) {
    Task {
      do {
        try await store.delete(id)
        await refreshHistory()
      } catch { message = error.localizedDescription }
    }
  }
  func saveSettings() {
    Task {
      do { try await store.saveSettings(settings) } catch { message = error.localizedDescription }
    }
  }
  func addBatch() {
    guard !busy else { return }
    for url in chooseFiles(multiple: true) where !batch.contains(where: { $0.url == url }) {
      batch.append(BatchItem(url: url))
    }
  }
  func runBatch() {
    guard !busy, let runtime else { return }
    if batch.contains(where: { $0.mode != .analyzeOnly && $0.status != .done }),
      batchDestination == nil
    {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.canCreateDirectories = true
      guard panel.runModal() == .OK, let folder = panel.url else { return }
      batchDestination = folder
    }
    cancel()
    let generation = activityID
    busy = true
    activeTask = Task {
      defer {
        busy = false
        let tokens = batch.compactMap(\.lease)
        for i in batch.indices { batch[i].lease = nil }
        Task { for token in tokens { try? await store.releaseMedia(token) } }
      }
      // Complete table calibration for every eligible item before starting analysis/export.
      for index in batch.indices
      where batch[index].status != .done && batch[index].status != .manualRequired {
        if Task.isCancelled { return }
        if let result = batch[index].result, result.source.currentStatus == .available { continue }
        if batch[index].result != nil
          || batch[index].prepared?.identity.currentStatus == .changed
          || batch[index].prepared?.identity.currentStatus == .missing
        {
          batch[index].result = nil
          batch[index].calibration = nil
          batch[index].tableSamples = []
        }
        batch[index].status = .calibrating
        batch[index].error = nil
        do {
          let original = try await MediaProbe(paths: runtime).inspect(batch[index].url)
          let identity = try SourceIdentity(url: original.url)
          let pair = try await MediaExporter(paths: runtime).processing(
            source: original, normalize: settings.normalizeVFR, store: store)
          batch[index].prepared = PreparedBatch(
            source: original, identity: identity, video: pair.0, media: pair.1)
          batch[index].lease = await store.retainMedia(pair.1)
          if batch[index].calibration == nil {
            let event = try await AnalysisClient.run(
              request("calibrate", video: pair.0), paths: runtime
            ) { _ in }
            guard let calibration = event.calibration else {
              throw TTError("AUTO_CALIBRATION_FAILED")
            }
            batch[index].calibration = calibration
            batch[index].tableSamples = event.tableSamples ?? []
          }
          batch[index].status = .pending
        } catch is CancellationError {
          batch[index].status = .pending
          return
        } catch {
          batch[index].status = .manualRequired
          batch[index].error = error.localizedDescription
        }
      }
      for index in batch.indices
      where batch[index].status != .done && batch[index].status != .manualRequired {
        if Task.isCancelled { return }
        batch[index].status = .running
        batch[index].error = nil
        batch[index].progress = 0
        do {
          let value: AnalysisResult
          if let existing = batch[index].result, existing.source.currentStatus == .available {
            value = existing
          } else {
            guard let prepared = batch[index].prepared else {
              throw TTError("BATCH_PREPARATION_MISSING")
            }
            let original = prepared.source
            let identity = prepared.identity
            let source = prepared.video
            let samples = batch[index].tableSamples
            guard identity.currentStatus == .available else { throw TTError("SOURCE_CHANGED") }
            let calibration = batch[index].calibration!
            let id = batch[index].id
            let analysis = try await AnalysisClient.run(
              request("analyze", video: source, calibration: calibration), paths: runtime
            ) { [weak self] event in
              Task { @MainActor in
                if let self, self.activityID == generation,
                  let current = self.batch.firstIndex(where: { $0.id == id })
                {
                  self.batch[current].progress =
                    Double(event.current ?? 0) / Double(max(1, event.total ?? 1))
                }
              }
            }
            guard let rallies = analysis.rallies, let bounces = analysis.bounceTimes else {
              throw TTError("ANALYSIS_RESULT_INVALID")
            }
            guard identity.currentStatus == .available else { throw TTError("SOURCE_CHANGED") }
            value = AnalysisResult(
              source: identity, sourceVideo: original, video: source, processing: prepared.media,
              calibration: calibration, mode: settings.analysisMode, rallies: rallies,
              bounceTimes: bounces, tableSamples: samples,
              modelDigests: Self.modelDigests, visibleInHistory: !rallies.isEmpty)
            try await store.save(value)
            if !rallies.isEmpty {
              let cover = try? await coverData(video: source, runtime: runtime, value: value)
              if let cover { try await store.save(value, cover: cover) }
            }
            batch[index].result = value
          }
          if batch[index].mode != .analyzeOnly, let destination = batchDestination {
            batch[index].status = .exporting
            batch[index].progress = 0
            let export = ExportRequest(
              result: value, mode: batch[index].mode, threshold: batch[index].threshold,
              settings: settings, destination: destination)
            let id = batch[index].id
            let folder = try await MediaExporter(paths: runtime).export(export) {
              [weak self] progress in
              Task { @MainActor in
                if let self, self.activityID == generation,
                  let current = self.batch.firstIndex(where: { $0.id == id })
                {
                  self.batch[current].progress = progress
                }
              }
            }
            batch[index].output = folder
            do { try await store.markExported(id: value.id, path: folder.path) } catch {
              batch[index].error = "导出已保留，历史更新失败：" + error.localizedDescription
            }
          }
          batch[index].status = .done
          batch[index].progress = 1
        } catch is CancellationError {
          batch[index].status = .pending
          return
        } catch {
          batch[index].status = .failed
          batch[index].error = error.localizedDescription
        }
      }
      await refreshHistory()
    }
  }
  func manuallyCalibrateBatch(_ id: UUID) {
    guard !busy, let item = batch.first(where: { $0.id == id }) else { return }
    editingBatchID = id
    page = .cut
    load(item.url, automatic: false)
  }
  func reviewBatch(_ id: UUID) {
    guard !busy, let value = batch.first(where: { $0.id == id })?.result else { return }
    guard value.source.currentStatus == .available,
      FileManager.default.fileExists(atPath: value.video.path)
    else {
      message =
        english ? "Source changed or is missing. Analyze the video again." : "源视频已变化或处理媒体丢失，请重新分析。"
      return
    }
    busy = true
    Task {
      defer { busy = false }
      let oldLease = processingLease
      processingLease = await store.retainMedia(value.processing)
      try? await store.releaseMedia(oldLease)
      source = value.video
      result = value
      calibration = value.calibration
      originalVideo = value.sourceVideo
      originalIdentity = value.source
      processingMedia = value.processing
      tableSamples = value.tableSamples
      if let runtime { playback.load(video: value.video, paths: runtime) }
      custom = Clips.draft(
        rallies: value.rallies, pre: settings.preRoll, post: settings.postRoll,
        duration: value.video.duration, fps: value.video.fps)
      flow = .review
      page = .cut
    }
  }
  func label(_ stage: String?) -> String {
    switch stage {
    case "table_model", "table_inference": return english ? "Identifying table" : "正在识别球桌"
    case "analysis": return english ? "Analyzing video" : "正在分析视频"
    case "refinement": return english ? "Refining rallies" : "正在进行二次分析"
    default: return stage ?? ""
    }
  }
}

enum BatchStatus: String {
  case pending, calibrating, running, exporting, done, failed, manualRequired
}
struct PreparedBatch {
  var source: VideoInfo
  var identity: SourceIdentity
  var video: VideoInfo
  var media: ProcessingMedia
}
struct BatchItem: Identifiable {
  let id = UUID()
  var url: URL
  var status: BatchStatus = .pending
  var result: AnalysisResult?
  var error: String?
  var calibration: Calibration?
  var mode: CutMode = .all
  var threshold = 5
  var progress = 0.0
  var output: URL?
  var prepared: PreparedBatch?
  var tableSamples: [TableSample] = []
  var lease: UUID?
}

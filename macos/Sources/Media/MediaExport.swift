import Foundation
import TTcutCore

public struct ExportRequest: Sendable {
  public var result: AnalysisResult
  public var mode: CutMode
  public var threshold: Int
  public var settings: Settings
  public var clips: [CustomClip]
  public var outputs: ExportOutputs
  public var destination: URL
  public var strategy: ExportStrategy
  public init(
    result: AnalysisResult, mode: CutMode, threshold: Int, settings: Settings,
    clips: [CustomClip] = [], outputs: ExportOutputs = ExportOutputs(), destination: URL,
    strategy: ExportStrategy = .fastSegmented
  ) {
    self.result = result
    self.mode = mode
    self.threshold = threshold
    self.settings = settings
    self.clips = clips
    self.outputs = outputs
    self.destination = destination
    self.strategy = strategy
  }
}
public struct ExportResult: Sendable {
  public var folder: URL
  public var files: [String]
  public var warnings: [String]
}

public struct MediaExporter: Sendable {
  public let paths: RuntimePaths
  public init(paths: RuntimePaths) { self.paths = paths }
  public static func decimal(_ value: Double) -> String {
    String(format: "%.9f", locale: Locale(identifier: "en_US_POSIX"), value)
  }
  public static func pixelFormat(_ video: VideoInfo) throws -> String {
    guard [8, 10].contains(video.bitDepth) else {
      throw TTError("BIT_DEPTH_UNSUPPORTED", "当前封装支持 8/10-bit；不能静默降低输入位深")
    }
    return "yuv\(video.chroma)p" + (video.bitDepth == 10 ? "10le" : "")
  }
  public static func encoding(_ video: VideoInfo) throws -> [String] {
    var args = [
      "-c:v", video.encoder, "-preset", "veryfast", "-crf", "18", "-pix_fmt",
      try pixelFormat(video), "-threads", "2",
    ]
    for (flag, value) in [
      ("-color_range", video.colorRange), ("-color_primaries", video.colorPrimaries),
      ("-color_trc", video.colorTransfer), ("-colorspace", video.colorSpace),
    ] {
      if let value { args += [flag, value] }
    }
    if video.encoder == "libx265" {
      var options = ["pools=2", "frame-threads=2", "log-level=error", "repeat-headers=1"]
      if video.hdr == .hdr10 { options += ["hdr10=1"] }
      if let display = video.masteringDisplay { options += ["master-display=" + display] }
      if let light = video.maxCLL { options += ["max-cll=" + light] }
      for (name, value) in [
        ("colorprim", video.colorPrimaries), ("transfer", video.colorTransfer),
        ("colormatrix", video.colorSpace),
      ] {
        if let value { options += [name + "=" + value] }
      }
      args += ["-x265-params", options.joined(separator: ":"), "-tag:v", "hvc1"]
    }
    if video.hasAudio {
      args += [
        "-c:a", "aac", "-b:a", String(max(128000, video.audioBitrate)), "-ar",
        String(video.audioSampleRate), "-ac", String(video.audioChannels),
      ]
    }
    args += [
      "-map_metadata", "0", "-metadata:s:v:0", "rotate=0", "-movflags", "+faststart+write_colr",
      "-fps_mode", video.variableFrameRate ? "vfr" : "cfr",
    ]
    if !video.variableFrameRate { args += ["-r", video.frameRate] }
    return args
  }
  private func run(
    _ args: [String], duration: Double, progress: @escaping @Sendable (Double) -> Void
  ) async throws {
    _ = try await ProcessRunner.run(
      paths.ffmpeg,
      ["-hide_banner", "-nostdin", "-v", "error", "-y", "-progress", "pipe:1", "-nostats"] + args,
      onLine: { line in
        if line.hasPrefix("out_time_us="), let value = Double(line.dropFirst(12)) {
          progress(min(1, max(0, value / 1_000_000 / max(0.001, duration))))
        }
      })
  }
  /// Timestamp normalization uses a common video origin for both streams; resampling fills missing audio with silence.
  func filter(video: VideoInfo, ranges: [CutRange], normalizeFPS: Bool = false) -> (
    String, [String]
  ) {
    let origin = Self.decimal(video.videoStart)
    var parts = [String]()
    var names = [String]()
    if ranges.count > 1 {
      parts.append(
        "[0:v:0]setpts=PTS-\(origin)/TB,split=\(ranges.count)"
          + ranges.indices.map { "[vs\($0)]" }.joined())
      if video.hasAudio {
        parts.append(
          "[0:a:0]asetpts=PTS-\(origin)/TB,asplit=\(ranges.count)"
            + ranges.indices.map { "[as\($0)]" }.joined())
      }
    }
    for (i, range) in ranges.enumerated() {
      let start = Self.decimal(range.start)
      let end = Self.decimal(range.end)
      let duration = Self.decimal(range.duration)
      let vinput = ranges.count > 1 ? "[vs\(i)]" : "[0:v:0]setpts=PTS-\(origin)/TB,"
      let ainput = ranges.count > 1 ? "[as\(i)]" : "[0:a:0]asetpts=PTS-\(origin)/TB,"
      let fps = normalizeFPS ? ",fps=\(video.frameRate)" : ""
      parts.append(
        vinput + "trim=start=\(start):end=\(end),setpts=PTS-STARTPTS:strip_fps=1\(fps)[v\(i)]")
      if video.hasAudio {
        parts.append(
          ainput
            + "atrim=start=\(start):end=\(end),asetpts=PTS-\(start)/TB,aresample=async=1:first_pts=0,apad,atrim=duration=\(duration)[a\(i)]"
        )
      }
      names += ["[v\(i)]"] + (video.hasAudio ? ["[a\(i)]"] : [])
    }
    if ranges.count > 1 {
      parts.append(
        names.joined() + "concat=n=\(ranges.count):v=1:a=\(video.hasAudio ? 1:0)[vout]"
          + (video.hasAudio ? "[aout]" : ""))
      return (
        parts.joined(separator: ";"),
        ["-map", "[vout]"] + (video.hasAudio ? ["-map", "[aout]"] : [])
      )
    }
    return (
      parts.joined(separator: ";"), ["-map", "[v0]"] + (video.hasAudio ? ["-map", "[a0]"] : [])
    )
  }
  public func encode(
    video: VideoInfo, ranges: [CutRange], destination: URL, normalizeFPS: Bool = false,
    disableBFrames: Bool = false,
    progress: @escaping @Sendable (Double) -> Void = { _ in }
  ) async throws {
    guard !ranges.isEmpty,
      ranges.allSatisfy({
        $0.start.isFinite && $0.end.isFinite && $0.start >= 0 && $0.end > $0.start
          && $0.end <= video.duration + 1e-6
      })
    else { throw TTError("INVALID_EXPORT_RANGES") }
    try video.validate()
    let (graph, maps) = filter(video: video, ranges: ranges, normalizeFPS: normalizeFPS)
    // x265's reorder delay can produce an invalid DTS when fewer than five frames are flushed.
    // Keep the same choice for every independently encoded segment in a concatenated output.
    let shortHEVC =
      video.encoder == "libx265"
      && (disableBFrames || ranges.reduce(0) { $0 + $1.duration } * video.fps < 5)
    let args =
      ["-copyts", "-i", video.path, "-filter_complex_threads", "2", "-filter_complex", graph] + maps
      + (try Self.encoding(video)) + (shortHEVC ? ["-bf", "0"] : []) + [destination.path]
    try await run(args, duration: ranges.reduce(0) { $0 + $1.duration }, progress: progress)
  }
  public func validate(_ url: URL, source: VideoInfo, duration: Double, segments: Int) async throws
    -> VideoInfo
  {
    let info = try await MediaProbe(paths: paths).inspect(url)
    let tolerance = Segments.durationTolerance(segments: segments, video: source)
    guard info.width == source.width, info.height == source.height,
      info.bitDepth == source.bitDepth,
      info.chroma == source.chroma, info.videoCodec == source.outputCodec, info.hdr == source.hdr,
      abs(info.duration - duration) <= tolerance
    else { throw TTError("EXPORT_VALIDATION_FAILED", "导出尺寸、位深、编码或时长不符合源视频约束") }
    func displaySAR(_ video: VideoInfo) -> Double {
      let sar = VideoInfo.ratio(video.sar)
      return video.rotation % 180 == 0 ? sar : (sar > 0 ? 1 / sar : 0)
    }
    if displaySAR(source) > 0, abs(displaySAR(source) - displaySAR(info)) > 0.0001 {
      throw TTError("EXPORT_SAR_MISMATCH")
    }
    for (expected, actual) in [
      (source.colorPrimaries, info.colorPrimaries), (source.colorTransfer, info.colorTransfer),
      (source.colorSpace, info.colorSpace), (source.colorRange, info.colorRange),
      (source.masteringDisplay, info.masteringDisplay), (source.maxCLL, info.maxCLL),
    ] {
      if let expected, expected != actual {
        throw TTError("EXPORT_COLOR_METADATA_LOST", "\(expected) → \(actual ?? "missing")")
      }
    }
    guard source.hasAudio == info.hasAudio,
      !source.hasAudio
        || (source.audioChannels == info.audioChannels
          && source.audioSampleRate == info.audioSampleRate)
    else { throw TTError("EXPORT_AUDIO_MISMATCH") }
    if source.hasAudio {
      guard let audioDuration = info.audioDuration, let videoDuration = info.videoDuration,
        abs((info.audioStart + audioDuration) - (info.videoStart + videoDuration))
          <= min(0.1, tolerance),
        abs(info.audioStart - info.videoStart) <= min(0.1, tolerance)
      else { throw TTError("EXPORT_AV_SYNC_FAILED") }
    }
    return info
  }
  public func merged(
    video: VideoInfo, ranges: [CutRange], destination: URL, strategy: ExportStrategy,
    progress: @escaping @Sendable (Double) -> Void = { _ in }
  ) async throws {
    let duration = ranges.reduce(0) { $0 + $1.duration }
    let probe = MediaProbe(paths: paths)
    // Copy is an optimization with validation, not a replacement for either clipping strategy.
    if strategy == .fastSegmented, ranges.count == 1 {
      let boundaries = try await probe.withBoundaries(video, ranges: ranges)
      if Segments.canCopy(ranges, video: boundaries), video.videoCodec == video.outputCodec {
        do {
          try await run(
            [
              "-ss", Self.decimal(ranges[0].start), "-i", video.path, "-t", Self.decimal(duration),
              "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-avoid_negative_ts", "make_zero",
              "-movflags", "+faststart+write_colr", destination.path,
            ], duration: duration, progress: progress)
          _ = try await validate(destination, source: video, duration: duration, segments: 1)
          return
        } catch is CancellationError { throw CancellationError() } catch {
          try? FileManager.default.removeItem(at: destination)
        }
      }
    }
    if strategy == .compatible || ranges.count == 1 {
      try await encode(video: video, ranges: ranges, destination: destination, progress: progress)
    } else {
      let work = destination.deletingLastPathComponent().appendingPathComponent(
        ".segments-" + UUID().uuidString, isDirectory: true)
      try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: work) }
      var lines = [String]()
      let shortSegment = ranges.contains { $0.duration * video.fps < 5 }
      for (index, range) in ranges.enumerated() {
        try Task.checkCancellation()
        let segment = work.appendingPathComponent("\(index).mp4")
        try await encode(
          video: video, ranges: [range], destination: segment, disableBFrames: shortSegment
        ) { part in
          progress((Double(index) + part) / Double(ranges.count + 1))
        }
        _ = try await validate(segment, source: video, duration: range.duration, segments: 1)
        lines.append("file '\(index).mp4'")
      }
      let list = work.appendingPathComponent("segments.txt")
      try lines.joined(separator: "\n").write(to: list, atomically: true, encoding: .utf8)
      try await run(
        [
          "-f", "concat", "-safe", "1", "-i", list.path, "-map", "0:v:0", "-map", "0:a:0?", "-c",
          "copy", "-movflags", "+faststart+write_colr", destination.path,
        ], duration: duration
      ) { part in progress((Double(ranges.count) + part) / Double(ranges.count + 1)) }
    }
    _ = try await validate(destination, source: video, duration: duration, segments: ranges.count)
  }
  public func export(
    _ request: ExportRequest, progress: @escaping @Sendable (Double) -> Void = { _ in }
  ) async throws -> URL {
    try await exportResult(request, progress: progress).folder
  }
  public func exportResult(
    _ request: ExportRequest, progress: @escaping @Sendable (Double) -> Void = { _ in }
  ) async throws -> ExportResult {
    guard request.result.source.currentStatus == .available else {
      throw TTError("SOURCE_CHANGED_OR_MISSING")
    }
    try request.outputs.validate(custom: request.mode == .custom)
    let video = request.result.video
    let selectedClips: [CustomClip]
    let ranges: [CutRange]
    if request.mode == .custom {
      selectedClips = try Clips.validate(
        request.clips, rallies: request.result.rallies, duration: video.duration, fps: video.fps
      ).filter(\.selected)
      ranges = selectedClips.map(\.range)
    } else {
      selectedClips = []
      let rallies = try Segments.selected(
        request.result.rallies, mode: request.mode, threshold: request.threshold)
      ranges = Segments.groups(
        rallies, pre: request.settings.preRoll, post: request.settings.postRoll,
        duration: video.duration)
    }
    guard !ranges.isEmpty else { throw TTError("NO_SELECTED_CLIPS") }
    try FileManager.default.createDirectory(
      at: request.destination, withIntermediateDirectories: true)
    let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
    let name =
      video.url.deletingPathExtension().lastPathComponent + "_TTcut_" + stamp + "_"
      + UUID().uuidString.prefix(6)
    let work = request.destination.appendingPathComponent(
      "." + name + ".partial", isDirectory: true)
    let final = request.destination.appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: work) }
    var files: [String] = []
    var warnings: [String] = []
    if request.outputs.combined {
      try await merged(
        video: video, ranges: ranges, destination: work.appendingPathComponent("TTcut.mp4"),
        strategy: request.strategy, progress: progress)
      files.append("TTcut.mp4")
    }
    if request.outputs.rallyVideos {
      for (index, range) in ranges.enumerated() {
        try Task.checkCancellation()
        let url = work.appendingPathComponent(
          String(format: "%03d_回合%03d.mp4", index + 1, selectedClips[index].index))
        do {
          try await merged(
            video: video, ranges: [range], destination: url, strategy: request.strategy
          ) { value in progress((Double(index) + value) / Double(ranges.count)) }
          files.append(url.lastPathComponent)
        } catch is CancellationError { throw CancellationError() } catch {
          try? FileManager.default.removeItem(at: url)
          warnings.append("\(url.lastPathComponent): \(error.localizedDescription)")
        }
      }
    }
    if request.outputs.xml {
      do {
        try PremiereXML.build(video: video, clips: selectedClips, name: name).write(
          to: work.appendingPathComponent("TTcut.xml"), atomically: true, encoding: .utf8)
        files.append("TTcut.xml")
      } catch { warnings.append("TTcut.xml: " + error.localizedDescription) }
    }
    guard !files.isEmpty else {
      throw TTError("CUSTOM_ARTIFACT_EXPORT_FAILED", warnings.joined(separator: "\n"))
    }
    do {
      try HistoryStore.atomicWrite(request.result, to: work.appendingPathComponent("analysis.json"))
    } catch { warnings.append("分析副本写入失败：" + error.localizedDescription) }
    struct Report: Codable {
      var files: [String]
      var warnings: [String]
    }
    do {
      try HistoryStore.atomicWrite(
        Report(files: files, warnings: warnings),
        to: work.appendingPathComponent("export-report.json"))
    } catch { warnings.append("导出报告写入失败：" + error.localizedDescription) }
    try Task.checkCancellation()
    try FileManager.default.moveItem(at: work, to: final)
    return ExportResult(folder: final, files: files, warnings: warnings)
  }
  public func cover(video: VideoInfo, destination: URL) async throws {
    let tone =
      video.hdr == .sdr
      ? ""
      : "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=full,"
    _ = try await ProcessRunner.run(
      paths.ffmpeg,
      [
        "-v", "error", "-nostdin", "-y", "-ss", "0", "-i", video.path, "-frames:v", "1", "-vf",
        tone + "scale=640:-2", "-update", "1", destination.path,
      ])
  }
  public func processing(source: VideoInfo, normalize: Bool, store: HistoryStore) async throws -> (
    VideoInfo, ProcessingMedia
  ) {
    guard source.variableFrameRate, normalize else {
      return (
        source,
        ProcessingMedia(
          mode: source.variableFrameRate ? .originalVFR : .originalCFR, path: source.path)
      )
    }
    let identity = try SourceIdentity(url: source.url)
    let key = try HistoryStore.cacheKey(
      identity: identity, rate: source.frameRate, encoder: source.encoder)
    let directory = await store.processingRoot.appendingPathComponent(key, isDirectory: true)
    let final = directory.appendingPathComponent("processing.mp4")
    do {
      if FileManager.default.fileExists(atPath: final.path) {
        let cached = try await validate(
          final, source: source, duration: source.duration, segments: 1)
        guard !cached.variableFrameRate else { throw TTError("NORMALIZATION_STILL_VFR") }
        return (cached, ProcessingMedia(mode: .normalizedCFR, path: final.path, cacheKey: key))
      }
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let partial = directory.appendingPathComponent(UUID().uuidString + ".mp4")
      defer { try? FileManager.default.removeItem(at: partial) }
      try await encode(
        video: source, ranges: [CutRange(0, source.duration)], destination: partial,
        normalizeFPS: true)
      _ = try await validate(partial, source: source, duration: source.duration, segments: 1)
      try Task.checkCancellation()
      try FileManager.default.moveItem(at: partial, to: final)
      let info = try await MediaProbe(paths: paths).inspect(final)
      guard !info.variableFrameRate else { throw TTError("NORMALIZATION_STILL_VFR") }
      return (info, ProcessingMedia(mode: .normalizedCFR, path: final.path, cacheKey: key))
    } catch is CancellationError { throw CancellationError() } catch {
      return (
        source,
        ProcessingMedia(
          mode: .vfrFallback, path: source.path,
          warning: "CFR 转换失败，使用原始 VFR：" + error.localizedDescription)
      )
    }
  }
}

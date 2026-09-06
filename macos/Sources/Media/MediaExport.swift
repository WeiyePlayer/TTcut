import Foundation
import TTcutCore

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
      try pixelFormat(video),
    ]
    for (flag, value) in [
      ("-color_range", video.colorRange), ("-color_primaries", video.colorPrimaries),
      ("-color_trc", video.colorTransfer), ("-colorspace", video.colorSpace),
    ] {
      if let value { args += [flag, value] }
    }
    if video.encoder == "libx265" {
      var options = ["log-level=error", "repeat-headers=1"]
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
  static func inputArguments(_ video: VideoInfo, seekStart: Double?) -> [String] {
    var args = ["-copyts"]
    if let seekStart, seekStart > 0 {
      // Input-side seeking lets FFmpeg jump to the preceding keyframe. Accurate transcoding then
      // discards frames before the absolute trim boundary while -copyts preserves source timestamps.
      args += ["-ss", Self.decimal(seekStart)]
    }
    return args + ["-i", video.path]
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
    seekStart: Double? = nil,
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
      Self.inputArguments(video, seekStart: seekStart) + ["-filter_complex", graph] + maps
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
    if strategy == .compatible {
      try await encode(video: video, ranges: ranges, destination: destination, progress: progress)
    } else if ranges.count == 1 {
      try await encode(
        video: video, ranges: ranges, destination: destination, seekStart: ranges[0].start,
        progress: progress)
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
          video: video, ranges: [range], destination: segment, disableBFrames: shortSegment,
          seekStart: range.start
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
}

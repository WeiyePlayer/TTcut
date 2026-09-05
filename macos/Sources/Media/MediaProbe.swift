import Foundation
import TTcutCore

public struct MediaProbe: Sendable {
  public let paths: RuntimePaths
  public init(paths: RuntimePaths) { self.paths = paths }
  static func frameSampleIntervals(duration: Double) -> String {
    let positions = [0.0, 0.25, 0.5, 0.75, 0.95].map { max(0, duration * $0) }
    return positions.map {
      String(format: "%.6f%%+#8", locale: Locale(identifier: "en_US_POSIX"), $0)
    }.joined(separator: ",")
  }
  private func json(_ args: [String], url: URL) async throws -> [String: Any] {
    let result = try await ProcessRunner.run(
      paths.ffprobe, ["-v", "error", "-of", "json"] + args + [url.path])
    guard let object = try JSONSerialization.jsonObject(with: result.stdout) as? [String: Any]
    else { throw TTError("PROBE_INVALID_JSON") }
    return object
  }
  public func inspect(_ url: URL) async throws -> VideoInfo {
    let document = try await json(["-show_streams", "-show_format"], url: url)
    let streams = document["streams"] as? [[String: Any]] ?? []
    let format = document["format"] as? [String: Any] ?? [:]
    guard
      let v = streams.first(where: {
        $0["codec_type"] as? String == "video"
          && (($0["disposition"] as? [String: Any])?["attached_pic"] as? Int ?? 0) == 0
      })
    else { throw TTError("VIDEO_STREAM_MISSING") }
    let a = streams.first { $0["codec_type"] as? String == "audio" }
    func str(_ dict: [String: Any], _ key: String, _ fallback: String = "") -> String {
      dict[key].map { String(describing: $0) } ?? fallback
    }
    func num(_ dict: [String: Any], _ key: String, _ fallback: Double = 0) -> Double {
      Double(str(dict, key)) ?? fallback
    }
    func color(_ key: String) -> String? {
      let value = str(v, key)
      return ["", "unknown", "unspecified", "reserved"].contains(value) ? nil : value
    }
    var info = VideoInfo(path: url.standardizedFileURL.path)
    info.width = Int(num(v, "width"))
    info.height = Int(num(v, "height"))
    info.duration = num(v, "duration", num(format, "duration"))
    info.videoDuration = Double(str(v, "duration"))
    info.frameRate = str(v, "avg_frame_rate", "30/1")
    info.fps = VideoInfo.ratio(info.frameRate)
    info.nominalFPS = VideoInfo.ratio(str(v, "r_frame_rate"))
    if info.fps <= 0 { info.fps = info.nominalFPS }
    if info.nominalFPS <= 0 { info.nominalFPS = info.fps }
    if VideoInfo.ratio(info.frameRate) <= 0 { info.frameRate = str(v, "r_frame_rate") }
    info.frameCount = Int(str(v, "nb_frames"))
    info.variableFrameRate = abs(info.fps - info.nominalFPS) > 0.001
    info.videoCodec = str(v, "codec_name")
    info.profile = str(v, "profile")
    info.pixelFormat = str(v, "pix_fmt")
    let pf = info.pixelFormat
    info.bitDepth = Int(num(v, "bits_per_raw_sample"))
    if info.bitDepth == 0 {
      info.bitDepth =
        pf.contains("12")
        ? 12 : pf.contains("10") || pf.contains("p010") ? 10 : pf.contains("16") ? 16 : 8
    }
    info.chroma = pf.contains("444") ? "444" : pf.contains("422") ? "422" : "420"
    info.videoTimeBase = str(v, "time_base")
    info.videoStart = num(v, "start_time")
    info.bitrate = Int(num(v, "bit_rate", num(format, "bit_rate", 8_000_000)))
    info.sar = str(v, "sample_aspect_ratio", "1:1")
    info.colorRange = color("color_range")
    info.colorPrimaries = color("color_primaries")
    info.colorTransfer = color("color_transfer")
    info.colorSpace = color("color_space")
    info.hdr =
      info.colorTransfer == "smpte2084"
      ? .hdr10 : info.colorTransfer == "arib-std-b67" ? .hlg : .sdr
    if let a {
      info.audioCodec = str(a, "codec_name")
      info.audioChannels = Int(num(a, "channels", 2))
      info.audioSampleRate = Int(num(a, "sample_rate", 48000))
      info.audioTimeBase = str(a, "time_base")
      info.audioStart = num(a, "start_time")
      info.audioDuration = Double(str(a, "duration"))
      info.audioBitrate = Int(num(a, "bit_rate", 192000))
    }
    // Sample bounded windows across the source. HEVC HDR metadata may only be attached to
    // decoded frames, while decoding every frame makes selecting a long video appear frozen.
    let frameDocument = try await json(
      [
        "-select_streams", "v:0", "-read_intervals", Self.frameSampleIntervals(duration: info.duration),
        "-show_frames", "-show_entries",
        "frame=best_effort_timestamp_time:frame_side_data",
      ], url: url)
    let frames = frameDocument["frames"] as? [[String: Any]] ?? []
    let sides =
      (v["side_data_list"] as? [[String: Any]] ?? [])
      + frames.flatMap { $0["side_data_list"] as? [[String: Any]] ?? [] }
    for side in sides {
      let type = str(side, "side_data_type")
      if type.contains("Display Matrix") {
        info.rotation = ((-Int(num(side, "rotation")) % 360) + 360) % 360
      }
      if type.contains("DOVI") || type.contains("Dolby Vision") { info.hdr = .dolbyVision }
      if type.contains("HDR10+") || type.contains("HDR Dynamic Metadata SMPTE2094-40") {
        info.hdr = .hdr10Plus
      }
      if type.contains("Mastering display") {
        func unit(_ key: String, _ scale: Double) -> Int {
          Int((VideoInfo.ratio(str(side, key)) * scale).rounded())
        }
        info.masteringDisplay =
          "G(\(unit("green_x",50000)),\(unit("green_y",50000)))B(\(unit("blue_x",50000)),\(unit("blue_y",50000)))R(\(unit("red_x",50000)),\(unit("red_y",50000)))WP(\(unit("white_point_x",50000)),\(unit("white_point_y",50000)))L(\(unit("max_luminance",10000)),\(unit("min_luminance",10000)))"
      }
      if type.contains("Content light") {
        info.maxCLL = "\(Int(num(side,"max_content"))),\(Int(num(side,"max_average")))"
      }
    }
    if info.rotation == 90 || info.rotation == 270 { swap(&info.width, &info.height) }
    let times = frames.compactMap { Double(str($0, "best_effort_timestamp_time")) }
    guard !times.isEmpty else { throw TTError("VIDEO_TIMESTAMP_INVALID", "视频帧时间戳缺失") }
    if times.count > 2 {
      let intervalGap = max(2.0, info.fps > 0 ? 120 / info.fps : 2.0)
      let deltas = zip(times, times.dropFirst()).map { $1 - $0 }
        .filter { $0 > 0 && $0 <= intervalGap }
      if let lo = deltas.min(), let hi = deltas.max(),
        hi - lo > max(0.0001, 2 * VideoInfo.ratio(info.videoTimeBase))
      {
        info.variableFrameRate = true
      }
    }
    try info.validate()
    return info
  }
  public func withBoundaries(_ info: VideoInfo, ranges: [CutRange]) async throws -> VideoInfo {
    var result = info
    guard ranges.count == 1 else { return result }
    for time in [ranges[0].start, ranges[0].end] {
      let section = "\(max(0,time-2))%\(time+2)"
      let document = try await json(
        [
          "-read_intervals", section, "-show_packets", "-show_entries",
          "packet=codec_type,pts_time,duration_time,flags",
        ], url: info.url)
      for packet in document["packets"] as? [[String: Any]] ?? [] {
        guard let pts = Double(packet["pts_time"] as? String ?? "") else { continue }
        if packet["codec_type"] as? String == "video",
          (packet["flags"] as? String ?? "").contains("K")
        {
          result.keyframes.append(pts - info.videoStart)
        }
        if packet["codec_type"] as? String == "audio" {
          result.audioBoundaries.append(pts - info.videoStart)
        }
      }
    }
    return result
  }
}

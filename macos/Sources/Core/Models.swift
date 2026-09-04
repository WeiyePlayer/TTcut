import Foundation

public struct TTError: Error, LocalizedError, Codable, Sendable {
  public var code: String
  public var message: String
  public var errorDescription: String? { message }
  public init(_ code: String, _ message: String = "") {
    self.code = code
    self.message = message.isEmpty ? code : message
  }
}

public enum AnalysisMode: String, Codable, CaseIterable, Sendable { case full, twoStage }
public enum CutMode: String, Codable, CaseIterable, Sendable {
  case all, highlight, custom, analyzeOnly
}
public enum ExportStrategy: String, Codable, Sendable { case fastSegmented, compatible }
public enum HDRKind: String, Codable, Sendable { case sdr, hdr10, hlg, dolbyVision, hdr10Plus }

public struct Settings: Codable, Equatable, Sendable {
  public var language = "zh-CN"
  public var automaticCalibration = true
  public var preRoll = 2.5
  public var postRoll = 1.0
  public var analysisMode: AnalysisMode = .full
  public var normalizeVFR = false
  public init() {}
  public func validated() -> Settings {
    var copy = self
    if !["zh-CN", "en"].contains(language) { copy.language = "zh-CN" }
    if ![1.5, 2.5, 5].contains(preRoll) { copy.preRoll = 2.5 }
    if ![0.5, 1, 2, 4].contains(postRoll) { copy.postRoll = 1 }
    return copy
  }
}

public struct Point: Codable, Hashable, Sendable {
  public var x: Double
  public var y: Double
  public init(_ x: Double, _ y: Double) {
    self.x = x
    self.y = y
  }
  public func distance(to other: Point) -> Double { hypot(x - other.x, y - other.y) }
}

public struct VideoInfo: Codable, Equatable, Sendable {
  public var path: String
  public var width = 0
  public var height = 0
  public var duration = 0.0
  public var fps = 30.0
  public var nominalFPS = 30.0
  public var frameRate = "30/1"
  public var frameCount: Int?
  public var variableFrameRate = false
  public var videoCodec = "h264"
  public var profile = ""
  public var pixelFormat = "yuv420p"
  public var bitDepth = 8
  public var chroma = "420"
  public var videoTimeBase = "1/90000"
  public var videoStart = 0.0
  public var videoDuration: Double?
  public var audioCodec: String?
  public var audioChannels = 0
  public var audioSampleRate = 48000
  public var audioTimeBase = "1/48000"
  public var audioStart = 0.0
  public var audioDuration: Double?
  public var audioBitrate = 192000
  public var bitrate = 8_000_000
  public var sar = "1:1"
  public var rotation = 0
  public var colorRange: String?
  public var colorPrimaries: String?
  public var colorTransfer: String?
  public var colorSpace: String?
  public var hdr: HDRKind = .sdr
  public var masteringDisplay: String?
  public var maxCLL: String?
  public var keyframes: [Double] = []
  public var audioBoundaries: [Double] = []
  public init(path: String = "") { self.path = path }
  public var url: URL { URL(fileURLWithPath: path) }
  public var name: String { url.lastPathComponent }
  public var hasAudio: Bool { audioCodec != nil }
  public var outputCodec: String { hdr != .sdr || videoCodec == "hevc" ? "hevc" : "h264" }
  public var encoder: String { outputCodec == "hevc" ? "libx265" : "libx264" }
  public var timingQuantum: Double {
    max(
      1 / max(1, min(fps, nominalFPS)), hasAudio ? 1024 / Double(max(1, audioSampleRate)) : 0,
      Self.ratio(videoTimeBase), hasAudio ? Self.ratio(audioTimeBase) : 0)
  }
  public static func ratio(_ value: String) -> Double {
    let pieces = value.replacingOccurrences(of: ":", with: "/").split(separator: "/")
    guard let first = pieces.first.flatMap({ Double($0) }), first.isFinite else { return 0 }
    if pieces.count == 1 { return first }
    guard let denominator = Double(pieces[1]), denominator > 0 else { return 0 }
    return first / denominator
  }
  public func validate() throws {
    guard width > 0, height > 0, duration.isFinite, duration > 0, fps.isFinite, fps > 0 else {
      throw TTError("INVALID_VIDEO", "视频元数据无效 / Invalid video metadata")
    }
    if hdr == .dolbyVision || hdr == .hdr10Plus {
      throw TTError("DYNAMIC_HDR_UNSUPPORTED", "暂不支持 Dolby Vision / HDR10+ 保真剪辑")
    }
  }
}

public struct SourceIdentity: Codable, Equatable, Sendable {
  public var path: String
  public var size: UInt64
  public var modified: Double
  public init(url: URL) throws {
    let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
    let values = try FileManager.default.attributesOfItem(atPath: resolved.path)
    guard let size = values[.size] as? NSNumber, let modified = values[.modificationDate] as? Date
    else { throw TTError("SOURCE_UNAVAILABLE") }
    path = resolved.path
    self.size = size.uint64Value
    self.modified = modified.timeIntervalSince1970
  }
  public var currentStatus: SourceStatus {
    guard FileManager.default.fileExists(atPath: path) else { return .missing }
    return (try? SourceIdentity(url: URL(fileURLWithPath: path))) == self ? .available : .changed
  }
}
public enum SourceStatus: String, Codable, Sendable {
  case available, missing, changed, processingMissing
}

public struct Calibration: Codable, Equatable, Sendable {
  public var width: Int
  public var height: Int
  /// Top left, top right, bottom right, bottom left in displayed source pixels.
  public var points: [Point]
  public init(width: Int, height: Int, points: [Point]) {
    self.width = width
    self.height = height
    self.points = points
  }
  public func validate() throws {
    guard width > 0, height > 0, points.count == 4 else { throw TTError("INVALID_CALIBRATION") }
    let minDistance = max(3, hypot(Double(width), Double(height)) * 0.005)
    for (i, p) in points.enumerated() {
      guard p.x.isFinite, p.y.isFinite, p.x >= 0, p.y >= 0, p.x < Double(width),
        p.y < Double(height)
      else { throw TTError("CALIBRATION_OUTSIDE_FRAME") }
      for q in points.dropFirst(i + 1) where p.distance(to: q) < minDistance {
        throw TTError("CALIBRATION_OVERLAP")
      }
    }
    var crosses: [Double] = []
    var area = 0.0
    for i in 0..<4 {
      let a = points[i]
      let b = points[(i + 1) % 4]
      let c = points[(i + 2) % 4]
      crosses.append((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x))
      area += a.x * b.y - b.x * a.y
    }
    guard crosses.allSatisfy({ $0 > 0 }) || crosses.allSatisfy({ $0 < 0 }),
      abs(area / 2) >= Double(width * height) * 0.001,
      points[0].y + points[1].y < points[2].y + points[3].y,
      points[0].x + points[3].x < points[1].x + points[2].x
    else { throw TTError("CALIBRATION_POINT_ORDER") }
  }
}

public struct Rally: Codable, Equatable, Identifiable, Sendable {
  public var id: String
  public var index: Int
  public var start: Double
  public var end: Double
  public var bounceCount: Int
  public var startFrame: Int
  public var endFrame: Int
  public init(
    id: String = UUID().uuidString, index: Int, start: Double, end: Double, bounceCount: Int,
    startFrame: Int = 0, endFrame: Int = 0
  ) {
    self.id = id
    self.index = index
    self.start = start
    self.end = end
    self.bounceCount = bounceCount
    self.startFrame = startFrame
    self.endFrame = endFrame
  }
}

public struct ProcessingMedia: Codable, Equatable, Sendable {
  public enum Mode: String, Codable, Sendable {
    case originalCFR, originalVFR, normalizedCFR, vfrFallback
  }
  public var mode: Mode
  public var path: String
  public var cacheKey: String?
  public var warning: String?
  public init(mode: Mode, path: String, cacheKey: String? = nil, warning: String? = nil) {
    self.mode = mode
    self.path = path
    self.cacheKey = cacheKey
    self.warning = warning
  }
}

public struct TableKeypoint: Codable, Sendable {
  public var index: Int
  public var position: Point
  public var activation: Double
  public var valid: Bool
  public init(index: Int, position: Point, activation: Double, valid: Bool) {
    self.index = index
    self.position = position
    self.activation = activation
    self.valid = valid
  }
}
public struct TableSample: Codable, Sendable {
  public var label: String
  public var time: Double
  public var frameIndex: Int
  public var points: [TableKeypoint]
  public init(label: String, time: Double, frameIndex: Int, points: [TableKeypoint]) {
    self.label = label
    self.time = time
    self.frameIndex = frameIndex
    self.points = points
  }
}
public struct AnalysisResult: Codable, Identifiable, Sendable {
  public var schemaVersion = 1
  public var id: String
  public var createdAt: Date
  public var source: SourceIdentity
  public var sourceVideo: VideoInfo
  public var video: VideoInfo
  public var processing: ProcessingMedia
  public var calibration: Calibration
  public var mode: AnalysisMode
  public var rallies: [Rally]
  public var bounceTimes: [Double]
  public var tableSamples: [TableSample]
  public var backend = "coreml"
  public var modelDigests: [String: String]
  public var visibleInHistory: Bool
  public var outputPath: String?
  public init(
    id: String = UUID().uuidString, source: SourceIdentity, sourceVideo: VideoInfo,
    video: VideoInfo, processing: ProcessingMedia,
    calibration: Calibration, mode: AnalysisMode, rallies: [Rally], bounceTimes: [Double],
    tableSamples: [TableSample] = [], modelDigests: [String: String] = [:],
    visibleInHistory: Bool = true
  ) {
    self.id = id
    createdAt = Date()
    self.source = source
    self.sourceVideo = sourceVideo
    self.video = video
    self.processing = processing
    self.calibration = calibration
    self.mode = mode
    self.rallies = rallies
    self.bounceTimes = bounceTimes
    self.tableSamples = tableSamples
    self.modelDigests = modelDigests
    self.visibleInHistory = visibleInHistory
  }
}

public struct CutRange: Codable, Equatable, Sendable {
  public var start: Double
  public var end: Double
  public var clipIDs: [String]
  public init(_ start: Double, _ end: Double, clipIDs: [String] = []) {
    self.start = start
    self.end = end
    self.clipIDs = clipIDs
  }
  public var duration: Double { end - start }
}
public struct CustomClip: Codable, Equatable, Identifiable, Sendable {
  public var id: String
  public var sourceRallyID: String?
  public var index: Int
  public var bounceCount: Int?
  public var defaultStart: Double
  public var defaultEnd: Double
  public var start: Double
  public var end: Double
  public var selected = true
  public var isManual: Bool { sourceRallyID == nil }
  public var range: CutRange { CutRange(start, end, clipIDs: [id]) }
  public init(
    id: String, sourceRallyID: String?, index: Int, bounceCount: Int?, start: Double, end: Double
  ) {
    self.id = id
    self.sourceRallyID = sourceRallyID
    self.index = index
    self.bounceCount = bounceCount
    self.start = start
    self.end = end
    defaultStart = start
    defaultEnd = end
  }
}

public struct ExportOutputs: Codable, Sendable, Equatable {
  public var combined = true
  public var rallyVideos = false
  public var xml = false
  public init(combined: Bool = true, rallyVideos: Bool = false, xml: Bool = false) {
    self.combined = combined
    self.rallyVideos = rallyVideos
    self.xml = xml
  }
  public func validate(custom: Bool) throws {
    guard combined || rallyVideos || xml, !(combined && (rallyVideos || xml)), custom || combined
    else { throw TTError("INVALID_EXPORT_OUTPUTS") }
  }
}

public struct AnalysisRequest: Codable, Sendable {
  public var schemaVersion = 1
  public var taskID: String
  public var operation: String
  public var video: VideoInfo
  public var calibration: Calibration?
  public var mode: AnalysisMode = .full
  public var confidence = 0.7
  public var stage1Confidence = 0.3
  public var stage2Confidence = 0.7
  public var modelsDirectory: String
  public init(taskID: String, operation: String, video: VideoInfo, modelsDirectory: String) {
    self.taskID = taskID
    self.operation = operation
    self.video = video
    self.modelsDirectory = modelsDirectory
  }
}
public struct WorkerEvent: Codable, Sendable {
  public var schemaVersion = 1
  public var roi: AnalysisROI?
  public var type: String
  public var taskID: String
  public var stage: String?
  public var current: Int?
  public var total: Int?
  public var calibration: Calibration?
  public var rallies: [Rally]?
  public var bounceTimes: [Double]?
  public var tableSamples: [TableSample]?
  public var error: TTError?
  public init(type: String, taskID: String) {
    self.type = type
    self.taskID = taskID
  }
}

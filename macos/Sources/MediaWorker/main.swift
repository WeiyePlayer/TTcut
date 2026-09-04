import Foundation
import TTcutCore
import TTcutMedia

struct Request: Decodable {
  let schemaVersion: Int
  let taskID: String
  let operation: String
  let sourcePath: String
  let runtimeDirectory: String
  let destination: String?
  let ranges: [CutRange]?
  let strategy: ExportStrategy?
}
struct Event: Encodable {
  let schemaVersion = 1
  var taskID: String
  var type: String
  var stage: String?
  var current: Double?
  var total: Double?
  var video: VideoInfo?
  var outputPath: String?
  var error: TTError?
}
func emit(_ event: Event) {
  do {
    var data = try JSONEncoder().encode(event); data.append(10)
    try FileHandle.standardOutput.write(contentsOf: data)
  } catch { exit(74) }
}

@main struct MediaWorker {
  static func main() async {
    var id = "00000000-0000-0000-0000-000000000000"
    do {
      guard let line = readLine(), let data = line.data(using: .utf8), data.count <= 4 * 1024 * 1024 else { throw TTError("INVALID_REQUEST") }
      let request = try JSONDecoder().decode(Request.self, from: data)
      guard request.schemaVersion == 1, UUID(uuidString: request.taskID) != nil else { throw TTError("INVALID_REQUEST") }
      id = request.taskID
      let task = Task { try await run(request) }
      signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
      let signals = [SIGTERM, SIGINT].map { value -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: value, queue: .global())
        source.setEventHandler { task.cancel() }; source.resume(); return source
      }
      defer { signals.forEach { $0.cancel() } }
      try await task.value
    } catch {
      let failure = error is CancellationError ? TTError("PROCESS_CANCELLED") : (error as? TTError ?? TTError("MEDIA_FAILED", error.localizedDescription))
      emit(Event(taskID: id, type: "error", error: failure)); exit(1)
    }
  }
  static func run(_ request: Request) async throws {
    let root = URL(fileURLWithPath: request.runtimeDirectory)
    let paths = RuntimePaths(ffmpeg: root.appendingPathComponent("bin/ffmpeg"), ffprobe: root.appendingPathComponent("bin/ffprobe"), worker: root.appendingPathComponent("bin/TTcutWorker"), models: root.appendingPathComponent("Models"))
    let probe = MediaProbe(paths: paths)
    let source = URL(fileURLWithPath: request.sourcePath)
    let identity = try SourceIdentity(url: source)
    let video = try await probe.inspect(source)
    let exporter = MediaExporter(paths: paths)
    let progress: @Sendable (Double) -> Void = { value in
      emit(Event(taskID: request.taskID, type: "progress", stage: request.operation, current: min(1, max(0, value)), total: 1))
    }
    if request.operation == "probe" {
      emit(Event(taskID: request.taskID, type: "result", video: video)); return
    }
    guard let name = request.destination, name != request.sourcePath else { throw TTError("INVALID_DESTINATION") }
    let destination = URL(fileURLWithPath: name)
    guard !FileManager.default.fileExists(atPath: destination.path) else { throw TTError("OUTPUT_COLLISION") }
    // The caller owns a unique staging directory. Never touch source or final deliverables.
    try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    var committed = false
    defer { if !committed { try? FileManager.default.removeItem(at: destination) } }
    switch request.operation {
    case "cover": try await exporter.cover(video: video, destination: destination)
    case "preview": try await MediaPreview.render(video: video, paths: paths, destination: destination, progress: progress)
    case "normalize":
      try await exporter.encode(video: video, ranges: [CutRange(0, video.duration)], destination: destination, normalizeFPS: true, progress: progress)
      _ = try await exporter.validate(destination, source: video, duration: video.duration, segments: 1)
    case "export":
      guard let ranges = request.ranges, !ranges.isEmpty,
        ranges.allSatisfy({ $0.start.isFinite && $0.end.isFinite && $0.start >= 0 && $0.end > $0.start && $0.end <= video.duration + 1e-6 }),
        zip(ranges, ranges.dropFirst()).allSatisfy({ $0.end <= $1.start + 1e-6 }) else { throw TTError("INVALID_RANGES") }
      try await exporter.merged(video: video, ranges: ranges, destination: destination, strategy: request.strategy ?? .fastSegmented, progress: progress)
    default: throw TTError("INVALID_OPERATION")
    }
    try Task.checkCancellation()
    guard identity.currentStatus == .available else { throw TTError("SOURCE_CHANGED") }
    let output = request.operation == "cover" ? nil : try await probe.inspect(destination)
    if request.operation == "normalize", output?.variableFrameRate != false { throw TTError("NORMALIZATION_STILL_VFR") }
    committed = true
    emit(Event(taskID: request.taskID, type: "result", video: output, outputPath: destination.path))
  }
}

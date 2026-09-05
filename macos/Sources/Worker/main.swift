import CoreML
import Foundation
import TTNative
import TTcutCore

func nativeError() -> TTError { TTError("NATIVE_MEDIA_ERROR", String(cString: tt_last_error())) }

struct PreparedFrame: Sendable {
  var index: Int
  var time: Double
  var pixels: [Float]
}

final class Decoder {
  let handle: OpaquePointer
  let video: VideoInfo
  init(_ video: VideoInfo) throws {
    self.video = video
    guard
      let handle = tt_reader_open(
        video.path, Int32(video.rotation), video.hdr == .sdr ? 0 : 1, video.fps)
    else { throw nativeError() }
    self.handle = handle
  }
  deinit { tt_reader_close(handle) }
  func next() throws -> TTFrame? {
    var frame = TTFrame()
    let status = tt_reader_next(handle, &frame)
    if status < 0 { throw nativeError() }
    guard status > 0 else { return nil }
    guard frame.width == video.width, frame.height == video.height else {
      throw TTError("DECODED_DIMENSIONS_CHANGED")
    }
    return frame
  }
  func sample(at time: Double) throws -> TTFrame {
    guard tt_reader_seek(handle, time) == 0 else { throw nativeError() }
    for _ in 0..<max(1, Int(ceil(video.fps * 10))) {
      guard var frame = try next() else { throw TTError("AUTO_CALIBRATION_SEEK_EOF") }
      if frame.time + 0.5 / video.fps < time { continue }
      guard abs(frame.time - time) <= max(2 / video.fps, 0.05) else {
        throw TTError("AUTO_CALIBRATION_SEEK_OVERSHOT")
      }
      frame.index = Int64((frame.time * video.fps).rounded(.toNearestOrEven))
      return frame
    }
    throw TTError("AUTO_CALIBRATION_SEEK_LIMIT")
  }
  func prepare(_ roi: AnalysisROI) throws -> PreparedFrame? {
    guard var frame = try next() else { return nil }
    var pixels = [Float](repeating: 0, count: roi.modelWidth * roi.modelHeight * 3)
    let status = tt_prepare_blurball(
      &frame, Int32(roi.x), Int32(roi.y), Int32(roi.width), Int32(roi.height),
      Int32(roi.modelWidth), Int32(roi.modelHeight), &pixels)
    if status != 0 { throw nativeError() }
    return PreparedFrame(index: Int(frame.index), time: frame.time, pixels: pixels)
  }
}

final class Inference {
  let model: MLModel
  init(directory: String, name: String, units: MLComputeUnits) throws {
    let config = MLModelConfiguration()
    config.computeUnits = units
    let root = URL(fileURLWithPath: directory)
    let compiled = root.appendingPathComponent(name + ".mlmodelc")
    guard FileManager.default.fileExists(atPath: compiled.path) else {
      throw TTError("MODEL_MISSING", compiled.path)
    }
    model = try MLModel(contentsOf: compiled, configuration: config)
  }
  func predict(_ values: [Float], shape: [Int]) throws -> MLMultiArray {
    let array = try MLMultiArray(shape: shape.map(NSNumber.init), dataType: .float32)
    guard array.count == values.count else { throw TTError("MODEL_INPUT_SHAPE") }
    values.withUnsafeBufferPointer {
      array.dataPointer.copyMemory(from: $0.baseAddress!, byteCount: values.count * 4)
    }
    let provider = try MLDictionaryFeatureProvider(dictionary: [
      "frames": MLFeatureValue(multiArray: array)
    ])
    guard
      let output = try model.prediction(from: provider).featureValue(for: "heatmaps")?
        .multiArrayValue
    else { throw TTError("MODEL_OUTPUT_MISSING") }
    return output
  }
  func predictAsync(_ values: [Float], shape: [Int]) async throws -> MLMultiArray {
    let array = try MLMultiArray(shape: shape.map(NSNumber.init), dataType: .float32)
    guard array.count == values.count else { throw TTError("MODEL_INPUT_SHAPE") }
    values.withUnsafeBufferPointer {
      array.dataPointer.copyMemory(from: $0.baseAddress!, byteCount: values.count * 4)
    }
    let provider = try MLDictionaryFeatureProvider(dictionary: [
      "frames": MLFeatureValue(multiArray: array)
    ])
    guard
      let output = try await model.prediction(from: provider).featureValue(for: "heatmaps")?
        .multiArrayValue
    else { throw TTError("MODEL_OUTPUT_MISSING") }
    return output
  }
  static func plane(_ output: MLMultiArray, channel: Int) throws -> (
    pixels: [Float], width: Int, height: Int
  ) {
    let shape = output.shape.map(\.intValue)
    let strides = output.strides.map(\.intValue)
    guard shape.count == 4, shape[0] == 1, channel >= 0, channel < shape[1],
      output.dataType == .float32
    else { throw TTError("MODEL_OUTPUT_SHAPE") }
    let pointer = output.dataPointer.assumingMemoryBound(to: Float.self)
    var pixels = [Float](repeating: 0, count: shape[2] * shape[3])
    for y in 0..<shape[2] {
      for x in 0..<shape[3] {
        pixels[y * shape[3] + x] = pointer[channel * strides[1] + y * strides[2] + x * strides[3]]
      }
    }
    return (pixels, shape[3], shape[2])
  }
}

final class Worker {
  let request: AnalysisRequest
  init(_ request: AnalysisRequest) { self.request = request }
  func emit(_ event: WorkerEvent) {
    do {
      var data = try JSONEncoder().encode(event)
      data.append(10)
      try FileHandle.standardOutput.write(contentsOf: data)
    } catch { exit(74) }
  }
  func progress(_ stage: String, _ current: Int, _ total: Int) {
    var event = WorkerEvent(type: "progress", taskID: request.taskID)
    event.stage = stage
    event.current = current
    event.total = total
    emit(event)
  }
  func calibrate() throws -> (Calibration, [TableSample]) {
    progress("table_model", 0, 1)
    let predictor = try Inference(
      directory: request.modelsDirectory, name: "Table", units: .cpuOnly)
    let decoder = try Decoder(request.video)
    let video = request.video
    let count = video.frameCount ?? Int(ceil(video.duration * video.fps))
    let labels = ["first", "25_percent", "50_percent", "75_percent", "last"]
    var samples: [TableSample] = []
    for (index, ratio) in [0.0, 0.25, 0.5, 0.75, 1.0].enumerated() {
      let target: Double
      if !video.variableFrameRate, count > 0 {
        target =
          Double(ratio == 1 ? count - 1 : min(count - 1, Int(ceil(Double(count) * ratio - 1e-9))))
          / video.fps
      } else {
        target = ratio == 1 ? max(0, video.duration - 1 / video.fps) : video.duration * ratio
      }
      var frame = try decoder.sample(at: max(0, target))
      guard
        !samples.contains(where: {
          $0.frameIndex == Int(frame.index) || abs($0.time - frame.time) < 1e-9
        })
      else { throw TTError("AUTO_CALIBRATION_TOO_FEW_FRAMES") }
      var input = [Float](repeating: 0, count: 3 * 1600 * 896)
      guard tt_prepare_table(&frame, &input) == 0 else { throw nativeError() }
      let output = try predictor.predict(input, shape: [1, 3, 896, 1600])
      var points: [TableKeypoint] = []
      for channel in 0..<13 {
        let plane = try Inference.plane(output, channel: channel)
        let best = plane.pixels.indices.max { plane.pixels[$0] < plane.pixels[$1] }!
        let activation = Double(plane.pixels[best])
        let x = Double(
          (Float(best % plane.width) + 0.5) * Float(video.width) / Float(plane.width) - 0.5)
        let y = Double(
          (Float(best / plane.width) + 0.5) * Float(video.height) / Float(plane.height) - 0.5)
        points.append(
          TableKeypoint(
            index: channel, position: Point(x, y), activation: activation,
            valid: activation.isFinite && activation >= 0.1 && x >= 0 && x < Double(video.width)
              && y >= 0 && y < Double(video.height)))
      }
      samples.append(
        TableSample(
          label: labels[index], time: frame.time, frameIndex: Int(frame.index), points: points))
      progress("table_inference", index + 1, 5)
    }
    return (
      try TableAggregation.calibration(samples, width: video.width, height: video.height), samples
    )
  }
  func trajectories(
    calibration: Calibration, predictor: Inference, threshold: Float, intervals: [CutRange]?
  ) async throws -> [TrajectoryPoint] {
    let roi = try AnalysisROI(calibration: calibration)
    var points: [TrajectoryPoint] = []
    var previous: Point?
    let total = request.video.frameCount ?? Int(ceil(request.video.duration * request.video.fps))
    func consume(_ output: MLMultiArray, channels: [Int], targets: [PreparedFrame]) throws {
      for (channel, frame) in zip(channels, targets) {
        let plane = try Inference.plane(output, channel: channel)
        var detections = [TTDetection](repeating: TTDetection(), count: plane.width * plane.height)
        let count = tt_decode_heatmap(
          plane.pixels, Int32(plane.width), Int32(plane.height), threshold,
          Int32(roi.x), Int32(roi.y), Int32(roi.width), Int32(roi.height), &detections,
          Int32(detections.count))
        guard count >= 0 else { throw nativeError() }
        let candidates = detections.prefix(Int(count)).filter {
          previous == nil || previous!.distance(to: Point($0.x, $0.y)) < 100
        }
        if let selected = candidates.max(by: { $0.confidence < $1.confidence }) {
          previous = Point(selected.x, selected.y)
          points.append(
            TrajectoryPoint(
              frame: frame.index, time: frame.time,
              x: min(Double(request.video.width - 1), max(0, selected.x.rounded(.toNearestOrEven))),
              y: min(
                Double(request.video.height - 1), max(0, selected.y.rounded(.toNearestOrEven))),
              confidence: selected.confidence, visible: true))
        } else {
          previous = nil
          points.append(TrajectoryPoint(frame: frame.index, time: frame.time))
        }
      }
    }
    let source = try PredictionJobs(video: request.video, roi: roi, intervals: intervals)
    defer { source.close() }
    typealias Pending = (job: PredictionJob, task: Task<MLMultiArray?, Error>)
    var pending: [Pending] = []
    func submit() throws -> Bool {
      guard let job = try source.next() else { return false }
      let task = Task.detached(priority: .userInitiated) { () throws -> MLMultiArray? in
        try Task.checkCancellation()
        guard !job.channels.isEmpty else { return nil }
        return try await predictor.predictAsync(job.frames.flatMap(\.pixels), shape: [1,9,roi.modelHeight,roi.modelWidth])
      }
      pending.append((job, task))
      return true
    }
    do {
      for _ in 0..<4 { if try !submit() { break } }
      while !pending.isEmpty {
        try Task.checkCancellation()
        let first = pending.removeFirst()
        let output = try await first.task.value
        if first.job.resetPrevious { previous = nil }
        if let output {
          try autoreleasepool { try consume(output, channels: first.job.channels, targets: first.job.targets) }
        }
        let current = first.job.progressIndex + 1
        if current % 30 == 0 || current >= total {
          progress(intervals != nil ? "refinement_analysis" : request.mode == .twoStage ? "candidate_analysis" : "analysis", current, total)
        }
        _ = try submit()
      }
    } catch {
      pending.forEach { $0.task.cancel() }
      for item in pending { _ = await item.task.result }
      throw error
    }
    return points
  }
  func run() async throws {
    guard request.schemaVersion == 1, UUID(uuidString: request.taskID) != nil else {
      throw TTError("INVALID_REQUEST")
    }
    try request.video.validate()
    if request.operation == "calibrate" {
      let (calibration, samples) = try calibrate()
      var event = WorkerEvent(type: "result", taskID: request.taskID)
      event.calibration = calibration
      event.tableSamples = samples
      emit(event)
      return
    }
    guard request.operation == "analyze", let calibration = request.calibration else {
      throw TTError("CALIBRATION_REQUIRED")
    }
    try calibration.validate()
    let predictor = try Inference(
      directory: request.modelsDirectory, name: "BlurBall", units: .cpuAndNeuralEngine)
    var points = try await trajectories(
      calibration: calibration, predictor: predictor,
      threshold: Float(request.mode == .twoStage ? request.stage1Confidence : request.confidence),
      intervals: nil)
    var frames = try BounceDetector.detect(points, calibration: calibration)
    var rallies = RallyGrouping.group(bounceFrames: frames, points: points)
    if request.mode == .twoStage {
      let intervals = Segments.refinement(rallies, duration: request.video.duration)
      if !intervals.isEmpty {
        points = try await trajectories(
          calibration: calibration, predictor: predictor,
          threshold: Float(request.stage2Confidence), intervals: intervals)
        frames = try BounceDetector.detect(points, calibration: calibration)
        rallies = RallyGrouping.group(bounceFrames: frames, points: points)
      } else {
        points = []
        frames = []
        rallies = []
      }
    }
    let set = Set(frames)
    var event = WorkerEvent(type: "result", taskID: request.taskID)
    event.roi = try AnalysisROI(calibration: calibration)
    event.rallies = rallies
    event.bounceTimes = points.filter { set.contains($0.frame) }.map(\.time).sorted()
    emit(event)
  }
}

var taskID = "unknown"
do {
  guard let line = readLine(), let data = line.data(using: .utf8), data.count <= 1_048_576 else {
    throw TTError("INVALID_REQUEST")
  }
  let request = try JSONDecoder().decode(AnalysisRequest.self, from: data)
  taskID = request.taskID
  try await Worker(request).run()
} catch {
  var event = WorkerEvent(type: "error", taskID: taskID)
  event.error = (error as? TTError) ?? TTError("ANALYSIS_FAILED", error.localizedDescription)
  if let data = try? JSONEncoder().encode(event) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
  exit(1)
}

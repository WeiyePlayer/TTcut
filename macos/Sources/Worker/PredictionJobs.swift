import Foundation
import TTcutCore

struct PredictionJob: Sendable {
  var frames: [PreparedFrame]
  var channels: [Int]
  var targets: [PreparedFrame]
  var resetPrevious: Bool = false
  var progressIndex: Int
}

/// Four queued windows plus four in-flight predictions. The producer owns the
/// decoder; all queue state is protected by condition. No frame dropping.
final class PredictionJobs: @unchecked Sendable {
  private let condition = NSCondition()
  private let completed = DispatchSemaphore(value: 0)
  private var jobs: [PredictionJob] = []
  private var stopped = false
  private var finished = false
  private var failure: Error?

  init(video: VideoInfo, roi: AnalysisROI, intervals: [CutRange]?) throws {
    let decoder = try Decoder(video)
    DispatchQueue(label: "ttcut.fp16.decode", qos: .userInitiated).async {
      defer {
        self.condition.lock()
        self.finished = true
        self.condition.broadcast()
        self.condition.unlock()
        self.completed.signal()
      }
      do {
        if let intervals {
          var currentInterval: Int?
          func enqueue(_ a: PreparedFrame, _ b: PreparedFrame, _ c: PreparedFrame) -> Bool {
            let index = intervals.firstIndex { b.time >= $0.start && b.time <= $0.end }
            let reset = index != currentInterval
            currentInterval = index
            return self.push(PredictionJob(
              frames: index == nil ? [] : [a,b,c], channels: index == nil ? [] : [1],
              targets: index == nil ? [] : [b], resetPrevious: reset, progressIndex: b.index))
          }
          if let first = try decoder.prepare(roi) {
            if var center = try decoder.prepare(roi) {
              var older = first
              guard enqueue(first, first, center) else { return }
              while let next = try autoreleasepool(invoking: { try decoder.prepare(roi) }) {
                guard enqueue(older, center, next) else { return }
                older = center
                center = next
              }
              _ = enqueue(older, center, center)
            } else { _ = enqueue(first, first, first) }
          }
        } else {
          var frames: [PreparedFrame] = []
          while let frame = try autoreleasepool(invoking: { try decoder.prepare(roi) }) {
            frames.append(frame)
            if frames.count == 3 {
              guard self.push(PredictionJob(frames: frames, channels: [0,1,2], targets: frames, progressIndex: frame.index)) else { return }
              frames.removeAll(keepingCapacity: true)
            }
          }
          if let last = frames.last {
            let targets = frames
            while frames.count < 3 { frames.append(last) }
            _ = self.push(PredictionJob(frames: frames, channels: Array(0..<targets.count), targets: targets, progressIndex: last.index))
          }
        }
      } catch {
        self.condition.lock(); self.failure = error; self.condition.unlock()
      }
    }
  }

  private func push(_ job: PredictionJob) -> Bool {
    condition.lock(); defer { condition.unlock() }
    while jobs.count >= 4 && !stopped { condition.wait() }
    guard !stopped else { return false }
    jobs.append(job); condition.broadcast(); return true
  }

  func next() throws -> PredictionJob? {
    condition.lock(); defer { condition.unlock() }
    while jobs.isEmpty && !finished && !stopped { condition.wait() }
    if let failure { throw failure }
    guard !jobs.isEmpty else { return nil }
    let job = jobs.removeFirst(); condition.broadcast(); return job
  }

  func close() {
    condition.lock(); stopped = true; jobs.removeAll(); condition.broadcast(); condition.unlock()
    completed.wait()
  }
}

#!/usr/bin/env python3
"""Build an isolated benchmark from a pinned Worker, retaining its postprocessing."""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
BASE = '8f9bb7bddeae3dd942d11d54c2dd80c2470bc645'

QUEUE = r'''
// Only the dedicated producer accesses Decoder. All queue state is locked.
final class PrefetchedFrames {
  let condition = NSCondition()
  let done = DispatchSemaphore(value: 0)
  var buffer: [PreparedFrame] = []
  var stopped = false
  var finished = false
  var failure: Error?
  init(decoder: Decoder, roi: AnalysisROI) {
    DispatchQueue(label: "ttcut.benchmark.decode", qos: .userInitiated).async {
      defer { self.done.signal() }
      do {
        while true {
          self.condition.lock()
          while self.buffer.count >= 12 && !self.stopped { self.condition.wait() }
          let stop = self.stopped
          self.condition.unlock()
          if stop { break }
          guard let frame = try autoreleasepool(invoking: { try decoder.prepare(roi) }) else { break }
          self.condition.lock()
          if !self.stopped { self.buffer.append(frame) }
          self.condition.broadcast()
          self.condition.unlock()
        }
      } catch {
        self.condition.lock(); self.failure = error; self.condition.unlock()
      }
      self.condition.lock(); self.finished = true; self.condition.broadcast(); self.condition.unlock()
    }
  }
  func next() throws -> PreparedFrame? {
    condition.lock(); defer { condition.unlock() }
    while buffer.isEmpty && !finished && !stopped { condition.wait() }
    if let failure { throw failure }
    guard !buffer.isEmpty else { return nil }
    let value = buffer.removeFirst(); condition.broadcast(); return value
  }
  func close() {
    condition.lock(); stopped = true; buffer.removeAll(); condition.broadcast(); condition.unlock()
    done.wait()
  }
}
'''

PIPELINE = r'''
    let source = PrefetchedFrames(decoder: decoder, roi: roi)
    defer { source.close() }
    func window() throws -> (frames: [PreparedFrame], targets: [PreparedFrame])? {
      var frames: [PreparedFrame] = []
      while frames.count < 3, let frame = try source.next() { frames.append(frame) }
      guard let last = frames.last else { return nil }
      let targets = frames
      while frames.count < 3 { frames.append(last) }
      return (frames, targets)
    }
    let concurrency = Int(ProcessInfo.processInfo.environment["TT_BENCH_CONCURRENCY"] ?? "0")!
    if concurrency == 0 {
      while let item = try window() {
        let output = try autoreleasepool { try predictor.predict(item.frames.flatMap(\.pixels), shape: [1,9,roi.modelHeight,roi.modelWidth]) }
        try autoreleasepool { try consume(output, channels: Array(0..<item.targets.count), targets: item.targets) }
        if (item.targets.last!.index + 1) % 30 == 0 { progress("analysis", item.targets.last!.index + 1, total) }
      }
    } else {
      var pending: [(targets: [PreparedFrame], task: Task<MLMultiArray, Error>)] = []
      defer { pending.forEach { $0.task.cancel() } }
      func submit() throws -> Bool {
        guard let item = try window() else { return false }
        let task = Task.detached(priority: .userInitiated) {
          try Task.checkCancellation()
          return try await predictor.predictAsync(item.frames.flatMap(\.pixels), shape: [1,9,roi.modelHeight,roi.modelWidth])
        }
        pending.append((item.targets, task))
        return true
      }
      for _ in 0..<concurrency { if try !submit() { break } }
      while !pending.isEmpty {
        let first = pending.removeFirst()
        let output = try await first.task.value
        try autoreleasepool { try consume(output, channels: Array(0..<first.targets.count), targets: first.targets) }
        if (first.targets.last!.index + 1) % 30 == 0 { progress("analysis", first.targets.last!.index + 1, total) }
        _ = try submit()
      }
    }
    return points
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    # Core/native sources are shared read-only with the temporary package. Refuse
    # to benchmark a pinned Worker against a different decoder or postprocessor.
    subprocess.run(['git', 'diff', '--exit-code', BASE, '--',
                    'macos/Sources/Core', 'macos/Sources/NativeBridge', 'macos/Package.swift'],
                   cwd=ROOT, check=True, stdout=subprocess.PIPE)
    out = args.output.resolve()
    package = out / 'package'
    worker = package / 'Sources/Worker'
    worker.mkdir(parents=True, exist_ok=True)
    for name in ['Core', 'Media', 'NativeBridge']:
        dest = package / 'Sources' / name
        if not dest.exists():
            dest.symlink_to(ROOT / 'macos/Sources' / name, target_is_directory=True)
    manifest = (ROOT / 'macos/Package.swift').read_text()
    manifest = manifest.replace('let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vendor/native").path', 'let native = ' + json.dumps(str(ROOT / 'macos/Vendor/native')))
    for name in ['MediaWorker']:
        dest = package / 'Sources' / name
        if not dest.exists(): dest.symlink_to(ROOT / 'macos/Sources' / name, target_is_directory=True)
    if not (package / 'Tests').exists(): (package / 'Tests').symlink_to(ROOT / 'macos/Tests', target_is_directory=True)
    (package / 'Package.swift').write_text(manifest)
    source = subprocess.check_output(['git', 'show', BASE + ':macos/Sources/Worker/main.swift'], cwd=ROOT, text=True)
    (out / 'baseline-worker.swift').write_text(source)
    # The only baseline changes are a configurable frame cap and diagnostic export.
    source = source.replace('let video: VideoInfo\n', 'let video: VideoInfo\n  var prepared = 0\n', 1)
    source = source.replace('guard var frame = try next() else { return nil }', 'let limit = Int(ProcessInfo.processInfo.environment["TT_BENCH_LIMIT"] ?? "0")!\n    if limit > 0 && prepared >= limit { return nil }\n    guard var frame = try next() else { return nil }\n    prepared += 1', 1)
    source = source.replace('config.computeUnits = units', '''config.computeUnits = units
    if name == "BlurBall" {
      switch ProcessInfo.processInfo.environment["TT_BENCH_UNITS"] ?? "gpu" {
      case "all": config.computeUnits = .all
      case "ane": config.computeUnits = .cpuAndNeuralEngine
      default: config.computeUnits = .cpuAndGPU
      }
    }''')
    predict = source[source.index('  func predict('):source.index('  static func plane(')]
    asynchronous = predict.replace('func predict(', 'func predictAsync(').replace(') throws -> MLMultiArray', ') async throws -> MLMultiArray').replace('try model.prediction(from: provider)', 'try await model.prediction(from: provider)')
    source = source.replace('  static func plane(', asynchronous + '  static func plane(', 1)
    start, end = source.index('  func trajectories('), source.index('  func run() throws')
    trajectory = source[start:end]
    body_start = trajectory.index('    if let intervals {')
    pipeline = trajectory[:body_start]
    pipeline = pipeline.replace('func trajectories(', 'func trajectoriesPipelined(').replace(') throws -> [TrajectoryPoint]', ') async throws -> [TrajectoryPoint]')
    old = '''    func infer(_ frames: [PreparedFrame], channels: [Int], targets: [PreparedFrame]) throws {
      let output = try predictor.predict(
        frames.flatMap(\\.pixels), shape: [1, 9, roi.modelHeight, roi.modelWidth])'''
    assert old in pipeline
    pipeline = pipeline.replace(old, '    func consume(_ output: MLMultiArray, channels: [Int], targets: [PreparedFrame]) throws {')
    pipeline += PIPELINE + '  }\n'
    source = source[:end] + pipeline + source[end:]
    source = source.replace('  func run() throws {', '''  func run() async throws {
    let start = ProcessInfo.processInfo.systemUptime
    var diagnosticPoints: [TrajectoryPoint] = []
    var diagnosticFrames: [Int] = []
    defer {
      let elapsed = ProcessInfo.processInfo.systemUptime - start
      struct Diagnostic: Encodable { var seconds: Double; var points: [TrajectoryPoint]; var bounceFrames: [Int] }
      if let destination = ProcessInfo.processInfo.environment["TT_BENCH_RESULT"],
         let data = try? JSONEncoder().encode(Diagnostic(seconds: elapsed, points: diagnosticPoints, bounceFrames: diagnosticFrames)) {
        try? data.write(to: URL(fileURLWithPath: destination))
      }
    }''', 1)
    original = '''    var points = try trajectories(
      calibration: calibration, predictor: predictor,
      threshold: Float(request.mode == .twoStage ? request.stage1Confidence : request.confidence),
      intervals: nil)'''
    assert original in source
    source = source.replace(original, '''    var points: [TrajectoryPoint]
    if ProcessInfo.processInfo.environment["TT_BENCH_PREFETCH"] == "1" {
      guard request.mode == .full else { throw TTError("BENCHMARK_FULL_MODE_ONLY") }
      points = try await trajectoriesPipelined(calibration: calibration, predictor: predictor, threshold: Float(request.confidence), intervals: nil)
    } else {
      points = try trajectories(calibration: calibration, predictor: predictor, threshold: Float(request.mode == .twoStage ? request.stage1Confidence : request.confidence), intervals: nil)
    }''', 1)
    source = source.replace('    let set = Set(frames)', '    diagnosticPoints = points\n    diagnosticFrames = frames\n    let set = Set(frames)', 1)
    source = source.replace('  try Worker(request).run()', '  try await Worker(request).run()', 1)
    (worker / 'main.swift').write_text(source)
    (worker / 'PrefetchedFrames.swift').write_text('import Foundation\nimport TTcutCore\n' + QUEUE)
    subprocess.run(['swift', 'build', '--package-path', str(package), '-c', 'release', '--product', 'TTcutWorker'], check=True)


if __name__ == '__main__':
    main()

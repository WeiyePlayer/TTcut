import Foundation
import TTcutCore

public struct ProcessOutput: Sendable {
  public var stdout: Data
  public var stderr: String
  public var status: Int32
}

private final class ProcessControl: @unchecked Sendable {
  let lock = NSLock()
  var process: Process?
  var cancelled = false
  func install(_ process: Process) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !cancelled else { throw CancellationError() }
    self.process = process
    try process.run()
  }
  func cancel() {
    lock.lock()
    cancelled = true
    let active = process
    lock.unlock()
    if let active, active.isRunning {
      active.terminate()
      DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
        if active.isRunning { kill(active.processIdentifier, SIGKILL) }
      }
    }
  }
  func check() throws {
    lock.lock()
    defer { lock.unlock() }
    if cancelled { throw CancellationError() }
  }
}

public enum ProcessRunner {
  /// Drains both pipes concurrently; cancellation reaches the actual native process.
  public static func run(
    _ executable: URL, _ arguments: [String], input: Data? = nil, limit: Int = 32 * 1024 * 1024,
    onLine: (@Sendable (String) -> Void)? = nil, checkStatus: Bool = true
  ) async throws -> ProcessOutput {
    let control = ProcessControl()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            let process = Process()
            let stdout = Pipe()
            let stderr = Pipe()
            let stdin = Pipe()
            process.executableURL = executable
            process.arguments = arguments
            process.standardOutput = stdout
            process.standardError = stderr
            process.standardInput = stdin
            try control.install(process)
            let group = DispatchGroup()
            let capture = Capture()
            group.enter()
            DispatchQueue.global().async {
              var pending = Data()
              while let chunk = try? stdout.fileHandleForReading.read(upToCount: 65536),
                !chunk.isEmpty
              {
                if onLine == nil {
                  capture.lock.lock()
                  if capture.output.count + chunk.count <= limit {
                    capture.output.append(chunk)
                  } else {
                    capture.overflow = true
                  }
                  capture.lock.unlock()
                } else {
                  pending.append(chunk)
                  while let newline = pending.firstIndex(of: 10) {
                    onLine?(String(decoding: pending[..<newline], as: UTF8.self))
                    pending.removeSubrange(...newline)
                  }
                  if pending.count > limit {
                    capture.overflow = true
                    pending.removeAll()
                  }
                }
              }
              if !pending.isEmpty { onLine?(String(decoding: pending, as: UTF8.self)) }
              group.leave()
            }
            group.enter()
            DispatchQueue.global().async {
              while let chunk = try? stderr.fileHandleForReading.read(upToCount: 65536),
                !chunk.isEmpty
              {
                capture.lock.lock()
                capture.errors.append(chunk)
                if capture.errors.count > 65536 {
                  capture.errors.removeFirst(capture.errors.count - 65536)
                }
                capture.lock.unlock()
              }
              group.leave()
            }
            if let input { try? stdin.fileHandleForWriting.write(contentsOf: input) }
            try? stdin.fileHandleForWriting.close()
            process.waitUntilExit()
            group.wait()
            try control.check()
            if capture.overflow { throw TTError("PROCESS_OUTPUT_LIMIT") }
            let errors = String(decoding: capture.errors, as: UTF8.self)
            if checkStatus, process.terminationStatus != 0 {
              throw TTError("PROCESS_FAILED", "\(executable.lastPathComponent): \(errors)")
            }
            continuation.resume(
              returning: ProcessOutput(
                stdout: capture.output, stderr: errors, status: process.terminationStatus))
          } catch { continuation.resume(throwing: error) }
        }
      }
    } onCancel: {
      control.cancel()
    }
  }
  private final class Capture: @unchecked Sendable {
    let lock = NSLock()
    var output = Data()
    var errors = Data()
    var overflow = false
  }
}

public struct RuntimePaths: Sendable {
  public var ffmpeg: URL
  public var ffprobe: URL
  public var worker: URL
  public var models: URL
  public init(ffmpeg: URL, ffprobe: URL, worker: URL, models: URL) {
    self.ffmpeg = ffmpeg
    self.ffprobe = ffprobe
    self.worker = worker
    self.models = models
  }
  public static func bundled(in bundle: Bundle = .main) throws -> RuntimePaths {
    guard let resources = bundle.resourceURL else { throw TTError("BUNDLE_MISSING") }
    let bin = bundle.bundleURL.appendingPathComponent("Contents/Helpers")
    let paths = RuntimePaths(
      ffmpeg: bin.appendingPathComponent("ffmpeg"), ffprobe: bin.appendingPathComponent("ffprobe"),
      worker: bin.appendingPathComponent("TTcutWorker"),
      models: resources.appendingPathComponent("Models"))
    for path in [paths.ffmpeg, paths.ffprobe, paths.worker]
    where !FileManager.default.isExecutableFile(atPath: path.path) {
      throw TTError("BUNDLED_COMPONENT_MISSING", path.path)
    }
    return paths
  }
}

public enum AnalysisClient {
  private final class Events: @unchecked Sendable {
    let lock = NSLock()
    var terminals: [WorkerEvent] = []
    var malformed = false
  }
  public static func run(
    _ request: AnalysisRequest, paths: RuntimePaths,
    progress: @escaping @Sendable (WorkerEvent) -> Void
  ) async throws -> WorkerEvent {
    var input = try JSONEncoder().encode(request)
    input.append(10)
    let state = Events()
    let output = try await ProcessRunner.run(
      paths.worker, [], input: input,
      onLine: { line in
        state.lock.lock()
        defer { state.lock.unlock() }
        guard let event = try? JSONDecoder().decode(WorkerEvent.self, from: Data(line.utf8)),
          event.taskID == request.taskID
        else {
          state.malformed = true
          return
        }
        if event.type == "progress" {
          progress(event)
        } else if event.type == "result" || event.type == "error" {
          state.terminals.append(event)
        } else {
          state.malformed = true
        }
      }, checkStatus: false)
    guard !state.malformed, state.terminals.count == 1 else {
      throw TTError("WORKER_PROTOCOL_ERROR", output.stderr)
    }
    let event = state.terminals[0]
    if let error = event.error { throw error }
    guard event.type == "result", output.status == 0 else {
      throw TTError("WORKER_FAILED", output.stderr)
    }
    return event
  }
}

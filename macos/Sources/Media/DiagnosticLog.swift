import Foundation

public actor DiagnosticLog {
  public static let shared = DiagnosticLog()
  private let root: URL
  public init(root: URL? = nil) {
    self.root =
      root
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("TTcut/logs", isDirectory: true)
  }
  public func write(_ category: String, _ message: String) {
    do {
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      let file = root.appendingPathComponent("ttcut.log")
      if let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size])
        as? NSNumber, size.intValue > 2_000_000
      {
        for index in stride(from: 3, through: 1, by: -1) {
          let previous = root.appendingPathComponent(
            index == 1 ? "ttcut.log" : "ttcut.\(index-1).log")
          let target = root.appendingPathComponent("ttcut.\(index).log")
          try? FileManager.default.removeItem(at: target)
          if FileManager.default.fileExists(atPath: previous.path) {
            try FileManager.default.moveItem(at: previous, to: target)
          }
        }
      }
      if !FileManager.default.fileExists(atPath: file.path) {
        FileManager.default.createFile(atPath: file.path, contents: nil)
      }
      let text =
        "\(ISO8601DateFormatter().string(from:Date())) [\(category)] \(message.prefix(16384))\n"
      let handle = try FileHandle(forWritingTo: file)
      defer { try? handle.close() }
      try handle.seekToEnd()
      try handle.write(contentsOf: Data(text.utf8))
    } catch { /* Logging must never turn a successful operation into a failure. */  }
  }
}

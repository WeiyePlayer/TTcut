import CryptoKit
import Foundation

public struct HistoryEntry: Identifiable, Sendable {
  public var record: AnalysisResult
  public var coverURL: URL?
  public var status: SourceStatus
  public var id: String { record.id }
}

public actor HistoryStore {
  private var mediaLeases: [UUID: String] = [:]
  public let root: URL
  public let processingRoot: URL
  private var recordsURL: URL { root.appendingPathComponent("history/records", isDirectory: true) }
  private var coversURL: URL { root.appendingPathComponent("history/covers", isDirectory: true) }
  private var indexURL: URL { root.appendingPathComponent("history/index.json") }
  private struct Index: Codable {
    var schemaVersion = 1
    var ids: [String]
  }
  public init(root: URL? = nil) {
    self.root =
      root
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("TTcut", isDirectory: true)
    processingRoot = self.root.appendingPathComponent("processing-media/v1", isDirectory: true)
  }
  public static func atomicWrite<T: Encodable>(_ value: T, to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
    encoder.dateEncodingStrategy = .iso8601
    try encoder.encode(value).write(to: url, options: .atomic)
  }
  static func read<T: Decodable>(_ type: T.Type, from url: URL) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(type, from: Data(contentsOf: url))
  }
  private func recordURL(_ id: String) throws -> URL {
    guard UUID(uuidString: id) != nil else { throw TTError("INVALID_HISTORY_ID") }
    return recordsURL.appendingPathComponent(id + ".json")
  }
  public func settings() -> Settings {
    ((try? Self.read(Settings.self, from: root.appendingPathComponent("settings.json")))
      ?? Settings()).validated()
  }
  public func saveSettings(_ settings: Settings) throws {
    try Self.atomicWrite(settings.validated(), to: root.appendingPathComponent("settings.json"))
  }
  private func allRecords() throws -> [AnalysisResult] {
    try FileManager.default.createDirectory(at: recordsURL, withIntermediateDirectories: true)
    let paths = try FileManager.default.contentsOfDirectory(
      at: recordsURL, includingPropertiesForKeys: nil)
    var records: [AnalysisResult] = []
    for url in paths where url.pathExtension == "json" {
      if let value = try? Self.read(AnalysisResult.self, from: url), value.schemaVersion == 1,
        UUID(uuidString: value.id) != nil,
        value.id == url.deletingPathExtension().lastPathComponent,
        (try? value.video.validate()) != nil, (try? value.calibration.validate()) != nil
      {
        records.append(value)
      } else {
        let quarantine = root.appendingPathComponent("history/quarantine", isDirectory: true)
        try FileManager.default.createDirectory(at: quarantine, withIntermediateDirectories: true)
        try FileManager.default.moveItem(
          at: url,
          to: quarantine.appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent))
      }
    }
    return records.sorted { $0.createdAt > $1.createdAt }
  }
  private func rebuildIndex() throws {
    let records = try allRecords().filter(\.visibleInHistory)
    try Self.atomicWrite(Index(ids: records.map(\.id)), to: indexURL)
  }
  public func list() throws -> [HistoryEntry] {
    // The record files are the source of truth; an interrupted index write is recoverable.
    let records = try allRecords().filter(\.visibleInHistory)
    if (try? Self.read(Index.self, from: indexURL).ids) != records.map(\.id) { try rebuildIndex() }
    return records.map { record in
      let cover = coversURL.appendingPathComponent(record.id + ".jpg")
      var status = record.source.currentStatus
      if status == .available, record.processing.mode == .normalizedCFR,
        !FileManager.default.fileExists(atPath: record.processing.path)
      {
        status = .processingMissing
      }
      return HistoryEntry(
        record: record, coverURL: FileManager.default.fileExists(atPath: cover.path) ? cover : nil,
        status: status)
    }
  }
  public func open(_ id: String) throws -> AnalysisResult {
    let record = try Self.read(AnalysisResult.self, from: recordURL(id))
    guard record.schemaVersion == 1, record.id == id else {
      throw TTError("HISTORY_VERSION_UNSUPPORTED")
    }
    try record.video.validate()
    try record.calibration.validate()
    switch record.source.currentStatus {
    case .missing: throw TTError("SOURCE_MISSING", "原视频不存在 / Source video is missing")
    case .changed: throw TTError("SOURCE_CHANGED", "原视频已变化，请重新分析 / Source changed; analyze again")
    default: break
    }
    if record.processing.mode == .normalizedCFR,
      !FileManager.default.fileExists(atPath: record.processing.path)
    {
      throw TTError("PROCESSING_MEDIA_MISSING")
    }
    return record
  }
  public func save(_ record: AnalysisResult, cover: Data? = nil) throws {
    try Self.atomicWrite(record, to: recordURL(record.id))
    if let cover {
      try FileManager.default.createDirectory(at: coversURL, withIntermediateDirectories: true)
      try cover.write(to: coversURL.appendingPathComponent(record.id + ".jpg"), options: .atomic)
    }
    let previous = try allRecords().filter { $0.id != record.id && $0.source == record.source }
    for old in previous { try removeFiles(old) }
    try rebuildIndex()
    try cleanupUnreferencedMedia()
  }
  public func markExported(id: String, path: String?) throws {
    var record = try open(id)
    record.outputPath = path
    record.visibleInHistory = true
    try Self.atomicWrite(record, to: recordURL(id))
    try rebuildIndex()
  }
  public func setVisible(id: String) throws {
    var record = try open(id)
    record.visibleInHistory = true
    try Self.atomicWrite(record, to: recordURL(id))
    try rebuildIndex()
  }
  public func coverDestination(_ id: String) throws -> URL {
    _ = try recordURL(id)
    try FileManager.default.createDirectory(at: coversURL, withIntermediateDirectories: true)
    return coversURL.appendingPathComponent(id + ".jpg")
  }
  private func removeFiles(_ record: AnalysisResult) throws {
    try FileManager.default.removeItem(at: recordURL(record.id))
    try? FileManager.default.removeItem(at: coversURL.appendingPathComponent(record.id + ".jpg"))
  }
  public func delete(_ id: String) throws {
    let url = try recordURL(id)
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
    try? FileManager.default.removeItem(at: coversURL.appendingPathComponent(id + ".jpg"))
    try rebuildIndex()
    try cleanupUnreferencedMedia()
  }
  public func clear() throws {
    for record in try allRecords() where record.visibleInHistory { try removeFiles(record) }
    try rebuildIndex()
    try cleanupUnreferencedMedia()
  }
  public func cleanupUnreferencedMedia() throws {
    let references = Set(mediaLeases.values).union(
      try allRecords().compactMap {
        $0.processing.mode == .normalizedCFR ? $0.processing.cacheKey : nil
      })
    guard
      let folders = try? FileManager.default.contentsOfDirectory(
        at: processingRoot, includingPropertiesForKeys: [.isDirectoryKey])
    else { return }
    for folder in folders {
      let key = folder.lastPathComponent
      // Only our generated SHA256 cache directories are eligible; never follow arbitrary record paths.
      guard key.count == 64, key.allSatisfy({ $0.isHexDigit }), !references.contains(key) else {
        continue
      }
      try FileManager.default.removeItem(at: folder)
    }
  }
  public func retainMedia(_ media: ProcessingMedia) -> UUID? {
    guard media.mode == .normalizedCFR, let key = media.cacheKey else { return nil }
    let token = UUID()
    mediaLeases[token] = key
    return token
  }
  public func releaseMedia(_ token: UUID?) throws {
    if let token { mediaLeases.removeValue(forKey: token) }
    try cleanupUnreferencedMedia()
  }
  public static func cacheKey(identity: SourceIdentity, rate: String, encoder: String) throws
    -> String
  {
    let jsonEncoder = JSONEncoder()
    jsonEncoder.outputFormatting = [.sortedKeys]
    var data = try jsonEncoder.encode(identity)
    data.append(Data(("|" + rate + "|" + encoder + "|macos-fidelity-v1").utf8))
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
  }
}

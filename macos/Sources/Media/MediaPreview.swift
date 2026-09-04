import Foundation
import TTcutCore

public enum MediaPreview {
  /// A disposable display proxy. It never becomes analysis/export media or a history source.
  public static func make(
    video: VideoInfo, paths: RuntimePaths, progress: @escaping @Sendable (Double) -> Void = { _ in }
  ) async throws -> URL {
    let identity = try SourceIdentity(url: video.url)
    let key = try HistoryStore.cacheKey(
      identity: identity, rate: video.frameRate, encoder: "preview-sdr-v1")
    let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("TTcut/preview", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let final = root.appendingPathComponent(key + ".mp4")
    if FileManager.default.fileExists(atPath: final.path) { return final }
    let partial = root.appendingPathComponent(UUID().uuidString + ".partial.mp4")
    defer { try? FileManager.default.removeItem(at: partial) }
    try await render(video: video, paths: paths, destination: partial, progress: progress)
    guard identity.currentStatus == .available else { throw TTError("SOURCE_CHANGED") }
    try Task.checkCancellation()
    try FileManager.default.moveItem(at: partial, to: final)
    // Keep the current proxy and one recent predecessor; no source/history paths participate.
    let candidates =
      (try? FileManager.default.contentsOfDirectory(
        at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
    let ordered = candidates.filter {
      $0.pathExtension == "mp4" && $0.deletingPathExtension().lastPathComponent.count == 64
        && $0 != final
    }.sorted {
      ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
        ?? .distantPast)
        > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
          ?? .distantPast)
    }
    for old in ordered.dropFirst() { try? FileManager.default.removeItem(at: old) }
    return final
  }
  /// Caller-owned output, without a dependency on history or shared cache directories.
  public static func render(video: VideoInfo, paths: RuntimePaths, destination: URL,
    progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws {
    let tone =
      video.hdr == .sdr
      ? ""
      : "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,"
    let filter = tone + "scale=w=trunc(min(1920\\,iw*sar)/2)*2:h=trunc(ow/(iw*sar/ih)/2)*2,setsar=1"
    _ = try await ProcessRunner.run(
      paths.ffmpeg,
      [
        "-v", "error", "-nostdin", "-y", "-i", video.path, "-map", "0:v:0", "-map", "0:a:0?", "-vf",
        filter, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-threads", "2", "-c:a", "aac", "-ac", "2", "-color_primaries", "bt709", "-color_trc",
        "bt709", "-colorspace", "bt709", "-map_metadata", "-1", "-movflags", "+faststart",
        "-progress", "pipe:1", destination.path,
      ],
      onLine: { line in
        if line.hasPrefix("out_time_us="), let time = Double(line.dropFirst(12)) {
          progress(min(1, max(0, time / 1_000_000 / video.duration)))
        }
      })
    let result = try await MediaProbe(paths: paths).inspect(destination)
    guard
      abs(result.duration - video.duration) <= Segments.durationTolerance(segments: 1, video: video)
    else { throw TTError("PREVIEW_DURATION_MISMATCH") }
  }

}

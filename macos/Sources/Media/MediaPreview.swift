import Foundation
import TTcutCore

public enum MediaPreview {
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

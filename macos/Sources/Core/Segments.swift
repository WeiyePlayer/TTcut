import Foundation

public enum Segments {
  public static func union(_ ranges: [CutRange], epsilon: Double = 1e-9) -> [CutRange] {
    var result: [CutRange] = []
    for range in ranges.sorted(by: { $0.start < $1.start }) where range.end > range.start {
      if let last = result.last, range.start <= last.end + epsilon {
        result[result.count - 1].end = max(last.end, range.end)
        result[result.count - 1].clipIDs += range.clipIDs
      } else {
        result.append(range)
      }
    }
    return result
  }

  public static func refinement(_ rallies: [Rally], duration: Double) -> [CutRange] {
    union(rallies.map { CutRange(max(0, $0.start - 0.75), min(duration, $0.end + 0.75)) })
  }

  public static func durationTolerance(segments: Int, video: VideoInfo) -> Double {
    max(0.1, Double(2 * max(1, segments) + 1) * video.timingQuantum + 0.001)
  }

  public static func canCopy(_ ranges: [CutRange], video: VideoInfo) -> Bool {
    guard ranges.count == 1, !video.variableFrameRate, VideoInfo.ratio(video.videoTimeBase) > 0
    else { return false }
    let ends = [ranges[0].start, ranges[0].end]
    let tolerance = 1 / video.fps + 1e-6
    guard ends.allSatisfy({ end in video.keyframes.contains { abs($0 - end) <= tolerance } }) else {
      return false
    }
    return !video.hasAudio
      || (VideoInfo.ratio(video.audioTimeBase) > 0
        && ends.allSatisfy { end in video.audioBoundaries.contains { abs($0 - end) <= tolerance } })
  }
}

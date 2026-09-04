import Foundation

public enum Segments {
  public static func selected(_ rallies: [Rally], mode: CutMode, threshold: Int) throws -> [Rally] {
    var seen = Set<String>()
    let result = rallies.sorted { $0.start == $1.start ? $0.index < $1.index : $0.start < $1.start }
      .filter { seen.insert($0.id).inserted && (mode != .highlight || $0.bounceCount > threshold) }
    guard !result.isEmpty else {
      throw TTError(mode == .highlight ? "NO_HIGHLIGHTS" : "NO_RALLIES")
    }
    return result
  }
  public static func groups(_ rallies: [Rally], pre: Double, post: Double, duration: Double)
    -> [CutRange]
  {
    guard duration.isFinite, duration > 0, pre.isFinite, pre >= 0, post.isFinite, post >= 0 else {
      return []
    }
    var seen = Set<String>()
    let ordered = rallies.filter {
      seen.insert($0.id).inserted && $0.start.isFinite && $0.end.isFinite && $0.start >= 0
        && $0.end > $0.start
    }
    .sorted { $0.start == $1.start ? $0.index < $1.index : $0.start < $1.start }
    var raw: [CutRange] = []
    for rally in ordered {
      if let last = raw.last, rally.start - last.end < 5 - 1e-9 {
        raw[raw.count - 1].end = max(last.end, rally.end)
        raw[raw.count - 1].clipIDs.append(rally.id)
      } else {
        raw.append(CutRange(rally.start, rally.end, clipIDs: [rally.id]))
      }
    }
    return union(
      raw.map {
        CutRange(max(0, $0.start - pre), min(duration, $0.end + 1 + post), clipIDs: $0.clipIDs)
      })
  }
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

public enum Clips {
  static func rounded(_ value: Double) -> Double { (value * 1_000_000).rounded() / 1_000_000 }
  static func overlaps(_ a: CustomClip, _ b: CustomClip) -> Bool {
    a.start < b.end - 1e-6 && b.start < a.end - 1e-6
  }
  public static func reindex(_ clips: [CustomClip]) -> [CustomClip] {
    clips.sorted { a, b in
      a.start != b.start ? a.start < b.start : a.end != b.end ? a.end < b.end : a.id < b.id
    }
    .enumerated().map { index, clip in
      var copy = clip
      copy.index = index + 1
      return copy
    }
  }
  public static func bounceCount(start: Double, end: Double, times: [Double]?) -> Int? {
    times.map { $0.filter { $0.isFinite && $0 >= start && $0 < end }.count }
  }
  static func normalize(
    _ clips: [CustomClip], fps: Double, lower: Double = 0, upper: Double = .infinity
  ) -> [CustomClip] {
    var result = clips
    let selected = result.indices.filter { result[$0].selected }
    for (left, right) in zip(selected, selected.dropFirst())
    where result[left].end > result[right].start + 1e-6 {
      let boundary = rounded(
        max(
          max(lower, result[left].start + 1 / fps),
          min(min(upper, result[right].end - 1 / fps), (result[left].end + result[right].start) / 2)
        ))
      result[left].end = boundary
      result[right].start = boundary
    }
    return result
  }
  public static func draft(
    rallies: [Rally], pre: Double, post: Double, duration: Double, fps: Double
  ) -> [CustomClip] {
    let clips = rallies.map { rally -> CustomClip in
      let start = rounded(max(0, rally.start - pre))
      let end = max(
        rounded(min(duration, rally.end + 1 + post)), rounded(min(duration, start + 1 / fps)))
      return CustomClip(
        id: rally.id, sourceRallyID: rally.id, index: rally.index, bounceCount: rally.bounceCount,
        start: start, end: end)
    }
    return normalize(reindex(clips), fps: fps, upper: duration)
  }
  public static func addManual(
    _ clips: [CustomClip], at start: Double, duration: Double, bounceTimes: [Double]?,
    id: String = UUID().uuidString
  ) -> [CustomClip]? {
    let end = rounded(start + 1)
    guard start.isFinite, start >= 0, end <= duration + 1e-6,
      !clips.contains(where: { start < $0.end - 1e-6 && $0.start < end - 1e-6 })
    else { return nil }
    return reindex(
      clips + [
        CustomClip(
          id: id, sourceRallyID: nil, index: 0,
          bounceCount: bounceCount(start: start, end: end, times: bounceTimes), start: start,
          end: end)
      ])
  }
  public static func resize(
    _ clips: [CustomClip], id: String, startEdge: Bool, time: Double, duration: Double, fps: Double,
    bounceTimes: [Double]?
  ) -> [CustomClip] {
    var result = clips
    guard time.isFinite, let index = result.firstIndex(where: { $0.id == id }),
      result[index].selected
    else { return clips }
    let manual = result[index].isManual
    let before = result.prefix(index).last { manual || $0.selected }
    let after = result.dropFirst(index + 1).first { manual || $0.selected }
    if startEdge {
      result[index].start = rounded(max(before?.end ?? 0, min(result[index].end - 1 / fps, time)))
    } else {
      result[index].end = rounded(
        min(after?.start ?? duration, max(result[index].start + 1 / fps, time)))
    }
    if manual {
      result[index].bounceCount = bounceCount(
        start: result[index].start, end: result[index].end, times: bounceTimes)
    }
    return result
  }
  public static func setSelected(
    _ clips: [CustomClip], id: String, selected: Bool, duration: Double, fps: Double
  ) -> [CustomClip] {
    var next = clips
    guard let index = next.firstIndex(where: { $0.id == id }), next[index].selected != selected
    else { return next }
    next[index].selected = selected
    guard selected else { return next }
    let conflicts = next.indices.filter {
      $0 != index && next[$0].selected && overlaps(next[index], next[$0])
    }
    guard !conflicts.isEmpty else { return next }
    var first = min(index, conflicts.min()!)
    var last = max(index, conflicts.max()!)
    var expanded = true
    while expanded {
      expanded = false
      for i in next.indices where next[i].selected && (i < first || i > last) {
        let region = next[first...last]
        let start = region.map(\.defaultStart).min()!
        let end = region.map(\.defaultEnd).max()!
        if next[i].defaultStart < end - 1e-6 && start < next[i].defaultEnd - 1e-6 {
          first = min(first, i)
          last = max(last, i)
          expanded = true
        }
      }
    }
    let lower = next.prefix(first).last(where: \.selected)?.end ?? 0
    let upper = next.dropFirst(last + 1).first(where: \.selected)?.start ?? duration
    let region = normalize(
      next[first...last].filter(\.selected).map { clip in
        var copy = clip
        copy.start = max(lower, copy.defaultStart)
        copy.end = min(upper, copy.defaultEnd)
        return copy
      }, fps: fps, lower: lower, upper: upper)
    let rebuilt = Dictionary(uniqueKeysWithValues: region.map { ($0.id, $0) })
    return next.map { rebuilt[$0.id] ?? $0 }
  }
  public static func validate(
    _ clips: [CustomClip], rallies: [Rally], duration: Double, fps: Double
  ) throws -> [CustomClip] {
    let selected = clips.filter(\.selected)
    guard !selected.isEmpty else { throw TTError("NO_CUSTOM_SELECTION") }
    var ids = Set<String>()
    var rallyIDs = Set<String>()
    var previousEnd = -1.0
    var previousIndex = 0
    let allowed = Set(rallies.map(\.id))
    for clip in selected {
      guard !clip.id.isEmpty, ids.insert(clip.id).inserted, clip.start.isFinite, clip.end.isFinite,
        clip.start >= 0, clip.end <= duration, clip.end - clip.start + 1e-6 >= 1 / fps,
        clip.start >= previousEnd, clip.index > previousIndex
      else { throw TTError("INVALID_CUSTOM_SEGMENTS") }
      if let source = clip.sourceRallyID {
        guard allowed.contains(source), rallyIDs.insert(source).inserted else {
          throw TTError("INVALID_CUSTOM_SEGMENTS")
        }
      }
      previousEnd = clip.end
      previousIndex = clip.index
    }
    return selected
  }
}

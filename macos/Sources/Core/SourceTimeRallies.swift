import Foundation

public struct ObservedPause: Codable, Equatable, Sendable {
  public var start: Double
  public var end: Double
}

/// PR #115's decision clock, adapted to the native continuous-visibility detector.
/// Inference keeps every decoded observation. Only decisions are capped at 30 Hz;
/// selected observations retain their real timestamps, including missing detections.
public enum SourceTimeRallies {
  public static let version = 1
  public static let maximumClockHz = 30.0
  public static let pauseWindow = 0.5
  public static let pauseMinimum = 0.75
  public static let pauseMaximumGap = 0.1
  public static let pauseContext = 0.2
  public static let pauseMinimumSupport = 0.3
  public static let pauseMaximumSpeed = 0.35

  static func median(_ values: [Double]) -> Double {
    let sorted = values.sorted()
    guard !sorted.isEmpty else { return 1 / maximumClockHz }
    return (sorted[(sorted.count - 1) / 2] + sorted[sorted.count / 2]) / 2
  }

  static func clock(_ points: [TrajectoryPoint]) throws -> (
    points: [TrajectoryPoint], source: [TrajectoryPoint], hz: Double
  ) {
    let ordered = points.sorted { $0.frame < $1.frame }
    guard ordered.allSatisfy({ $0.frame >= 0 && $0.time.isFinite && $0.time >= 0 }),
      zip(ordered, ordered.dropFirst()).allSatisfy({ $1.frame > $0.frame && $1.time > $0.time })
    else { throw TTError("INVALID_RALLY_TIMEBASE") }
    let periods = zip(ordered, ordered.dropFirst()).map { $1.time - $0.time }
    var selected = ordered
    if !periods.isEmpty && median(periods) < 1 / maximumClockHz - 0.001 {
      // Double keys avoid converting an untrusted timestamp into an overflowing Int.
      var ticks: [Double: TrajectoryPoint] = [:]
      for point in ordered {
        let tick = floor(point.time * maximumClockHz + 0.5)
        guard tick.isFinite else { throw TTError("INVALID_RALLY_TIMEBASE") }
        if let previous = ticks[tick],
          abs(previous.time - tick / maximumClockHz) <= abs(point.time - tick / maximumClockHz)
        {
          continue
        }
        ticks[tick] = point
      }
      selected = ticks.keys.sorted().compactMap { ticks[$0] }
    }
    let cadence = median(zip(selected, selected.dropFirst()).map { $1.time - $0.time })
    let hz = min(maximumClockHz, (1 / cadence * 1_000_000).rounded() / 1_000_000)
    return (
      selected.enumerated().map { index, point in
        var copy = point
        copy.frame = index
        return copy
      }, selected, hz
    )
  }

  static func observedPauses(_ points: [TrajectoryPoint], config: VisibilityMotionConfig)
    -> [ObservedPause]
  {
    // End-on exchanges have little projected motion; do not infer inactivity there.
    guard !config.verticalExchangeEnabled else { return [] }
    let visible = points.filter(\.visible)
    var spans: [ObservedPause] = []
    var end = 0
    for (start, point) in visible.enumerated() {
      end = max(end, start)
      while end < visible.count && visible[end].time < point.time + pauseWindow - 0.001 { end += 1 }
      if end == visible.count { break }
      let window = Array(visible[start...end])
      var runs: [[TrajectoryPoint]] = []
      for sample in window {
        if let last = runs.last?.last, sample.frame == last.frame + 1 {
          runs[runs.count - 1].append(sample)
        } else {
          runs.append([sample])
        }
      }
      let flight = runs.contains { run in
        guard run.count >= 4, run.last!.time - run[0].time >= 0.1 - 0.001 else { return false }
        let xs = run.map(\.x)
        let ys = run.map(\.y)
        return xs.max()! - xs.min()! >= config.analysisWidthPixels * 0.15
          || ys.max()! - ys.min()! >= config.analysisHeightPixels * 0.15
      }
      let support = runs.reduce(0.0) { total, run in
        total
          + zip(run, run.dropFirst()).reduce(0.0) { sum, pair in
            let (a, b) = pair
            let dt = b.time - a.time
            let speed =
              hypot(
                (b.x - a.x) / config.analysisWidthPixels, (b.y - a.y) / config.analysisHeightPixels)
              / dt
            return sum + (speed <= pauseMaximumSpeed ? dt : 0)
          }
      }
      if flight || support < pauseMinimumSupport - 0.001
        || zip(window, window.dropFirst()).contains(where: {
          $1.time - $0.time > pauseMaximumGap + 0.001
        })
      {
        continue
      }
      if let last = spans.last, point.time <= last.end {
        spans[spans.count - 1].end = window.last!.time
      } else {
        spans.append(ObservedPause(start: point.time, end: window.last!.time))
      }
    }
    return spans.filter { $0.end - $0.start >= pauseMinimum - 0.001 }
      .map { ObservedPause(start: $0.start + pauseContext, end: $0.end - pauseContext) }
  }

  public static func detect(
    _ points: [TrajectoryPoint], calibration: Calibration, motionConfig: VisibilityMotionConfig
  )
    throws -> (rallies: [VisibilityRally], bounceTimes: [Double], pauses: [ObservedPause])
  {
    let clock = try clock(points)
    let candidates = try BlurBallVisibilityRallies.detect(
      clock.points, fps: clock.hz, calibration: calibration, motionConfig: motionConfig)
    let pauses = observedPauses(clock.points, config: motionConfig)
    let bounceFrames = Set(
      try BlurBallBoardCountDetector.detect(clock.points, calibration: calibration))
    let bounces = clock.points.filter { point in
      bounceFrames.contains(point.frame)
        && !pauses.contains { $0.start <= point.time && point.time < $0.end }
    }.map(\.time)
    var rallies: [VisibilityRally] = []
    for candidate in candidates {
      var pieces = [(candidate.startTime, candidate.endTime + 1e-9)]
      for pause in pauses {
        pieces = pieces.flatMap { start, end -> [(Double, Double)] in
          if pause.end <= start || pause.start >= end { return [(start, end)] }
          return [(start, min(end, pause.start)), (max(start, pause.end), end)].filter {
            $0.1 > $0.0
          }
        }
      }
      for (start, end) in pieces {
        let support = clock.points[candidate.startFrame...candidate.endFrame].filter {
          $0.visible && $0.time >= start && $0.time < end
        }
        guard let first = support.first, let last = support.last, last.time > first.time else {
          continue
        }
        // Native continuous visibility intentionally retains zero-board-count rallies.
        let previousPause = pauses.last { $0.end <= first.time }
        let leadIn = max(candidate.leadInStartTime ?? 0, previousPause?.end ?? 0)
        rallies.append(
          VisibilityRally(
            startFrame: clock.source[first.frame].frame, endFrame: clock.source[last.frame].frame,
            startTime: first.time, endTime: last.time,
            leadInStartTime: leadIn > 0 ? min(first.time, leadIn) : nil))
      }
    }
    return (rallies, bounces, pauses)
  }
}

import Foundation

public struct VisibilityRally: Codable, Equatable, Sendable {
  public var startFrame: Int
  public var endFrame: Int
  public var startTime: Double
  public var endTime: Double
  public var leadInStartTime: Double?

  public init(
    startFrame: Int, endFrame: Int, startTime: Double, endTime: Double,
    leadInStartTime: Double? = nil
  ) {
    self.startFrame = startFrame
    self.endFrame = endFrame
    self.startTime = startTime
    self.endTime = endTime
    self.leadInStartTime = leadInStartTime
  }
}

public struct VisibilityMotionConfig: Equatable, Sendable {
  public var analysisWidthPixels: Double
  public var analysisHeightPixels: Double
  public var verticalExchangeEnabled: Bool

  public init(
    analysisWidthPixels: Double, analysisHeightPixels: Double,
    verticalExchangeEnabled: Bool = false
  ) {
    self.analysisWidthPixels = analysisWidthPixels
    self.analysisHeightPixels = analysisHeightPixels
    self.verticalExchangeEnabled = verticalExchangeEnabled
  }
}

public enum VisibilityRallies {
  public static let startSeconds = 0.20
  public static let endSeconds = 0.50
  public static let confidenceThreshold = 0.30
  public static let minimumHorizontalExcursionRatio = 20.0 / 618.0
  public static let minimumVerticalExcursionRatio = 12.0 / 347.0
  public static let maximumReversalGapSeconds = 0.35
  public static let minimumHorizontalToVerticalRangeRatio = 0.70
  public static let maximumMonotonicVerticalReversals = 1
  public static let minimumMonotonicHorizontalRangeRatio = 200.0 / 618.0
  public static let minimumMonotonicDurationSeconds = 0.60
  public static let shortVerticalFilterSeconds = 1.20
  public static let maximumShortVerticalRangeRatio = 0.50
  public static let fragmentMergeSeconds = 1.50
  public static let fragmentMergeDisplacementRatio = 0.35
  public static let fragmentMergeSpeedRatioPerSecond = 0.26
  public static let endOnMinimumEdgeBalance = 0.85
  public static let endOnMinimumScreenAspectRatio = 2.0
  public static let minimumVerticalToHorizontalRangeRatio = 1.0

  public static func isEndOnTableView(_ points: [Point]) throws -> Bool {
    guard points.count == 4 else { throw TTError("INVALID_CALIBRATION") }
    let top = points[0].distance(to: points[1])
    let bottom = points[3].distance(to: points[2])
    let left = points[0].distance(to: points[3])
    let right = points[1].distance(to: points[2])
    let lengths = [top, bottom, left, right]
    guard lengths.allSatisfy({ $0.isFinite && $0 > 0 }) else { return false }
    let balance = min(top, bottom) / max(top, bottom)
    let aspect = (top + bottom) / (left + right)
    return balance >= endOnMinimumEdgeBalance && aspect >= endOnMinimumScreenAspectRatio
  }

  public static func detect(
    _ points: [TrajectoryPoint], fps: Double, startSeconds: Double = startSeconds,
    endSeconds: Double = endSeconds, motionConfig: VisibilityMotionConfig? = nil
  ) throws -> [VisibilityRally] {
    guard fps.isFinite && fps > 0 else { throw TTError("INVALID_VISIBILITY_FPS") }
    guard startSeconds.isFinite && startSeconds > 0 else {
      throw TTError("INVALID_VISIBILITY_START")
    }
    guard endSeconds.isFinite && endSeconds > 0 else {
      throw TTError("INVALID_VISIBILITY_END")
    }
    if let config = motionConfig {
      guard config.analysisWidthPixels.isFinite && config.analysisWidthPixels > 0,
        config.analysisHeightPixels.isFinite && config.analysisHeightPixels > 0
      else { throw TTError("INVALID_VISIBILITY_DIMENSIONS") }
    }

    let requiredVisible = max(2, Int(ceil(fps * startSeconds)))
    let requiredMissing = max(1, Int(ceil(fps * endSeconds)))
    let ordered = points.sorted {
      $0.frame == $1.frame ? $0.time < $1.time : $0.frame < $1.frame
    }
    try validate(ordered)

    var confirmed: [VisibilityRally] = []
    var candidateStart: TrajectoryPoint?
    var lastVisible: TrajectoryPoint?
    var visibleStreak = 0
    var missingStreak = 0
    var active = false

    func finishActive() -> VisibilityRally? {
      guard let start = candidateStart, let end = lastVisible, end.time > start.time else {
        return nil
      }
      return VisibilityRally(
        startFrame: start.frame, endFrame: end.frame, startTime: start.time, endTime: end.time)
    }

    for point in ordered {
      if !active {
        guard point.visible else {
          candidateStart = nil
          lastVisible = nil
          visibleStreak = 0
          continue
        }
        candidateStart = candidateStart ?? point
        lastVisible = point
        visibleStreak += 1
        if visibleStreak >= requiredVisible {
          active = true
          missingStreak = 0
        }
        continue
      }

      if point.visible {
        lastVisible = point
        missingStreak = 0
      } else {
        missingStreak += 1
        if missingStreak >= requiredMissing {
          if let rally = finishActive() { confirmed.append(rally) }
          active = false
          missingStreak = 0
          candidateStart = nil
          lastVisible = nil
          visibleStreak = 0
        }
      }
    }
    if active, let rally = finishActive() { confirmed.append(rally) }
    guard let config = motionConfig else { return confirmed }

    let frames = ordered.map(\.frame)
    var accepted: [(VisibilityRally, TrajectoryPoint, TrajectoryPoint)] = []
    for rally in confirmed {
      let segment = Array(ordered[lowerBound(frames, rally.startFrame)..<upperBound(frames, rally.endFrame)])
      guard isBallExchange(segment, fps: fps, config: config) else { continue }
      let visible = segment.filter(\.visible)
      guard let first = visible.first, let last = visible.last else { continue }
      accepted.append((rally, first, last))
    }

    var merged: [(VisibilityRally, TrajectoryPoint, TrajectoryPoint)] = []
    for item in accepted {
      if let prior = merged.last {
        let gap = item.0.startTime - prior.0.endTime
        let displacement = hypot(item.1.x - prior.2.x, item.1.y - prior.2.y)
        let speed = gap > 0 ? displacement / config.analysisWidthPixels / gap : .infinity
        if gap > 0 && gap <= fragmentMergeSeconds
          && displacement <= config.analysisWidthPixels * fragmentMergeDisplacementRatio
          && speed <= fragmentMergeSpeedRatioPerSecond
        {
          merged[merged.count - 1] = (
            VisibilityRally(
              startFrame: prior.0.startFrame, endFrame: item.0.endFrame,
              startTime: prior.0.startTime, endTime: item.0.endTime),
            prior.1, item.2)
          continue
        }
      }
      merged.append(item)
    }
    return merged.map(\.0)
  }

  static func isBallExchange(
    _ points: [TrajectoryPoint], fps: Double, config: VisibilityMotionConfig
  ) -> Bool {
    let visible = points.filter(\.visible)
    let horizontal = visible.map(\.x)
    let vertical = visible.map(\.y)
    let frames = visible.map(\.frame)
    let horizontalExcursion = analysisExcursion(config.analysisWidthPixels)
    let verticalExcursion = config.analysisHeightPixels * minimumVerticalExcursionRatio
    let maximumMissingFrames = Int(floor(fps * maximumReversalGapSeconds))
    let horizontalRange = valueRange(horizontal)
    let verticalRange = valueRange(vertical)
    let duration = visible.count >= 2 ? visible.last!.time - visible.first!.time : 0

    let robustExchange = significantReversals(medianSmooth(horizontal), horizontalExcursion) >= 1
      && runReversals(horizontal, frames, horizontalExcursion, maximumMissingFrames) >= 1
      && horizontalRange >= verticalRange * minimumHorizontalToVerticalRangeRatio
    let verticalExcursionThreshold = config.analysisHeightPixels * minimumHorizontalExcursionRatio
    let robustVerticalExchange = config.verticalExchangeEnabled
      && significantReversals(medianSmooth(vertical), verticalExcursionThreshold) >= 1
      && runReversals(vertical, frames, verticalExcursionThreshold, maximumMissingFrames) >= 1
      && verticalRange >= horizontalRange * minimumVerticalToHorizontalRangeRatio
    let monotonicCrossTable = significantReversals(vertical, verticalExcursion)
      <= maximumMonotonicVerticalReversals
      && horizontalRange >= config.analysisWidthPixels * minimumMonotonicHorizontalRangeRatio
    let qualifiedMonotonic = monotonicCrossTable && duration >= minimumMonotonicDurationSeconds
      && !(duration < shortVerticalFilterSeconds
        && verticalRange > config.analysisHeightPixels * maximumShortVerticalRangeRatio)
    return robustExchange || robustVerticalExchange || qualifiedMonotonic
  }

  static func analysisExcursion(_ width: Double) -> Double {
    width * minimumHorizontalExcursionRatio
  }

  static func medianSmooth(_ values: [Double], radius: Int = 2) -> [Double] {
    guard values.count >= 3 else { return values }
    let padded = Array(repeating: values[0], count: radius) + values
      + Array(repeating: values.last!, count: radius)
    let width = radius * 2 + 1
    return values.indices.map { median(Array(padded[$0..<($0 + width)])) }
  }

  static func meanSmooth(_ values: [Double], radius: Int = 2) -> [Double] {
    guard values.count >= 3 else { return values }
    let padded = Array(repeating: values[0], count: radius) + values
      + Array(repeating: values.last!, count: radius)
    let width = radius * 2 + 1
    return values.indices.map {
      padded[$0..<($0 + width)].reduce(0, +) / Double(width)
    }
  }

  static func significantReversals(_ values: [Double], _ minimumExcursion: Double) -> Int {
    guard values.count >= 3 else { return 0 }
    let smoothed = meanSmooth(values)
    let anchor = smoothed[0]
    var extreme = anchor
    var direction = 0
    var reversals = 0
    for value in smoothed.dropFirst() {
      if direction == 0 {
        let delta = value - anchor
        if abs(delta) >= minimumExcursion {
          direction = delta > 0 ? 1 : -1
          extreme = value
        }
      } else if direction > 0 {
        if value > extreme {
          extreme = value
        } else if extreme - value >= minimumExcursion {
          reversals += 1
          direction = -1
          extreme = value
        }
      } else if value < extreme {
        extreme = value
      } else if value - extreme >= minimumExcursion {
        reversals += 1
        direction = 1
        extreme = value
      }
    }
    return reversals
  }

  static func runReversals(
    _ values: [Double], _ frames: [Int], _ minimumExcursion: Double,
    _ maximumMissingFrames: Int
  ) -> Int {
    guard !values.isEmpty else { return 0 }
    var total = 0
    var runStart = 0
    for index in 1...values.count {
      if index == values.count || frames[index] - frames[index - 1] - 1 > maximumMissingFrames {
        total += significantReversals(Array(values[runStart..<index]), minimumExcursion)
        runStart = index
      }
    }
    return total
  }

  static func valueRange(_ values: [Double]) -> Double {
    guard let minimum = values.min(), let maximum = values.max() else { return 0 }
    return maximum - minimum
  }

  static func lowerBound(_ values: [Int], _ target: Int) -> Int {
    var low = 0
    var high = values.count
    while low < high {
      let middle = (low + high) / 2
      if values[middle] < target { low = middle + 1 } else { high = middle }
    }
    return low
  }

  static func upperBound(_ values: [Int], _ target: Int) -> Int {
    var low = 0
    var high = values.count
    while low < high {
      let middle = (low + high) / 2
      if values[middle] <= target { low = middle + 1 } else { high = middle }
    }
    return low
  }

  private static func median(_ values: [Double]) -> Double {
    let ordered = values.sorted()
    let middle = ordered.count / 2
    return ordered.count.isMultiple(of: 2)
      ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle]
  }

  private static func validate(_ points: [TrajectoryPoint]) throws {
    guard points.allSatisfy({ $0.time.isFinite }) else {
      throw TTError("INVALID_VISIBILITY_POINTS")
    }
    guard zip(points, points.dropFirst()).allSatisfy({
      $0.frame < $1.frame && $0.time < $1.time
    }) else { throw TTError("INVALID_VISIBILITY_POINT_ORDER") }
  }
}

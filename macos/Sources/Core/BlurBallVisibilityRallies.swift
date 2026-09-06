import Foundation

public enum BlurBallVisibilityRallies {
  struct TableProjection: Sendable {
    let homography: Homography

    init(calibration: Calibration) throws {
      let source = calibration.points.map {
        Point(Double(Float($0.x)), Double(Float($0.y)))
      }
      let target = [Point(0, 0), Point(274, 0), Point(274, 152.5), Point(0, 152.5)].map {
        Point(Double(Float($0.x)), Double(Float($0.y)))
      }
      homography = try Homography(from: source, to: target)
    }

    func apply(_ point: Point) -> Point {
      let mapped = homography.apply(
        Point(Double(Float(point.x)), Double(Float(point.y))))
      return Point(Double(Float(mapped.x)), Double(Float(mapped.y)))
    }
  }

  public static let minimumCandidateSeconds = 1.0
  public static let maximumCandidateSeconds = 6.0
  public static let maximumExpandedTableRatio = 0.45
  public static let minimumVisibleRunCount = 3
  public static let minimumOneWayRangeRatio = 0.55
  public static let maximumSparseVisibilityRatio = 0.30
  public static let minimumContiguousFlightSeconds = 0.15
  public static let minimumCoherentReversalRatio = 0.20
  public static let minimumCoherentFlightDisplacementRatio = 0.15
  public static let expandedTableLengthMargin = 35.0
  public static let expandedTableWidthMargin = 25.0
  public static let minimumSpeedRatioPerSecond = 0.35
  public static let reversalRangeRatio = 0.06
  public static let gapMinimumRangeRatio = 0.04
  public static let gapMinimumSupportRatio = 0.35
  public static let runMinimumSeconds = 0.15
  public static let runMinimumHorizontalRangeRatio = 0.05
  public static let clusterShortGapSeconds = 1.25
  public static let clusterLongGapSeconds = 2.25
  public static let monotonicPauseSeconds = 2.0
  public static let minimumStationaryRunSeconds = 0.50
  public static let boundaryContextSeconds = 0.25
  public static let slowTransferMinimumSeconds = 0.85
  public static let slowTransferMinimumDisplacementRatio = 0.30
  public static let slowTransferMaximumSpeedRatio = 0.85
  public static let slowTransferFastFlightSpeedRatio = 1.0
  public static let timestampToleranceSeconds = 0.001

  public static func detect(
    _ points: [TrajectoryPoint], fps: Double, calibration: Calibration,
    motionConfig: VisibilityMotionConfig
  ) throws -> [VisibilityRally] {
    let base = try VisibilityRallies.detect(points, fps: fps, motionConfig: motionConfig)
    guard !base.isEmpty, !motionConfig.verticalExchangeEnabled else { return base }
    let projection = try TableProjection(calibration: calibration)
    let ordered = points.sorted { $0.frame < $1.frame }
    let frames = ordered.map(\.frame)

    var passEnds: [Double] = []
    for candidate in try VisibilityRallies.detect(ordered, fps: fps) {
      let observed = slice(
        ordered, frames,
        candidate.startFrame - Int(ceil(fps * VisibilityRallies.startSeconds)),
        candidate.endFrame)
      if !slowTransferRuns(observed, projection: projection, config: motionConfig).isEmpty {
        passEnds.append(candidate.endTime)
      }
    }

    var accepted: [VisibilityRally] = []
    for rally in base {
      let segment = slice(ordered, frames, rally.startFrame, rally.endFrame)
      if isInterRallyFragment(rally, segment, projection: projection, config: motionConfig) {
        continue
      }
      accepted += refineMotionCandidate(
        rally, segment, fps: fps, projection: projection, config: motionConfig)
    }

    var refined: [VisibilityRally] = []
    var lastRejected: VisibilityRally?
    for original in accepted {
      var rally = original
      if rally.endTime - rally.startTime < 0.6 { continue }
      let prefixFrames = Int(ceil(fps * VisibilityRallies.startSeconds))
      let segment = slice(ordered, frames, rally.startFrame - prefixFrames, rally.endFrame)
      if !slowTransferRuns(segment, projection: projection, config: motionConfig).isEmpty {
        lastRejected = rally
        continue
      }

      let preceding = slice(ordered, frames, rally.startFrame - Int(ceil(fps * 3)), rally.startFrame - 1)
        .filter {
          $0.time >= rally.startTime - 3 && (refined.last == nil || $0.time > refined.last!.endTime)
        }
      let transfers = slowTransferRuns(preceding, projection: projection, config: motionConfig)
      if let transfer = transfers.last,
        rally.startTime - transfer.last!.time <= clusterShortGapSeconds
      {
        let boundary = transfer.last!.time + 1 / fps
        rally.leadInStartTime = max(
          rally.leadInStartTime ?? 0, min(rally.startTime, boundary))
      }
      if let rejected = lastRejected,
        rally.startTime - rejected.endTime >= 0,
        rally.startTime - rejected.endTime <= 3
      {
        let boundary = min(rally.startTime, rejected.endTime + 1 / fps)
        rally.leadInStartTime = max(rally.leadInStartTime ?? 0, boundary)
      }
      let previousPass = upperBound(passEnds, rally.startTime) - 1
      if previousPass >= 0 && rally.startTime - passEnds[previousPass] <= 3 {
        let boundary = min(rally.startTime, passEnds[previousPass] + 1 / fps)
        rally.leadInStartTime = max(rally.leadInStartTime ?? 0, boundary)
      }
      rally = trimReturnedBallPrefix(rally, ordered, config: motionConfig, fps: fps)
      if hasInsufficientFlightMotion(
        rally, ordered, calibration: calibration, projection: projection, config: motionConfig)
      {
        lastRejected = rally
      } else {
        refined.append(rally)
      }
    }
    return refined
  }

  static func hasInsufficientFlightMotion(
    _ rally: VisibilityRally, _ points: [TrajectoryPoint], calibration: Calibration,
    projection: TableProjection, config: VisibilityMotionConfig
  ) -> Bool {
    let runs = contiguousVisibleRuns(points.filter {
      $0.visible && rally.startTime <= $0.time && $0.time <= rally.endTime
    })
    let width = config.analysisWidthPixels
    let height = config.analysisHeightPixels
    let flights = runs.filter {
      duration($0) + 1e-9 >= 0.1 && xRange($0) >= width * 0.15
    }
    let weakFlights = runs.filter {
      duration($0) + timestampToleranceSeconds >= 0.1 && xRange($0) >= width * 0.04
    }
    let maximumRange = runs.filter { duration($0) + 1e-9 >= 0.1 }.map(xRange).max() ?? 0
    let rallyDuration = rally.endTime - rally.startTime
    if flights.isEmpty && weakFlights.count < 2 && rallyDuration < 6
      && maximumRange < width * 0.08
    {
      return true
    }
    if flights.count == 1 && rallyDuration < 1.2 {
      let flight = flights[0]
      if duration(flight) <= 0.35
        && (flight.map(\.y).max() ?? .infinity)
          < (calibration.points.map(\.y).min() ?? -.infinity) - height * 0.05
      {
        return true
      }
    }
    if flights.count >= 2 && rallyDuration < 3 {
      let direction = flights[0].last!.x - flights[0][0].x
      if flights.allSatisfy({
        motionReversals($0, width: width) == 0 && yRange($0) > height * 0.3
          && ($0.last!.x - $0[0].x) * direction > 0
      }) {
        return true
      }
    }
    return false
  }

  static func trimReturnedBallPrefix(
    _ original: VisibilityRally, _ points: [TrajectoryPoint], config: VisibilityMotionConfig,
    fps: Double
  ) -> VisibilityRally {
    var rally = original
    let visible = points.filter {
      $0.visible && rally.startTime <= $0.time && $0.time <= rally.endTime
    }
    let runs = contiguousVisibleRuns(visible)
    let width = config.analysisWidthPixels
    let height = config.analysisHeightPixels
    for toss in runs {
      if toss[0].time - rally.startTime < 1.5 { continue }
      guard duration(toss) >= 0.2,
        toss[0].y - (toss.map(\.y).min() ?? toss[0].y) >= height * 0.35,
        xRange(toss) <= width * 0.08
      else { continue }
      let priorFlights = runs.filter {
        $0.last!.time < toss[0].time && duration($0) >= 0.1 && xRange($0) >= width * 0.15
      }
      guard priorFlights.count == 1 else { continue }
      let arc = priorFlights[0]
      guard duration(arc) >= 0.4 && duration(arc) <= 1.2,
        motionReversals(arc, width: width) == 0,
        yRange(arc) >= height * 0.4,
        toss[0].time - arc.last!.time >= 1
      else { continue }
      guard runs.contains(where: {
        $0[0].time > toss[0].time && $0[0].time - toss.last!.time < 1
          && xRange($0) > width * 0.3
      }) else { continue }
      let prefix = runs.filter {
        arc.last!.time <= $0.last!.time && $0.last!.time < toss[0].time && duration($0) >= 0.1
      }
      guard let floor = prefix.map({ $0.last!.time }).max() else { continue }
      rally.startFrame = toss[0].frame
      rally.startTime = toss[0].time
      rally.leadInStartTime = max(
        rally.leadInStartTime ?? 0, min(toss[0].time, floor + 1 / fps))
      return rally
    }
    return rally
  }

  static func transferObservationRuns(
    _ visible: [TrajectoryPoint], width: Double
  ) -> [[TrajectoryPoint]] {
    var groups: [[TrajectoryPoint]] = []
    for run in contiguousVisibleRuns(visible) {
      if let prior = groups.last,
        run[0].time - prior.last!.time <= 0.1 + 1e-9,
        abs(run[0].x - prior.last!.x) <= width * 0.2,
        (run.last!.x - run[0].x) * (prior.last!.x - prior[0].x) >= 0
      {
        groups[groups.count - 1] += run
      } else {
        groups.append(run)
      }
    }
    return groups
  }

  static func slowTransferRuns(
    _ points: [TrajectoryPoint], projection: TableProjection, config: VisibilityMotionConfig
  ) -> [[TrajectoryPoint]] {
    let width = config.analysisWidthPixels
    let runs = transferObservationRuns(points.filter(\.visible), width: width).filter {
      duration($0) + 1e-9 >= 0.1
    }
    var slow: [[TrajectoryPoint]] = []
    for run in runs {
      let elapsed = duration(run)
      let displacement = abs(run.last!.x - run[0].x) / width
      let span = xRange(run) / width
      if motionReversals(run, width: width) > 0 { return [] }
      if span >= 0.15 && span / elapsed >= slowTransferFastFlightSpeedRatio { return [] }
      if displacement >= 0.30 && tableActivityRatios(run, projection: projection).1 >= 0.60 {
        return []
      }
      let sampleSeconds = zip(run, run.dropFirst()).compactMap {
        $1.time > $0.time ? $1.time - $0.time : nil
      }.min() ?? 0
      if elapsed + sampleSeconds >= slowTransferMinimumSeconds
        && displacement >= slowTransferMinimumDisplacementRatio
        && span / elapsed < slowTransferMaximumSpeedRatio
      {
        slow.append(run)
      }
    }
    if let lastSlow = slow.last,
      runs.contains(where: {
        $0[0].time - lastSlow.last!.time > clusterShortGapSeconds
          && duration($0) >= runMinimumSeconds && xRange($0) >= width * 0.15
      })
    {
      return []
    }
    if slow.count == 1 {
      let flight = slow[0]
      if runs.contains(where: {
        let gap = $0[0].time - flight.last!.time
        return gap >= 0 && gap <= 0.5 && duration($0) <= 0.75
          && abs($0.last!.x - $0[0].x) >= width * 0.30
          && ($0.last!.x - $0[0].x) * (flight.last!.x - flight[0].x) < 0
      }) {
        return []
      }
    }
    return slow
  }

  static func trimSlowRunTail(
    _ run: [TrajectoryPoint], fps: Double, config: VisibilityMotionConfig
  ) -> ([TrajectoryPoint], Bool) {
    guard duration(run) >= 0.5 else { return (run, false) }
    let xs = VisibilityRallies.medianSmooth(run.map(\.x))
    let ys = VisibilityRallies.medianSmooth(run.map(\.y))
    let step = max(1, Int((fps * 0.1).rounded(.toNearestOrEven)))
    var active: [Int] = []
    if run.count > step {
      for index in 0..<(run.count - step) {
        let elapsed = run[index + step].time - run[index].time
        let speed = hypot(
          (xs[index + step] - xs[index]) / config.analysisWidthPixels,
          (ys[index + step] - ys[index]) / config.analysisHeightPixels) / elapsed
        if speed >= minimumSpeedRatioPerSecond { active += [index, index + step] }
      }
    }
    guard let first = active.min(), let last = active.max() else { return (run, false) }
    let context = Int((fps * 0.1).rounded(.toNearestOrEven))
    let start = max(0, first - context)
    let end = min(run.count - 1, last + context)
    return (Array(run[start...end]), run.last!.time - run[end].time >= 0.4)
  }

  static func motionReversals(_ run: [TrajectoryPoint], width: Double) -> Int {
    VisibilityRallies.significantReversals(
      VisibilityRallies.medianSmooth(run.map(\.x)), width * reversalRangeRatio)
  }

  static func motionRunsHaveRallyBreak(
    _ previous: [TrajectoryPoint], _ current: [TrajectoryPoint], points: [TrajectoryPoint],
    frames: [Int], width: Double, height requestedHeight: Double? = nil
  ) -> Bool {
    let height = requestedHeight ?? width
    let elapsed = current[0].time - previous.last!.time
    if elapsed < clusterShortGapSeconds { return false }
    let start = VisibilityRallies.upperBound(frames, previous.last!.frame)
    let end = VisibilityRallies.lowerBound(frames, current[0].frame)
    let gap = start <= end ? Array(points[start..<end]) : []
    let runs = contiguousVisibleRuns(gap.filter(\.visible))
    let moving = runs.filter {
      duration($0) >= runMinimumSeconds && xRange($0) >= width * gapMinimumRangeRatio
    }
    let support = moving.map(duration).reduce(0, +) / elapsed
    if moving.count >= 3 && support >= gapMinimumSupportRatio { return false }
    let stationary = runs.contains {
      duration($0) >= minimumStationaryRunSeconds
        && xRange($0) < width * gapMinimumRangeRatio
        && yRange($0) < height * gapMinimumRangeRatio
    }
    let vertical = runs.filter {
      duration($0) + 1e-9 >= 0.1 && yRange($0) >= height * 0.15
    }
    if !stationary && elapsed <= 3 && vertical.count >= 2
      && vertical.map(duration).reduce(0, +) / elapsed >= 0.15
    {
      return false
    }
    let previousDuration = duration(previous)
    let monotonicPause = elapsed >= monotonicPauseSeconds && previousDuration >= 0.6
      && motionReversals(previous, width: width) == 0
      && yRange(previous) >= height * 0.15
      && xRange(previous) / width / previousDuration < 1.0
    return elapsed >= clusterLongGapSeconds || stationary || monotonicPause
  }

  static func hasRhythmicExchange(_ runs: [[TrajectoryPoint]], width: Double) -> Bool {
    for run in runs {
      let reversals = motionReversals(run, width: width)
      if reversals > 0 && duration(run) / Double(reversals + 1) <= 1 { return true }
    }
    let directions = runs.compactMap { run -> Double? in
      let displacement = run.last!.x - run[0].x
      return abs(displacement) >= width * 0.08 && duration(run) <= 1 ? displacement : nil
    }
    return zip(directions, directions.dropFirst()).contains { $0 * $1 < 0 }
  }

  static func refineMotionCandidate(
    _ rally: VisibilityRally, _ points: [TrajectoryPoint], fps: Double,
    projection: TableProjection, config: VisibilityMotionConfig
  ) -> [VisibilityRally] {
    let width = config.analysisWidthPixels
    let visible = points.filter(\.visible)
    var evidence: [[TrajectoryPoint]] = []
    var transfers: [[TrajectoryPoint]] = []
    for original in contiguousVisibleRuns(visible) {
      let (run, trimmedTail) = trimSlowRunTail(original, fps: fps, config: config)
      if trimmedTail { transfers.append(original.filter { $0.frame >= run.last!.frame }) }
      if duration(run) < runMinimumSeconds || xRange(run) < width * runMinimumHorizontalRangeRatio {
        continue
      }
      let strict = tableActivityRatios(run, projection: projection).0
      if duration(run) >= 1 && strict >= 0.90 && motionReversals(run, width: width) == 0 {
        transfers.append(run)
      } else {
        evidence.append(run)
      }
    }
    if evidence.isEmpty {
      let runs = contiguousVisibleRuns(visible)
      let shortFlights = runs.filter {
        duration($0) + 1e-9 >= 0.1 && xRange($0) >= width * 0.08
      }
      let verticalFlight = runs.contains {
        duration($0) >= runMinimumSeconds && yRange($0) >= config.analysisHeightPixels * 0.15
      }
      let tableFlight = shortFlights.contains {
        tableActivityRatios($0, projection: projection).1 >= 0.6
      }
      return rally.endTime - rally.startTime > 3 || shortFlights.count >= 2
        || verticalFlight || tableFlight ? [rally] : []
    }

    let strong = evidence.filter { xRange($0) >= width * 0.15 }
    var isolated: [[TrajectoryPoint]] = []
    for (index, run) in strong.enumerated() {
      let before = index > 0 ? run[0].time - strong[index - 1].last!.time : .infinity
      let after = index + 1 < strong.count ? strong[index + 1][0].time - run.last!.time : .infinity
      if strong.count > 1 && motionReversals(run, width: width) == 0
        && before >= 1.5 - timestampToleranceSeconds
        && after >= 1.5 - timestampToleranceSeconds
      {
        let prefix = points.filter { run[0].time - 0.2 <= $0.time && $0.time <= run.last!.time }
        if (before < 1.5 || after < 1.5)
          && slowTransferRuns(prefix, projection: projection, config: config).isEmpty
        {
          continue
        }
        if duration(run) >= 0.9
          || !slowTransferRuns(prefix, projection: projection, config: config).isEmpty
        {
          isolated.append(run)
        }
      }
    }
    if !isolated.isEmpty {
      evidence = evidence.filter { run in
        !isolated.contains { transfer in
          transfer[0].time - 0.25 <= run[0].time
            && run.last!.time <= transfer.last!.time + 0.25
        }
      }
      transfers += isolated
    }
    if evidence.isEmpty { return [] }

    let frames = points.map(\.frame)
    var groups: [[[TrajectoryPoint]]] = []
    for run in evidence {
      if groups.isEmpty || motionRunsHaveRallyBreak(
        groups.last!.last!, run, points: points, frames: frames, width: width,
        height: config.analysisHeightPixels)
      {
        groups.append([run])
      } else {
        groups[groups.count - 1].append(run)
      }
    }
    if groups.count == 1 && transfers.isEmpty && rally.endTime - rally.startTime < 5 {
      return [rally]
    }

    var accepted: [VisibilityRally] = []
    let context = Int((fps * boundaryContextSeconds).rounded(.toNearestOrEven))
    for (index, group) in groups.enumerated() {
      let first = group[0][0]
      let last = group.last!.last!
      let nearby = contiguousVisibleRuns(visible.filter {
        first.time - 0.5 <= $0.time && $0.time <= last.time + 0.25
      })
      let fastShortFlight = last.time - first.time < 1.5 && nearby.contains {
        duration($0) + 1e-9 >= 0.1 && xRange($0) / width / duration($0) >= 0.9
      }
      if groups.count > 1 && !fastShortFlight && !hasRhythmicExchange(group, width: width) {
        continue
      }
      var start = max(rally.startFrame, first.frame - context)
      var end = min(rally.endFrame, last.frame + context)
      if index == 0 && first.time - rally.startTime < clusterShortGapSeconds {
        start = rally.startFrame
      }
      if index == groups.count - 1 && rally.endTime - last.time < clusterShortGapSeconds
        && !transfers.contains(where: { $0[0].time >= last.time })
      {
        end = rally.endFrame
      }
      let segment = slice(points, frames, start, end)
      let observed = segment.filter(\.visible)
      guard let observedFirst = observed.first, let observedLast = observed.last,
        observedLast.time - observedFirst.time >= 0.6
      else { continue }
      let leadIn = transfers.compactMap { transfer -> Double? in
        let gap = observedFirst.time - transfer.last!.time
        return gap > 0 && gap <= 3 ? min(observedFirst.time, transfer.last!.time + 1 / fps) : nil
      }.max()
      let candidate = VisibilityRally(
        startFrame: observedFirst.frame, endFrame: observedLast.frame,
        startTime: observedFirst.time, endTime: observedLast.time,
        leadInStartTime: leadIn)
      if VisibilityRallies.isBallExchange(segment, fps: fps, config: config)
        && !isInterRallyFragment(candidate, segment, projection: projection, config: config)
      {
        accepted.append(candidate)
      }
    }
    let sparseGroups = groups.count > 1 && groups.allSatisfy {
      $0.last!.last!.time - $0[0][0].time < 0.6
    }
    if accepted.isEmpty && transfers.isEmpty
      && (rally.endTime - rally.startTime < 4 || sparseGroups)
    {
      return [rally]
    }
    return accepted
  }

  static func tableActivityRatios(
    _ visible: [TrajectoryPoint], projection: TableProjection
  ) -> (Double, Double) {
    guard !visible.isEmpty else { return (0, 0) }
    let coordinates = visible.map { projection.apply($0.position) }
    let strict = Double(coordinates.filter {
      $0.x >= 0 && $0.x <= 274 && $0.y >= 0 && $0.y <= 152.5
    }.count) / Double(visible.count)
    let expanded = Double(coordinates.filter {
      $0.x >= -expandedTableLengthMargin && $0.x <= 274 + expandedTableLengthMargin
        && $0.y >= -expandedTableWidthMargin && $0.y <= 152.5 + expandedTableWidthMargin
    }.count) / Double(visible.count)
    return (strict, expanded)
  }

  static func isInterRallyFragment(
    _ rally: VisibilityRally, _ points: [TrajectoryPoint], projection: TableProjection,
    config: VisibilityMotionConfig
  ) -> Bool {
    let candidateDuration = rally.endTime - rally.startTime
    if candidateDuration + 1e-9 < minimumCandidateSeconds
      || candidateDuration - 1e-9 > maximumCandidateSeconds
    {
      return false
    }
    let visible = points.filter(\.visible)
    guard !visible.isEmpty else { return false }
    let runs = contiguousVisibleRuns(visible)
    if runs.count < minimumVisibleRunCount { return false }
    let expandedRatio = tableActivityRatios(visible, projection: projection).1
    if expandedRatio >= maximumExpandedTableRatio { return false }
    if hasCoherentHorizontalExchange(runs, width: config.analysisWidthPixels)
      || runs.contains(where: {
        duration($0) >= 0.1 && duration($0) <= 0.75
          && VisibilityRallies.significantReversals(
            VisibilityRallies.medianSmooth($0.map(\.x)), config.analysisWidthPixels * 0.12) >= 1
      })
    {
      return false
    }
    let maximumRangeRatio = runs.filter {
      duration($0) + 1e-9 >= minimumContiguousFlightSeconds
    }.map { xRange($0) / config.analysisWidthPixels }.max() ?? 0
    let visibilityRatio = Double(visible.count) / Double(visible.last!.frame - visible[0].frame + 1)
    return maximumRangeRatio + 1e-9 >= minimumOneWayRangeRatio
      || visibilityRatio < maximumSparseVisibilityRatio
  }

  static func contiguousVisibleRuns(_ visible: [TrajectoryPoint]) -> [[TrajectoryPoint]] {
    guard !visible.isEmpty else { return [] }
    var runs: [[TrajectoryPoint]] = []
    var start = 0
    for index in 1...visible.count {
      if index == visible.count || visible[index].frame != visible[index - 1].frame + 1 {
        runs.append(Array(visible[start..<index]))
        start = index
      }
    }
    return runs
  }

  static func hasCoherentHorizontalExchange(
    _ runs: [[TrajectoryPoint]], width: Double
  ) -> Bool {
    let excursion = width * minimumCoherentReversalRatio
    if runs.contains(where: {
      VisibilityRallies.significantReversals(
        VisibilityRallies.medianSmooth($0.map(\.x)), excursion) >= 1
    }) {
      return true
    }
    let directions = runs.compactMap { run -> Int? in
      let elapsed = duration(run)
      let displacement = run.last!.x - run[0].x
      if (elapsed + 1e-9 >= minimumContiguousFlightSeconds
        && abs(displacement) + 1e-9 >= width * minimumCoherentFlightDisplacementRatio)
        || (elapsed + 1e-9 >= 0.1 && abs(displacement) >= width * 0.2)
      {
        return displacement > 0 ? 1 : -1
      }
      return nil
    }
    return zip(directions, directions.dropFirst()).contains { $0 != $1 }
  }

  private static func slice(
    _ points: [TrajectoryPoint], _ frames: [Int], _ start: Int, _ end: Int
  ) -> [TrajectoryPoint] {
    guard start <= end else { return [] }
    return Array(points[
      VisibilityRallies.lowerBound(frames, start)..<VisibilityRallies.upperBound(frames, end)
    ])
  }

  private static func upperBound(_ values: [Double], _ target: Double) -> Int {
    var low = 0
    var high = values.count
    while low < high {
      let middle = (low + high) / 2
      if values[middle] <= target { low = middle + 1 } else { high = middle }
    }
    return low
  }

  private static func duration(_ points: [TrajectoryPoint]) -> Double {
    guard let first = points.first, let last = points.last else { return 0 }
    return last.time - first.time
  }

  private static func xRange(_ points: [TrajectoryPoint]) -> Double {
    VisibilityRallies.valueRange(points.map(\.x))
  }

  private static func yRange(_ points: [TrajectoryPoint]) -> Double {
    VisibilityRallies.valueRange(points.map(\.y))
  }
}

import Foundation

/// Direct port of the baseline's BlurBall trajectory-change detector.
public enum BounceDetector {
  struct Candidate {
    var point: TrajectoryPoint
    var score: Double
    var kind: String
    var before: Point?
    var after: Point?
  }
  static func median(_ values: [Double]) -> Double {
    let v = values.sorted()
    let n = v.count
    return n % 2 == 0 ? (v[n / 2 - 1] + v[n / 2]) / 2 : v[n / 2]
  }
  static func usable(_ points: [TrajectoryPoint]) -> Bool {
    !points.isEmpty && points.allSatisfy { $0.time.isFinite }
      && zip(points, points.dropFirst()).allSatisfy { $0.frame < $1.frame && $0.time < $1.time }
  }
  static func velocity(_ points: [TrajectoryPoint]) -> Point? {
    guard points.count >= 2, usable(points),
      zip(points, points.dropFirst()).allSatisfy({ $1.frame - $0.frame - 1 <= 2 })
    else { return nil }
    var xs: [Double] = []
    var ys: [Double] = []
    for i in points.indices {
      for j in (i + 1)..<points.count {
        let delta = Double(points[j].frame - points[i].frame)
        xs.append((points[j].x - points[i].x) / delta)
        ys.append((points[j].y - points[i].y) / delta)
      }
    }
    return Point(median(xs), median(ys))
  }
  static func sse(_ points: [TrajectoryPoint]) -> Double? {
    guard points.count >= 2, usable(points) else { return nil }
    let frames = points.map { Double($0.frame) }
    let mean = frames.reduce(0, +) / Double(frames.count)
    let denominator = frames.reduce(0) { $0 + pow($1 - mean, 2) }
    guard denominator > 0 else { return nil }
    var total = 0.0
    for values in [points.map(\.x), points.map(\.y)] {
      let average = values.reduce(0, +) / Double(values.count)
      let slope =
        zip(frames, values).reduce(0) { $0 + ($1.0 - mean) * ($1.1 - average) } / denominator
      let intercept = average - slope * mean
      total += zip(frames, values).reduce(0) { $0 + pow($1.1 - (slope * $1.0 + intercept), 2) }
    }
    return total
  }
  static func fitGain(_ before: [TrajectoryPoint], _ after: [TrajectoryPoint]) -> Double {
    var seen = Set<TrajectoryPoint>()
    let combined = (before + after).filter { seen.insert($0).inserted }
    guard let whole = sse(combined), let a = sse(before), let b = sse(after) else { return 0 }
    return max(0, whole - a - b)
  }
  static func segments(_ points: [TrajectoryPoint]) -> [[TrajectoryPoint]] {
    var result: [[TrajectoryPoint]] = []
    for p in points where p.visible && p.time.isFinite {
      if let last = result.last?.last, p.frame > last.frame, p.time > last.time,
        p.frame - last.frame - 1 <= 2
      {
        result[result.count - 1].append(p)
      } else {
        result.append([p])
      }
    }
    return result
  }
  public static func detect(
    _ points: [TrajectoryPoint], calibration: Calibration, minimumInterval: Double = 0.315
  ) throws -> [Int] {
    guard minimumInterval.isFinite, minimumInterval >= 0 else {
      throw TTError("INVALID_BOUNCE_INTERVAL")
    }
    let mapping = try Homography(
      from: calibration.points,
      to: [Point(0, 0), Point(274, 0), Point(274, 152.5), Point(0, 152.5)])
    func landing(_ point: TrajectoryPoint) -> Point? {
      let p = mapping.apply(point.position)
      return p.x >= -35 && p.x <= 309 && p.y >= -25 && p.y <= 177.5 ? p : nil
    }
    let ordered = points.sorted { $0.frame == $1.frame ? $0.time < $1.time : $0.frame < $1.frame }
    var candidates: [Int: Candidate] = [:]
    func add(_ candidate: Candidate) {
      if candidates[candidate.point.frame] == nil
        || candidate.score > candidates[candidate.point.frame]!.score
      {
        candidates[candidate.point.frame] = candidate
      }
    }
    for (index, p) in ordered.enumerated() where p.visible && p.time.isFinite {
      var before = Array(ordered[max(0, index - 5)...index]).filter {
        $0.visible && p.frame - $0.frame <= 5
      }
      var after = Array(ordered[index..<min(ordered.count, index + 6)]).filter {
        $0.visible && $0.frame - p.frame <= 5
      }
      if let gap = Array(zip(before, before.dropFirst()).enumerated()).last(where: {
        $0.element.1.frame - $0.element.0.frame - 1 > 2
      }) {
        before = Array(before.dropFirst(gap.offset + 1))
      }
      if let gap = zip(after, after.dropFirst()).enumerated().first(where: {
        $0.element.1.frame - $0.element.0.frame - 1 > 2
      }) {
        after = Array(after.prefix(gap.offset + 1))
      }
      guard before.count >= 2, after.count >= 2, after.first?.frame == p.frame, landing(p) != nil,
        let bv = velocity(before), let av = velocity(after)
      else { continue }
      let bs = hypot(bv.x, bv.y)
      let aspeed = hypot(av.x, av.y)
      let vertical = abs(bv.x) <= 3.5 && abs(av.x) <= 3.5
      let slowApproach = bs >= 1 && p.confidence >= 10 && vertical
      guard aspeed >= 2, bs >= 2.5 || slowApproach else { continue }
      let cosine = (bv.x * av.x + bv.y * av.y) / (bs * aspeed)
      let slowDeparture = aspeed < 2.5 && p.confidence >= 15 && cosine >= 0.15
      guard aspeed >= 2.5 || slowDeparture, vertical || aspeed <= bs * 2, cosine >= 0.15 || vertical
      else { continue }
      let turn = bv.y - av.y
      let change = turn + 0.25 * abs(bv.x - av.x)
      guard bv.y >= (-5),
        (bv.y <= 0 && turn >= 4 && change >= 4) || (bv.y >= 0 && turn >= 6 && change >= 7.4)
      else { continue }
      let penalty = 0.5 * Double(max(0, 6 - before.count) + max(0, 6 - after.count))
      add(
        Candidate(
          point: p, score: change + 0.2 * sqrt(fitGain(before, after)) - penalty, kind: "two-sided",
          before: bv, after: av))
    }
    let visibleSegments = segments(ordered)
    for (index, segment) in visibleSegments.enumerated() where segment.count >= 4 {
      let first = segment[0]
      let last = segment.last!
      if index == 0 || first.frame - visibleSegments[index - 1].last!.frame > 6,
        let v = velocity(Array(segment.prefix(4))), let t = landing(first),
        min(abs(t.y), abs(152.5 - t.y)) <= 35, abs(v.x) >= 6, v.y <= (-0.75)
      {
        add(
          Candidate(
            point: first, score: 4 + abs(v.y) + 0.05 * max(0, first.confidence), kind: "track-birth"
          ))
      }
      if index + 1 == visibleSegments.count || visibleSegments[index + 1][0].frame - last.frame > 6,
        let v = velocity(Array(segment.suffix(4))), let t = landing(last),
        min(abs(t.y), abs(152.5 - t.y)) <= 35, t.x >= 0, t.x <= 274, t.y >= 0, t.y <= 152.5,
        abs(v.x) >= 6, v.y >= 0.75
      {
        add(
          Candidate(
            point: last, score: 4 + abs(v.y) + 0.05 * max(0, last.confidence), kind: "track-death"))
      }
    }
    for (previous, next) in zip(visibleSegments, visibleSegments.dropFirst()) {
      guard next[0].frame - previous.last!.frame - 1 == 3,
        let bv = velocity(Array(previous.suffix(4))), let av = velocity(Array(next.prefix(4)))
      else { continue }
      let bs = hypot(bv.x, bv.y)
      let aspeed = hypot(av.x, av.y)
      guard bs >= 2.5, aspeed >= 2.5, av.y <= (-0.75),
        (bv.x * av.x + bv.y * av.y) / (bs * aspeed) >= 0.15
      else { continue }
      let turn = bv.y - av.y
      let change = turn + 0.25 * abs(bv.x - av.x)
      guard (bv.y <= 0 && turn >= 4 && change >= 4) || (bv.y >= 0 && turn >= 6 && change >= 7.4)
      else { continue }
      let edge = [previous.last!, next[0]].compactMap { p -> (Double, TrajectoryPoint)? in
        guard let t = landing(p) else { return nil }
        let distance = min(abs(t.x), abs(274 - t.x))
        return distance <= 45 ? (distance, p) : nil
      }.sorted { $0.0 == $1.0 ? $0.1.confidence > $1.1.confidence : $0.0 < $1.0 }
      if let p = edge.first?.1 {
        add(
          Candidate(
            point: p, score: change + 0.05 * max(0, p.confidence), kind: "short-gap", before: bv,
            after: av))
      }
    }
    let sorted = candidates.values.sorted { a, b in
      a.score != b.score
        ? a.score > b.score
        : a.point.time != b.point.time ? a.point.time < b.point.time : a.point.frame < b.point.frame
    }
    var selected: [Candidate] = []
    for candidate in sorted
    where selected.allSatisfy({
      abs(candidate.point.time - $0.point.time) > min(minimumInterval, 0.2)
    }) { selected.append(candidate) }
    var kept: [Candidate] = []
    for c in selected.sorted(by: {
      $0.point.time == $1.point.time
        ? $0.point.frame < $1.point.frame : $0.point.time < $1.point.time
    }) {
      let nearby = kept.contains {
        let delta = c.point.time - $0.point.time
        return delta >= 0.15 && delta <= 0.35
          && c.point.position.distance(to: $0.point.position) <= 30
      }
      if nearby, let a = c.after, let b = c.before {
        let aspeed = hypot(a.x, a.y)
        let bs = hypot(b.x, b.y)
        if a.y > 0 || (aspeed > bs * 2 && aspeed - bs > 5) { continue }
      }
      kept.append(c)
    }
    return kept.map { $0.point.frame }
  }
}

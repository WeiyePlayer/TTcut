import Foundation

public struct TablePeakCandidate: Sendable {
  public var point: Point
  public var activation: Double

  public init(point: Point, activation: Double) {
    self.point = point
    self.activation = activation
  }
}

public struct TableCandidateSample: Sendable {
  public var label: String
  /// Candidate peaks for each of the table model's thirteen heatmap channels.
  public var candidates: [[TablePeakCandidate]]

  public init(label: String, candidates: [[TablePeakCandidate]]) {
    self.label = label
    self.candidates = candidates
  }
}

public struct TableConsensusResult: Sendable {
  public var calibration: Calibration
  public var semanticSupport: Int
  public var score: Double
  public var cornerCandidateCounts: [Int]
}

public enum TableAggregation {
  static let semanticCornerIndices = [4, 5, 1, 0]
  static let planarKeypointIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12]
  static let tableKeypoints = [
    Point(-137, 76.25), Point(-137, -76.25), Point(0, 76.25), Point(0, -76.25),
    Point(137, 76.25), Point(137, -76.25), Point(0, 91.5), Point(0, -91.5),
    Point(0, 0), Point(0, 0), Point(0, 0), Point(-137, 0), Point(137, 0),
  ]
  static let peakClusterRadiusRatio = 0.025
  static let peakClusterLimit = 8
  static let geometricSigmaRatio = 0.018
  static let geometricMaximumDistanceRatio = 0.04
  static let minimumGeometricSupport = 10
  static let minimumGeometricScore = 5.5

  struct PeakCluster: Sendable {
    var point: Point
    var support: Int
    var meanActivation: Double
  }

  static func median(_ values: [Double]) -> Double {
    let sorted = values.sorted()
    let middle = sorted.count / 2
    return sorted.count.isMultiple(of: 2)
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle]
  }

  static func stableClusters(
    _ samples: [TableCandidateSample], pointIndex: Int, diagonal: Double
  ) -> [PeakCluster] {
    let radius = diagonal * peakClusterRadiusRatio
    let perSample = samples.map { sample in
      sample.candidates.indices.contains(pointIndex)
        ? sample.candidates[pointIndex].filter {
          $0.point.x.isFinite && $0.point.y.isFinite && $0.activation.isFinite
            && $0.activation >= 0.15
        }
        : []
    }
    let seeds = perSample.flatMap { $0 }
    guard !seeds.isEmpty else { return [] }

    var clusters: [PeakCluster] = []
    for seed in seeds {
      var selected: [TablePeakCandidate] = []
      for candidates in perSample {
        let matches = candidates.filter { $0.point.distance(to: seed.point) <= radius }
        if let best = matches.enumerated().max(by: { left, right in
          let leftDistance = left.element.point.distance(to: seed.point)
          let rightDistance = right.element.point.distance(to: seed.point)
          let leftScore = left.element.activation - leftDistance / radius * 0.15
          let rightScore = right.element.activation - rightDistance / radius * 0.15
          return leftScore == rightScore ? left.offset > right.offset : leftScore < rightScore
        })?.element {
          selected.append(best)
        }
      }
      guard selected.count >= 2 else { continue }
      clusters.append(
        PeakCluster(
          point: Point(median(selected.map(\.point.x)), median(selected.map(\.point.y))),
          support: selected.count,
          meanActivation: selected.reduce(0) { $0 + $1.activation } / Double(selected.count)))
    }

    clusters.sort {
      if $0.support != $1.support { return $0.support > $1.support }
      if $0.meanActivation != $1.meanActivation { return $0.meanActivation > $1.meanActivation }
      if $0.point.x != $1.point.x { return $0.point.x < $1.point.x }
      return $0.point.y < $1.point.y
    }
    var kept: [PeakCluster] = []
    for cluster in clusters {
      if kept.contains(where: { cluster.point.distance(to: $0.point) < radius * 0.6 }) {
        continue
      }
      kept.append(cluster)
      if kept.count == peakClusterLimit { break }
    }
    return kept
  }

  static func validCornerCandidate(_ corners: [Point], width: Int, height: Int) -> Calibration? {
    let calibration = Calibration(width: width, height: height, points: corners)
    guard (try? calibration.validate()) != nil else { return nil }
    let farEdge = corners[0].distance(to: corners[1])
    let closeEdge = corners[3].distance(to: corners[2])
    guard farEdge <= closeEdge * 1.35 else { return nil }
    return calibration
  }

  static func score(
    _ transform: Homography, clusters: [Int: [PeakCluster]], diagonal: Double,
    sampleCount: Int
  ) -> (score: Double, support: Int) {
    let sigma = diagonal * geometricSigmaRatio
    let maximumDistance = diagonal * geometricMaximumDistanceRatio
    var score = 0.0
    var support = 0
    for pointIndex in planarKeypointIndices {
      let projected = transform.apply(tableKeypoints[pointIndex])
      guard projected.x.isFinite, projected.y.isFinite,
        let options = clusters[pointIndex], !options.isEmpty
      else { continue }
      let ranked = options.map { option -> (value: Double, distance: Double) in
        let distance = projected.distance(to: option.point)
        let activation = min(1.2, max(0, option.meanActivation))
        let quality = Double(option.support) / Double(sampleCount) * (0.7 + 0.3 * activation / 1.2)
        return (quality * exp(-0.5 * pow(distance / sigma, 2)), distance)
      }
      let best = ranked.max { $0.value < $1.value }!
      score += best.value
      if best.distance <= maximumDistance { support += 1 }
    }
    return (score, support)
  }

  public static func calibration(
    _ samples: [TableCandidateSample], width: Int, height: Int
  ) throws -> TableConsensusResult {
    let expectedLabels = (1...11).map { String(format: "sample_%02d", $0) }
    guard samples.count == 11, width > 0, height > 0,
      samples.map(\.label) == expectedLabels,
      samples.allSatisfy({ $0.candidates.count == 13 })
    else { throw TTError("AUTO_CALIBRATION_FAILED") }
    let diagonal = hypot(Double(width), Double(height))
    let clusters = Dictionary(uniqueKeysWithValues: planarKeypointIndices.map {
      ($0, stableClusters(samples, pointIndex: $0, diagonal: diagonal))
    })
    let cornerClusters = semanticCornerIndices.map { clusters[$0] ?? [] }
    guard cornerClusters.allSatisfy({ !$0.isEmpty }) else {
      throw TTError(
        "AUTO_CALIBRATION_FAILED",
        "未找到所有球桌角点的稳定候选，请手动标定 / Manual calibration required")
    }

    var best: (score: Double, support: Int, calibration: Calibration)?
    for first in cornerClusters[0] {
      for second in cornerClusters[1] {
        for third in cornerClusters[2] {
          for fourth in cornerClusters[3] {
            let corners = [first.point, second.point, third.point, fourth.point]
            guard let calibration = validCornerCandidate(corners, width: width, height: height),
              let transform = try? Homography(
                from: semanticCornerIndices.map { tableKeypoints[$0] }, to: corners)
            else { continue }
            let candidate = score(
              transform, clusters: clusters, diagonal: diagonal, sampleCount: samples.count)
            guard candidate.support >= minimumGeometricSupport else { continue }
            if best == nil || candidate.score > best!.score
              || (candidate.score == best!.score && candidate.support > best!.support)
            {
              best = (candidate.score, candidate.support, calibration)
            }
          }
        }
      }
    }
    guard let best, best.score >= minimumGeometricScore else {
      throw TTError(
        "AUTO_CALIBRATION_FAILED",
        "未找到一致的球桌几何结构，请手动标定 / Manual calibration required")
    }
    return TableConsensusResult(
      calibration: best.calibration, semanticSupport: best.support, score: best.score,
      cornerCandidateCounts: cornerClusters.map(\.count))
  }
}

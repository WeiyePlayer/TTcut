import Foundation

public struct Homography: Sendable {
  public var values: [Double]
  public init(from: [Point], to: [Point]) throws {
    guard from.count == 4, to.count == 4 else { throw TTError("INVALID_CALIBRATION") }
    var rows = [[Double]]()
    for (p, q) in zip(from, to) {
      rows.append([p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y, q.x])
      rows.append([0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y, q.y])
    }
    for col in 0..<8 {
      let pivot = (col..<8).max { abs(rows[$0][col]) < abs(rows[$1][col]) }!
      guard abs(rows[pivot][col]) > 1e-12 else { throw TTError("DEGENERATE_CALIBRATION") }
      rows.swapAt(col, pivot)
      let scale = rows[col][col]
      for i in col...8 { rows[col][i] /= scale }
      for row in 0..<8 where row != col {
        let factor = rows[row][col]
        for i in col...8 { rows[row][i] -= factor * rows[col][i] }
      }
    }
    values = rows.map { $0[8] } + [1]
  }
  public func apply(_ point: Point) -> Point {
    let h = values
    let scale = h[6] * point.x + h[7] * point.y + h[8]
    return Point(
      (h[0] * point.x + h[1] * point.y + h[2]) / scale,
      (h[3] * point.x + h[4] * point.y + h[5]) / scale)
  }
}

public struct AnalysisROI: Codable, Sendable {
  public var x: Int
  public var y: Int
  public var width: Int
  public var height: Int
  public var modelWidth: Int
  public var modelHeight: Int
  public init(calibration: Calibration) throws {
    try calibration.validate()
    let table = [Point(0, 0), Point(274, 0), Point(274, 152.5), Point(0, 152.5)]
    let transform = try Homography(from: table, to: calibration.points)
    let expanded = [Point(-35, -25), Point(309, -25), Point(309, 177.5), Point(-35, 177.5)].map(
      transform.apply)
    let edge = max(
      calibration.points[0].distance(to: calibration.points[1]),
      calibration.points[2].distance(to: calibration.points[3]))
    x = max(0, min(calibration.width, Int(floor(expanded.map(\.x).min()!))))
    y = max(0, min(calibration.height, Int(floor(expanded.map(\.y).min()! - 0.5 * edge))))
    let right = max(0, min(calibration.width, Int(ceil(expanded.map(\.x).max()!))))
    let bottom = max(0, min(calibration.height, Int(ceil(expanded.map(\.y).max()!))))
    width = right - x
    height = bottom - y
    guard width > 0, height > 0 else { throw TTError("INVALID_ANALYSIS_ROI") }
    func stride(_ size: Double) -> Int { max(8, Int(ceil(ceil(size / 8) * 8 * 1.25 / 8)) * 8) }
    modelWidth = stride(Double(width) * 512 / Double(calibration.width))
    modelHeight = stride(Double(height) * 288 / Double(calibration.height))
  }
}

public struct TrajectoryPoint: Codable, Hashable, Sendable {
  public var frame: Int
  public var time: Double
  public var x: Double
  public var y: Double
  public var confidence: Double
  public var visible: Bool
  public init(
    frame: Int, time: Double, x: Double = 0, y: Double = 0, confidence: Double = 0,
    visible: Bool = false
  ) {
    self.frame = frame
    self.time = time
    self.x = x
    self.y = y
    self.confidence = confidence
    self.visible = visible
  }
  public var position: Point { Point(x, y) }
}

public enum RallyGrouping {
  public static func group(bounceFrames: [Int], points: [TrajectoryPoint], maximumGap: Double = 3)
    -> [Rally]
  {
    let byFrame = Dictionary(
      points.map { ($0.frame, $0) }, uniquingKeysWith: { _, latest in latest })
    let bounces = Set(bounceFrames).compactMap { byFrame[$0] }.sorted {
      $0.time == $1.time ? $0.frame < $1.frame : $0.time < $1.time
    }
    var groups: [[TrajectoryPoint]] = []
    var current: [TrajectoryPoint] = []
    for bounce in bounces {
      if let last = current.last, bounce.time - last.time > maximumGap {
        if current.count >= 2 { groups.append(current) }
        current = []
      }
      current.append(bounce)
    }
    if current.count >= 2 { groups.append(current) }
    return groups.enumerated().map { index, group in
      Rally(
        id: "rally-\(index+1)-\(group[0].frame)", index: index + 1, start: group[0].time,
        end: group.last!.time,
        bounceCount: group.count, startFrame: group[0].frame, endFrame: group.last!.frame)
    }
  }
}

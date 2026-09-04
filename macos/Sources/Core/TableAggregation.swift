import Foundation

public enum TableAggregation {
  public static func ordered(_ points: [Point]) -> [Point] {
    guard points.count == 4 else { return points }
    let vertical = points.enumerated().sorted {
      $0.element.y == $1.element.y ? $0.offset < $1.offset : $0.element.y < $1.element.y
    }.map(\.element)
    let top = vertical.prefix(2).sorted { $0.x < $1.x }
    let bottom = vertical.suffix(2).sorted { $0.x < $1.x }
    return [top[0], top[1], bottom[1], bottom[0]]
  }
  public static func calibration(_ samples: [TableSample], width: Int, height: Int) throws
    -> Calibration
  {
    let corners = [0, 1, 4, 5]
    let valid = samples.filter { sample in
      guard sample.points.count == 13, corners.allSatisfy({ sample.points[$0].valid }) else {
        return false
      }
      let calibration = Calibration(
        width: width, height: height, points: ordered(corners.map { sample.points[$0].position }))
      return (try? calibration.validate()) != nil
    }
    guard valid.count >= 2 else {
      throw TTError("AUTO_CALIBRATION_FAILED", "未找到两个一致的球桌样本，请手动标定 / Manual calibration required")
    }
    var best: (score: Double, first: Int, second: Int)?
    for i in valid.indices {
      for j in (i + 1)..<valid.count {
        let a = ordered(corners.map { valid[i].points[$0].position })
        let b = ordered(corners.map { valid[j].points[$0].position })
        let score = zip(a, b).reduce(0.0) { $0 + $1.0.distance(to: $1.1) }
        if best == nil || score < best!.score { best = (score, i, j) }
      }
    }
    let pair = best!
    let points = corners.map { index -> Point in
      let a = valid[pair.first].points[index].position
      let b = valid[pair.second].points[index].position
      return Point((a.x + b.x) / 2, (a.y + b.y) / 2)
    }
    let result = Calibration(width: width, height: height, points: ordered(points))
    do { try result.validate() } catch {
      throw TTError("AUTO_CALIBRATION_FAILED", "球桌样本无法形成有效标定，请手动标定 / Manual calibration required")
    }
    return result
  }
}

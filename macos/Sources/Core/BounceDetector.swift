import Foundation

/// Compatibility facade for the legacy bounce-event rally path.
/// Continuous-visibility board counts call `BlurBallBoardCountDetector` directly.
public enum BounceDetector {
  public static func detect(
    _ points: [TrajectoryPoint], calibration: Calibration, minimumInterval: Double = 0.315
  ) throws -> [Int] {
    try BlurBallBoardCountDetector.detect(
      points, calibration: calibration, minimumInterval: minimumInterval)
  }
}

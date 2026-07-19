import type { Calibration } from '../shared/contracts';

export type CalibrationIssue = 'out_of_bounds' | 'overlap' | 'not_convex' | 'area_too_small' | 'wrong_order';

export function validateCalibration(calibration: Calibration): CalibrationIssue | null {
  const { video_width: width, video_height: height } = calibration;
  const points = [
    calibration.points.top_left,
    calibration.points.top_right,
    calibration.points.bottom_right,
    calibration.points.bottom_left,
  ];
  if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height)) {
    return 'out_of_bounds';
  }

  const minimumDistance = Math.max(3, Math.hypot(width, height) * 0.005);
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      const a = points[first]!;
      const b = points[second]!;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < minimumDistance) return 'overlap';
    }
  }

  const crosses = points.map((current, index) => {
    const next = points[(index + 1) % points.length]!;
    const after = points[(index + 2) % points.length]!;
    return (next[0] - current[0]) * (after[1] - next[1]) - (next[1] - current[1]) * (after[0] - next[0]);
  });
  if (crosses.some((value) => Math.abs(value) < 1e-6)
    || !(crosses.every((value) => value > 0) || crosses.every((value) => value < 0))) {
    return 'not_convex';
  }

  const twiceArea = Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0));
  if (twiceArea / 2 < width * height * 0.001) return 'area_too_small';

  const [topLeft, topRight, bottomRight, bottomLeft] = points;
  const topY = (topLeft![1] + topRight![1]) / 2;
  const bottomY = (bottomLeft![1] + bottomRight![1]) / 2;
  const leftX = (topLeft![0] + bottomLeft![0]) / 2;
  const rightX = (topRight![0] + bottomRight![0]) / 2;
  if (topY >= bottomY || leftX >= rightX) return 'wrong_order';
  return null;
}

import type { Calibration } from '../shared/contracts';

export type CalibrationPoint = [number, number];
export type CalibrationIssue = 'out_of_bounds' | 'overlap' | 'not_convex' | 'area_too_small';

export function orderCalibrationPolygon(points: CalibrationPoint[]): CalibrationPoint[] {
  if (points.length < 3) return [...points];
  const center = points.reduce(
    (sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length] as CalibrationPoint,
    [0, 0] as CalibrationPoint,
  );
  return [...points].sort((first, second) => (
    Math.atan2(first[1] - center[1], first[0] - center[0])
    - Math.atan2(second[1] - center[1], second[0] - center[0])
  ));
}

export function normalizeCalibrationPoints(points: CalibrationPoint[]): Calibration['points'] {
  if (points.length !== 4) throw new Error('Exactly four calibration points are required.');
  const verticalOrder = [...points].sort((first, second) => first[1] - second[1]);
  const top = verticalOrder.slice(0, 2).sort((first, second) => first[0] - second[0]);
  const bottom = verticalOrder.slice(2).sort((first, second) => first[0] - second[0]);
  return {
    top_left: top[0]!,
    top_right: top[1]!,
    bottom_right: bottom[1]!,
    bottom_left: bottom[0]!,
  };
}

export function validateCalibration(calibration: Calibration): CalibrationIssue | null {
  const { video_width: width, video_height: height } = calibration;
  const points = orderCalibrationPolygon([
    calibration.points.top_left,
    calibration.points.top_right,
    calibration.points.bottom_right,
    calibration.points.bottom_left,
  ]);
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

  return null;
}

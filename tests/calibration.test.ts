import { describe, expect, it } from 'vitest';
import { validateCalibration } from '../src/domain/calibration';
import type { Calibration } from '../src/shared/contracts';

function calibration(points: Calibration['points']): Calibration {
  return { video_width: 1280, video_height: 720, points };
}

describe('calibration validation', () => {
  it('accepts the real 1-193 table points', () => {
    expect(validateCalibration(calibration({
      top_left: [695, 303], top_right: [934, 315], bottom_right: [831, 413], bottom_left: [466, 381],
    }))).toBeNull();
  });

  it('rejects overlap, non-convex points, tiny area, and wrong order', () => {
    expect(validateCalibration(calibration({
      top_left: [100, 100], top_right: [101, 101], bottom_right: [300, 300], bottom_left: [100, 300],
    }))).toBe('overlap');
    expect(validateCalibration(calibration({
      top_left: [100, 100], top_right: [300, 100], bottom_right: [150, 150], bottom_left: [100, 300],
    }))).toBe('not_convex');
    expect(validateCalibration(calibration({
      top_left: [100, 100], top_right: [110, 100], bottom_right: [110, 110], bottom_left: [100, 110],
    }))).toBe('area_too_small');
    expect(validateCalibration(calibration({
      top_left: [300, 100], top_right: [100, 100], bottom_right: [100, 300], bottom_left: [300, 300],
    }))).toBe('wrong_order');
  });

  it('rejects a point outside the source frame', () => {
    expect(validateCalibration(calibration({
      top_left: [-1, 100], top_right: [300, 100], bottom_right: [300, 300], bottom_left: [100, 300],
    }))).toBe('out_of_bounds');
  });
});

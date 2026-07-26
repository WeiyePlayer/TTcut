import { describe, expect, it } from 'vitest';
import { isExportDurationWithinTolerance } from '../src/domain/export-duration';

describe('export duration validation', () => {
  it('accepts output that is within or exactly at the two-second tolerance', () => {
    expect(isExportDurationWithinTolerance(98.01, 100)).toBe(true);
    expect(isExportDurationWithinTolerance(98, 100)).toBe(true);
    expect(isExportDurationWithinTolerance(102, 100)).toBe(true);
  });

  it('rejects output beyond the two-second tolerance', () => {
    expect(isExportDurationWithinTolerance(102.01, 100)).toBe(false);
  });
});

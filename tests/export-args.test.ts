import { describe, expect, it } from 'vitest';
import { buildCutGroups } from '../src/domain/segments';

describe('cut group output duration', () => {
  it('never duplicates overlap introduced by roll time', () => {
    const groups = buildCutGroups([
      { id: 'rally_001', index: 1, bounce_count: 3, start_time_seconds: 10, end_time_seconds: 12 },
      { id: 'rally_002', index: 2, bounce_count: 3, start_time_seconds: 17, end_time_seconds: 19 },
    ], 3, 3, 30);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.start).toBe(7);
    expect(groups[0]?.end).toBe(23);
  });
});

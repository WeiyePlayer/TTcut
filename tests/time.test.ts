import { describe, expect, it } from 'vitest';
import { formatTimestamp } from '../src/domain/time';

describe('formatTimestamp', () => {
  it('formats seconds as HH:MM:SS.mmm', () => {
    expect(formatTimestamp(3723.456)).toBe('01:02:03.456');
    expect(formatTimestamp(-1)).toBe('00:00:00.000');
  });
});

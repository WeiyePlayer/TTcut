import { describe, expect, it } from 'vitest';
import { chooseTimelineInterval, formatResizeDelta, formatTimelineLabel } from '../src/renderer/CustomTimeline';

describe('custom timeline ruler', () => {
  it('uses five-minute labels when fifteen minutes fit in a 1000px viewport', () => {
    expect(chooseTimelineInterval(900 / 1000)).toBe(300);
    expect([300, 600, 900].map(formatTimelineLabel)).toEqual(['5′', '10′', '15′']);
  });

  it('uses one-second labels at maximum zoom', () => {
    expect(chooseTimelineInterval(1 / 150)).toBe(1);
    expect([1, 2].map(formatTimelineLabel)).toEqual(['1″', '2″']);
  });

  it('formats constrained resize feedback as a signed duration change', () => {
    expect(formatResizeDelta(1.236)).toBe('+1.24 s');
    expect(formatResizeDelta(-0.334)).toBe('-0.33 s');
    expect(formatResizeDelta(0.004)).toBe('0.00 s');
  });
});

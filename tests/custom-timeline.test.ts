import { describe, expect, it } from 'vitest';
import {
  clipEdgeHitWidth,
  chooseTimelineInterval,
  formatResizeDelta,
  formatTimelineLabel,
  shouldShowClipBoundaryMarkers,
  timelineWheelDelta,
  timelineWheelScroll,
} from '../src/renderer/CustomTimeline';

describe('custom timeline ruler', () => {
  it('uses five-minute labels when fifteen minutes fit in a 1000px viewport', () => {
    expect(chooseTimelineInterval(900 / 1000)).toBe(300);
    expect([300, 600, 900].map(formatTimelineLabel)).toEqual(['5′', '10′', '15′']);
  });

  it('uses one-second labels at maximum zoom', () => {
    expect(chooseTimelineInterval(1 / 150)).toBe(1);
    expect([1, 2].map(formatTimelineLabel)).toEqual(['1″', '2″']);
    expect(formatTimelineLabel(90)).toBe('1\u203230\u2033');
  });

  it('formats constrained resize feedback as a signed duration change', () => {
    expect(formatResizeDelta(1.236)).toBe('+1.24 s');
    expect(formatResizeDelta(-0.334)).toBe('-0.33 s');
    expect(formatResizeDelta(0.004)).toBe('0.00 s');
  });

  it('keeps wheel movement continuous across pixel, line, page, and horizontal deltas', () => {
    expect(timelineWheelDelta(0, 24, 0, 800)).toBe(24);
    expect(timelineWheelDelta(-12, 80, 0, 800)).toBe(-12);
    expect(timelineWheelDelta(0, 2, 1, 800)).toBe(32);
    expect(timelineWheelDelta(0, -1, 2, 800)).toBe(-800);
  });

  it('moves only within real overflow and releases wheel events at the ends', () => {
    expect(timelineWheelScroll(0, 100, 400, 0, 37, 0)).toEqual({
      nextScroll: 37, shouldPreventDefault: true,
    });
    expect(timelineWheelScroll(37, 100, 400, -12, 80, 0)).toEqual({
      nextScroll: 25, shouldPreventDefault: true,
    });
    expect(timelineWheelScroll(0, 100, 100, 0, 20, 0)).toEqual({
      nextScroll: 0, shouldPreventDefault: false,
    });
    expect(timelineWheelScroll(300, 100, 400, 0, 20, 0)).toEqual({
      nextScroll: 300, shouldPreventDefault: false,
    });
  });
});

describe('custom timeline clip boundaries', () => {
  it('keeps the two pointer hit areas separate even for a one-pixel clip', () => {
    expect(clipEdgeHitWidth(1)).toBe(8.5);
    expect(clipEdgeHitWidth(8)).toBe(12);
    expect(clipEdgeHitWidth(100)).toBe(12);
  });

  it('only shows boundary markers when the clip has enough visual room', () => {
    expect(shouldShowClipBoundaryMarkers(23.99)).toBe(false);
    expect(shouldShowClipBoundaryMarkers(24)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  displayVideoDimensions,
  fittedVideoRectangle,
  isSupportedVideoFileName,
  normalizedVideoRotation,
  videoContainerFromFileName,
} from '../src/domain/video-input';

describe('video input', () => {
  it('accepts MP4 and MOV inputs without accepting unrelated containers', () => {
    expect(isSupportedVideoFileName('match.mp4')).toBe(true);
    expect(isSupportedVideoFileName('IMG_0070.MOV')).toBe(true);
    expect(videoContainerFromFileName('IMG_0070.MOV')).toBe('mov');
    expect(isSupportedVideoFileName('match.avi')).toBe(false);
    expect(isSupportedVideoFileName('match.mov.exe')).toBe(false);
  });

  it('reports display-oriented dimensions for quarter-turn metadata', () => {
    expect(displayVideoDimensions(1920, 1080, -90)).toEqual({ width: 1080, height: 1920 });
    expect(displayVideoDimensions(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 });
    expect(displayVideoDimensions(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 });
    expect(displayVideoDimensions(1920, 1080, null)).toEqual({ width: 1920, height: 1080 });
    expect(normalizedVideoRotation(-90)).toBe(270);
    expect(normalizedVideoRotation(null)).toBe(0);
  });

  it('fits a portrait frame inside a landscape surface without cropping', () => {
    const fitted = fittedVideoRectangle(
      { left: 100, top: 50, width: 825, height: 464 },
      1080,
      1920,
    );
    expect(fitted.height).toBeCloseTo(464);
    expect(fitted.width).toBeCloseTo(261);
    expect(fitted.left).toBeCloseTo(382);
    expect(fitted.top).toBeCloseTo(50);
  });
});

import { expect, it } from 'vitest';
import { scoreboardDimensions, scoreboardDisplayDimensions, scoreboardPreviewHeightFraction } from '../src/domain/scoreboard';
import { scoreboardPositionSchema } from '../src/shared/contracts';
import { buildScoreboardFilter } from '../src/main/media-plan';
import type { VideoMetadata } from '../src/shared/contracts';

it('rotates encoded Windows dimensions but preserves already rotated native dimensions', () => {
  expect(scoreboardDisplayDimensions({ width: 640, height: 360, rotation: 90 })).toEqual({ width: 360, height: 640 });
  expect(scoreboardDisplayDimensions({ width: 360, height: 640, rotation: 90,
    native_video: {} as NonNullable<VideoMetadata['native_video']>,
  })).toEqual({ width: 360, height: 640 });
});

it('uses the taller red-blue geometry for export and leaves room for controls in the editor', () => {
  expect(scoreboardDimensions(1280, 720, 1.5, 'red-blue')).toEqual({ width: 403, height: 276 });
  expect(scoreboardDimensions(1280, 720, 1.5)).toEqual({ width: 538, height: 103 });
  expect(scoreboardPreviewHeightFraction(16 / 9, 'red-blue')).toBeCloseTo(.307);
  expect(buildScoreboardFilter(1280, 720, { x: 1, y: 1, style: 'red-blue', scale: 1.5, imagePath: 'board.png' })).toBe('overlay=x=877:y=444:shortest=1:format=auto');
  expect(scoreboardPositionSchema.safeParse({ x: 0, y: 0, style: 'unknown' }).success).toBe(false);
});

it.each(['classic-orange', 'classic-green'] as const)('preserves classic editor and export geometry for %s', (style) => {
  expect(scoreboardPositionSchema.safeParse({ x: 0, y: 0, style }).success).toBe(true);
  expect(scoreboardDimensions(1280, 720, 1.5, style)).toEqual(scoreboardDimensions(1280, 720, 1.5, 'classic'));
  expect(scoreboardPreviewHeightFraction(16 / 9, style)).toBe(scoreboardPreviewHeightFraction(16 / 9, 'classic'));
  expect(buildScoreboardFilter(1280, 720, { x: 1, y: 1, style, scale: 1.5, imagePath: 'board.png' })).toBe(
    buildScoreboardFilter(1280, 720, { x: 1, y: 1, style: 'classic', scale: 1.5, imagePath: 'board.png' }),
  );
});

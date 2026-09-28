import { expect, it } from 'vitest';
import { scoreboardDisplayDimensions } from '../src/domain/scoreboard';
import type { VideoMetadata } from '../src/shared/contracts';

it('rotates encoded Windows dimensions but preserves already rotated native dimensions', () => {
  expect(scoreboardDisplayDimensions({ width: 640, height: 360, rotation: 90 })).toEqual({ width: 360, height: 640 });
  expect(scoreboardDisplayDimensions({ width: 360, height: 640, rotation: 90,
    native_video: {} as NonNullable<VideoMetadata['native_video']>,
  })).toEqual({ width: 360, height: 640 });
});

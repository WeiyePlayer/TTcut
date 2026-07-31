import { describe, expect, it } from 'vitest';
import {
  analysisProcessEnvironment,
  OPENCV_FFMPEG_READ_ATTEMPTS,
} from '../src/main/analysis-environment';

describe('analysisProcessEnvironment', () => {
  it('forces the OpenCV packet budget before the Python process starts', () => {
    const environment = analysisProcessEnvironment({
      KEEP_ME: 'yes',
      OPENCV_FFMPEG_READ_ATTEMPTS: '4096',
    });

    expect(environment).toEqual({
      KEEP_ME: 'yes',
      OPENCV_FFMPEG_READ_ATTEMPTS: '65536',
    });
    expect(OPENCV_FFMPEG_READ_ATTEMPTS).toBe('65536');
  });
});

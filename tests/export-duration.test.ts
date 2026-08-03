import { describe, expect, it } from 'vitest';
import {
  assessExportDuration,
  assessFastConcatDuration,
  exportMediaQuantumSeconds,
} from '../src/domain/export-duration';
import type { VideoMetadata } from '../src/shared/contracts';

describe('export duration validation', () => {
  const source: VideoMetadata = {
    path: 'source.mp4', duration_seconds: 1_000, width: 1920, height: 1080,
    fps: 60, nominal_fps: 60, variable_frame_rate: false,
    video_codec: 'h264', audio_codec: 'aac', container: 'mp4', frame_count: 60_000,
    average_bitrate: 8_000_000, audio_bitrate: 192_000, pixel_format: 'yuv420p',
    audio_sample_rate: 48_000, audio_channels: 2,
    video_time_base: '1/15360', audio_time_base: '1/48000',
  };

  it.each([
    { segments: 13, target: 130.836467, actual: 131.03 },
    { segments: 46, target: 389.980970, actual: 390.87 },
    { segments: 72, target: 555.70, actual: 557.82 },
    { segments: 73, target: 777.131763, actual: 779.26 },
  ])('accepts observed boundary drift for $segments merged segments', ({ segments, target, actual }) => {
    expect(assessExportDuration(actual, target, segments, source).withinTolerance).toBe(true);
  });

  it('rejects the same multi-second drift for one segment', () => {
    expect(assessExportDuration(102.128, 100, 1, source).withinTolerance).toBe(false);
  });

  it('uses the slower average VFR rate and supports silent media', () => {
    const silentVfr = {
      ...source,
      fps: 51.39,
      nominal_fps: 60,
      variable_frame_rate: true,
      audio_codec: null,
      audio_sample_rate: null,
      audio_time_base: null,
    };
    expect(exportMediaQuantumSeconds(silentVfr)).toBeCloseTo(1 / 51.39, 10);
  });

  it('uses the AAC frame quantum at 44.1 kHz and 48 kHz', () => {
    expect(exportMediaQuantumSeconds({ ...source, audio_sample_rate: 44_100 }))
      .toBeCloseTo(1024 / 44_100, 10);
    expect(exportMediaQuantumSeconds(source)).toBeCloseTo(1024 / 48_000, 10);
  });

  it('uses a conservative audio quantum when the sample rate is missing', () => {
    expect(exportMediaQuantumSeconds({ ...source, audio_sample_rate: null })).toBe(0.05);
  });

  it('accepts the exact boundary and rejects a value beyond it', () => {
    const assessment = assessExportDuration(100, 100, 5, source);
    expect(assessExportDuration(100 + assessment.allowedDriftSeconds, 100, 5, source).withinTolerance)
      .toBe(true);
    expect(assessExportDuration(100 + assessment.allowedDriftSeconds + 0.000_001, 100, 5, source).withinTolerance)
      .toBe(false);
  });

  it('checks a fast concat against actual segments and the requested dynamic budget independently', () => {
    const assessment = assessFastConcatDuration(
      47.5,
      Array.from({ length: 46 }, () => 1),
      46,
      source,
    );
    expect(assessment.encodedSegments.withinTolerance).toBe(false);
    expect(assessment.requestedClips.withinTolerance).toBe(true);
    expect(assessment.encodedSegments.segmentCount).toBe(1);
    expect(assessment.requestedClips.segmentCount).toBe(46);
  });
});

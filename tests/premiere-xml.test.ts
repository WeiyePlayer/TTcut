import { describe, expect, it } from 'vitest';
import { buildPremiereXml } from '../src/domain/premiere-xml';
import type { VideoMetadata } from '../src/shared/contracts';
import type { ValidatedCustomExportSegment } from '../src/domain/custom-clips';

const segments: ValidatedCustomExportSegment[] = [
  { rallyId: 'rally_001', rallyIndex: 1, rallyIds: ['rally_001'], rawStart: 1, rawEnd: 3, start: 1, end: 3 },
  { rallyId: 'rally_002', rallyIndex: 2, rallyIds: ['rally_002'], rawStart: 5, rawEnd: 7.5, start: 5, end: 7.5 },
];

function metadata(overrides: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    path: 'D:\\比赛 & 练习\\match clip.mp4',
    duration_seconds: 12,
    width: 1920,
    height: 1080,
    fps: 30,
    nominal_fps: 30,
    variable_frame_rate: false,
    video_codec: 'h264',
    audio_codec: 'aac',
    container: 'mp4',
    ...overrides,
  };
}

describe('Premiere XML export', () => {
  it('creates a continuous FCP7 XML V1/A1 sequence that references the source media', () => {
    const output = buildPremiereXml(metadata(), segments, 'TTcut custom');
    const document = new DOMParser().parseFromString(output.xml, 'text/xml');

    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.documentElement.getAttribute('version')).toBe('4');
    expect(document.querySelectorAll('video > track > clipitem')).toHaveLength(2);
    expect(document.querySelectorAll('audio > track > clipitem')).toHaveLength(2);
    expect(document.querySelectorAll('file[id="file-1"]')).toHaveLength(4);
    expect(document.querySelector('pathurl')?.textContent).toContain('file:///D:/');
    expect(output.xml).toContain('&amp;');
    const videoItems = [...document.querySelectorAll('video > track > clipitem')];
    expect(videoItems.map((item) => item.querySelector('start')?.textContent)).toEqual(['0', '60']);
    expect(videoItems.map((item) => item.querySelector('end')?.textContent)).toEqual(['60', '135']);
    expect(output.quantizedForVfr).toBe(false);
  });

  it('uses NTSC timebase and reports VFR quantization', () => {
    const output = buildPremiereXml(metadata({
      duration_seconds: 60.05,
      fps: 29.97,
      nominal_fps: 30_000 / 1_001,
      variable_frame_rate: true,
      audio_codec: null,
    }), segments, 'NTSC');
    const document = new DOMParser().parseFromString(output.xml, 'text/xml');

    expect(document.querySelector('sequence > rate > timebase')?.textContent).toBe('30');
    expect(document.querySelector('sequence > rate > ntsc')?.textContent).toBe('TRUE');
    expect(document.querySelector('file > duration')?.textContent).toBe('1802');
    expect(document.querySelector('audio')).toBeNull();
    expect(output.quantizedForVfr).toBe(true);
  });
});

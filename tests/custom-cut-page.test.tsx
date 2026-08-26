import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateRallyPlaybackScrollTop, CustomCutPage, findPlaybackTargetClip } from '../src/renderer/CustomCutPage';
import type { AnalysisResultV1, ExportRequest } from '../src/shared/contracts';
import type { SelectedVideo } from '../src/shared/api';
import type { CustomRallyClip } from '../src/domain/custom-clips';
import { messages } from '../src/renderer/i18n';

const analysis: AnalysisResultV1 = {
  schema_version: 1,
  video: { path: 'D:/match.mp4', duration_seconds: 10, width: 1280, height: 720, fps: 30, variable_frame_rate: false, video_codec: 'h264', audio_codec: 'aac', container: 'mp4' },
  rallies: [{ id: 'rally_001', index: 1, bounce_count: 3, start_time_seconds: 3, end_time_seconds: 4 }],
  bounce_times_seconds: [3.2, 3.8, 7.2, 7.9],
};

const video: SelectedVideo = { path: analysis.video.path, name: 'match.mp4', size: 1, mediaUrl: 'ttcut-media://match' };
const initialClips: CustomRallyClip[] = [{
  clipId: 'rally_001', source: 'detected', sourceRallyId: 'rally_001', rallyIndex: 1, bounceCount: 3,
  defaultStart: 3, defaultEnd: 4, start: 3, end: 4, selected: true,
}];

const playbackClips: CustomRallyClip[] = [
  { clipId: 'rally_001', source: 'detected', sourceRallyId: 'rally_001', rallyIndex: 1, bounceCount: 3, defaultStart: 1, defaultEnd: 2, start: 1, end: 2, selected: true },
  { clipId: 'rally_002', source: 'detected', sourceRallyId: 'rally_002', rallyIndex: 2, bounceCount: 4, defaultStart: 4, defaultEnd: 5, start: 4, end: 5, selected: true },
  { clipId: 'rally_003', source: 'detected', sourceRallyId: 'rally_003', rallyIndex: 3, bounceCount: 5, defaultStart: 7, defaultEnd: 8, start: 7, end: 8, selected: false },
  { clipId: 'rally_004', source: 'detected', sourceRallyId: 'rally_004', rallyIndex: 4, bounceCount: 6, defaultStart: 9, defaultEnd: 10, start: 9, end: 10, selected: true },
];

function Harness() {
  const [clips, setClips] = useState(initialClips);
  const [outputs, setOutputs] = useState<NonNullable<ExportRequest['outputs']>>({ combined_video: true, rally_videos: false, premiere_xml: false });
  return <CustomCutPage video={video} analysis={analysis} clips={clips} translations={messages('en')} mediaAvailable onClipsChange={setClips} onToggleAll={vi.fn()} outputs={outputs} onOutputsChange={setOutputs} onExport={vi.fn()} />;
}

function PlaybackHarness({ clips = playbackClips }: { clips?: CustomRallyClip[] }) {
  const [currentClips, setCurrentClips] = useState(clips);
  const [outputs, setOutputs] = useState<NonNullable<ExportRequest['outputs']>>({ combined_video: true, rally_videos: false, premiere_xml: false });
  return <CustomCutPage video={video} analysis={analysis} clips={currentClips} translations={messages('en')} mediaAvailable onClipsChange={setCurrentClips} onToggleAll={vi.fn()} outputs={outputs} onOutputsChange={setOutputs} onExport={vi.fn()} />;
}

function setVideoTime(videoElement: HTMLVideoElement, time: number) {
  Object.defineProperty(videoElement, 'currentTime', { configurable: true, value: time, writable: true });
  fireEvent.timeUpdate(videoElement);
}

function mockRallyListGeometry() {
  const scroll = document.querySelector<HTMLDivElement>('#custom-rally-scroll');
  const rows = [...document.querySelectorAll<HTMLTableRowElement>('.custom-rally-table tbody tr')];
  if (!scroll) throw new Error('Missing rally scroll.');
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 128 });
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 256 });
  Object.defineProperty(scroll, 'scrollTop', { configurable: true, value: 0, writable: true });
  rows.forEach((row, index) => {
    Object.defineProperty(row, 'offsetTop', { configurable: true, value: index * 64 });
    Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 64 });
  });
  return { scroll, rows };
}

afterEach(() => cleanup());

describe('playback rally location', () => {
  it('matches only selected clips with half-open boundaries', () => {
    expect(findPlaybackTargetClip(playbackClips, 1)).toMatchObject({ clipId: 'rally_001' });
    expect(findPlaybackTargetClip(playbackClips, 1.999)).toMatchObject({ clipId: 'rally_001' });
    expect(findPlaybackTargetClip(playbackClips, 2)).toBeNull();
    expect(findPlaybackTargetClip(playbackClips, 7.5)).toBeNull();
    expect(findPlaybackTargetClip(playbackClips, Number.NaN)).toBeNull();
  });

  it('keeps the target below one preceding row and clamps the scroll range', () => {
    expect(calculateRallyPlaybackScrollTop(0, [0, 64, 128], 128, 256)).toBe(0);
    expect(calculateRallyPlaybackScrollTop(2, [0, 64, 128], 128, 256)).toBe(64);
    expect(calculateRallyPlaybackScrollTop(3, [0, 64, 128, 192], 128, 256)).toBe(128);
  });

  it('cues natural entry once, retriggers explicit jumps, and expires after 500ms', () => {
    vi.useFakeTimers();
    try {
      render(<PlaybackHarness clips={playbackClips.slice(0, 2)} />);
      const monitor = document.querySelector('.custom-monitor video') as HTMLVideoElement;
      setVideoTime(monitor, 1.25);
      expect(document.querySelector('[data-playback-cue="true"]')).toHaveAttribute('data-playback-cue', 'true');
      act(() => vi.advanceTimersByTime(500));
      expect(document.querySelector('[data-playback-cue="true"]')).toBeNull();

      setVideoTime(monitor, 1.5);
      expect(document.querySelector('[data-playback-cue="true"]')).toBeNull();
      fireEvent.click(document.querySelectorAll('.custom-rally-table tbody tr')[0]!);
      expect(document.querySelector('[data-playback-cue="true"]')).toHaveAttribute('data-playback-cue', 'true');
      act(() => vi.advanceTimersByTime(500));
      expect(document.querySelector('[data-playback-cue="true"]')).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('does not cue while scrubbing and commits the final playhead position on release', () => {
    render(<PlaybackHarness clips={playbackClips.slice(0, 2)} />);
    const monitor = document.querySelector('.custom-monitor video') as HTMLVideoElement;
    const viewport = document.querySelector('.timeline-viewport') as HTMLDivElement;
    const playhead = screen.getByRole('slider', { name: 'Custom cut timeline' });
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(viewport, 'scrollLeft', { configurable: true, value: 0, writable: true });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 78, width: 100, height: 78, toJSON: () => ({}) });
    Object.defineProperty(playhead, 'setPointerCapture', { configurable: true, value: vi.fn() });

    fireEvent.pointerDown(playhead, { pointerId: 9, clientX: 0.12 });
    expect(document.querySelector('[data-playback-cue="true"]')).toBeNull();
    setVideoTime(monitor, 1.4);
    expect(document.querySelector('[data-playback-cue="true"]')).toBeNull();
    fireEvent.pointerUp(playhead, { pointerId: 9, clientX: 0.12 });
    expect(document.querySelector('[data-playback-cue="true"]')).toHaveAttribute('data-playback-cue', 'true');
  });

  it('waits for an offscreen target scroll and keeps only the latest location', () => {
    vi.useFakeTimers();
    try {
      render(<PlaybackHarness />);
      const monitor = document.querySelector('.custom-monitor video') as HTMLVideoElement;
      const { scroll, rows } = mockRallyListGeometry();
      const scrollTo = vi.fn();
      Object.defineProperty(scroll, 'scrollTo', { configurable: true, value: scrollTo });

      setVideoTime(monitor, 9.25);
      expect(scrollTo).toHaveBeenCalledWith({ top: 128, behavior: 'smooth' });
      expect(document.querySelector('[data-playback-cue="true"]')).toBeNull();

      scroll.scrollTop = 128;
      setVideoTime(monitor, 4.25);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
      expect(document.querySelector('[data-playback-cue="true"]')).toBeNull();

      act(() => vi.advanceTimersByTime(800));
      expect(scroll.scrollTop).toBe(0);
      expect(document.querySelector('[data-playback-cue="true"]')).toBe(rows[1]);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('does not cue an unselected clip', () => {
    render(<PlaybackHarness clips={[playbackClips[2]!]} />);
    const monitor = document.querySelector('.custom-monitor video') as HTMLVideoElement;
    setVideoTime(monitor, 7.5);
    expect(document.querySelector('[data-playback-cue="true"]')).toBeNull();
  });
});

describe('manual timeline tools', () => {
  it('keeps export options open while the pointer moves from the trigger into the popover', () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      const launcher = document.querySelector('.custom-export-launcher') as HTMLDivElement;
      const options = screen.getByRole('group', { name: 'Custom export options' });
      const startCutting = screen.getByRole('button', { name: 'Start cutting' });

      fireEvent.pointerEnter(startCutting);
      expect(launcher).toHaveClass('is-open');
      fireEvent.pointerLeave(launcher);
      fireEvent.pointerEnter(options);
      act(() => vi.advanceTimersByTime(200));
      expect(launcher).toHaveClass('is-open');

      fireEvent.pointerLeave(options);
      act(() => vi.advanceTimersByTime(200));
      expect(launcher).not.toHaveClass('is-open');
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('creates and deletes a one-second manual clip from the icon-only tools', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    render(<Harness />);
    const track = document.querySelector('.timeline-track-window') as HTMLDivElement;
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 42, width: 100, height: 42, toJSON: () => ({}) });

    fireEvent.click(screen.getByRole('button', { name: 'Add rally' }));
    fireEvent.pointerDown(track, { button: 2, clientX: 70, clientY: 20 });
    fireEvent.contextMenu(track);
    expect(document.querySelector('.timeline-clip[data-clip-id^="manual_"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add rally' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Add rally' }));
    fireEvent.pointerDown(track, { clientX: 70, clientY: 20 });
    const manualClip = document.querySelector<HTMLElement>('.timeline-clip[data-clip-id^="manual_"]');
    expect(manualClip).not.toBeNull();
    expect(screen.getByText('Bounces 2')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Delete rally' }));
    fireEvent.pointerEnter(manualClip!);
    expect(manualClip).toHaveClass('delete-target');
    expect(manualClip!.querySelector('span')).toBeNull();
    fireEvent.pointerDown(manualClip!, { button: 2, clientX: 75, clientY: 20 });
    fireEvent.contextMenu(manualClip!);
    expect(document.querySelector('.timeline-clip[data-clip-id^="manual_"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Delete rally' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Delete rally' }));
    fireEvent.pointerEnter(manualClip!);
    fireEvent.pointerDown(manualClip!, { clientX: 75, clientY: 20 });
    expect(document.querySelector('.timeline-clip[data-clip-id^="manual_"]')).toBeNull();
    width.mockRestore();
  });
});

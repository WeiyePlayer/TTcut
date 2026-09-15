import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateRallyPlaybackScrollTop, CustomCutPage, findPlaybackTargetClip } from '../src/renderer/CustomCutPage';
import type { AnalysisResultV1, ExportRequest } from '../src/shared/contracts';
import type { SelectedVideo } from '../src/shared/api';
import { setCustomClipSelected, type CustomRallyClip } from '../src/domain/custom-clips';
import type { CustomPlaybackMode } from '../src/domain/custom-playback';
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

const continuousBoardAnalysis: AnalysisResultV1 = {
  schema_version: 3,
  video: analysis.video,
  rallies: [{
    id: 'rally_001', index: 1, bounce_count: 2,
    start_time_seconds: 3, end_time_seconds: 4,
  }],
  bounce_times_seconds: [3.2, 3.8],
  rally_recognition: {
    method: 'continuous_visibility', start_visible_seconds: 0.2, end_invisible_seconds: 0.5,
    board_count: {
      detector: 'blurball_trajectory_change', minimum_interval_seconds: 0.315,
      source_path: 'worker/ttcut_worker/blurball_bounce.py',
      source_sha256: 'e1e7674cd1209a6f4deffe5ff0e57633e2859605f031b1c012cb2d16c9f49ea8',
      landing_region: 'expanded_table', table_length_margin_cm: 35, table_width_margin_cm: 25,
    },
  },
};

function Harness() {
  const [playbackMode, setPlaybackMode] = useState<CustomPlaybackMode>('source');
  const [clips, setClips] = useState(initialClips);
  const [outputs, setOutputs] = useState<NonNullable<ExportRequest['outputs']>>({ combined_video: true, rally_videos: false, premiere_xml: false });
  return <CustomCutPage video={video} analysis={analysis} clips={clips} playbackMode={playbackMode} onPlaybackModeChange={setPlaybackMode} translations={messages('en')} mediaAvailable onClipsChange={setClips} onToggleAll={vi.fn()} outputs={outputs} onOutputsChange={setOutputs} onExport={vi.fn()} />;
}

function PlaybackHarness({ clips = playbackClips }: { clips?: CustomRallyClip[] }) {
  const [playbackMode, setPlaybackMode] = useState<CustomPlaybackMode>('source');
  const [currentClips, setCurrentClips] = useState(clips);
  const [outputs, setOutputs] = useState<NonNullable<ExportRequest['outputs']>>({ combined_video: true, rally_videos: false, premiere_xml: false });
  return <CustomCutPage video={video} analysis={analysis} clips={currentClips} playbackMode={playbackMode} onPlaybackModeChange={setPlaybackMode} translations={messages('en')} mediaAvailable onClipsChange={setCurrentClips} onToggleAll={vi.fn()} outputs={outputs} onOutputsChange={setOutputs} onExport={vi.fn()} />;
}

function ContinuousBoardHarness() {
  const [clips, setClips] = useState<CustomRallyClip[]>([{ ...initialClips[0]!, bounceCount: 2 }]);
  const [playbackMode, setPlaybackMode] = useState<CustomPlaybackMode>('source');
  const [outputs, setOutputs] = useState<NonNullable<ExportRequest['outputs']>>({ combined_video: true, rally_videos: false, premiere_xml: false });
  return <CustomCutPage video={video} analysis={continuousBoardAnalysis} clips={clips} playbackMode={playbackMode} onPlaybackModeChange={setPlaybackMode} translations={messages('zh-CN')} mediaAvailable onClipsChange={setClips} onToggleAll={vi.fn()} outputs={outputs} onOutputsChange={setOutputs} onExport={vi.fn()} />;
}

function SelectionHarness({ result = analysis }: { result?: AnalysisResultV1 }) {
  const [clips, setClips] = useState(playbackClips);
  const [playbackMode, setPlaybackMode] = useState<CustomPlaybackMode>('source');
  const [outputs, setOutputs] = useState<NonNullable<ExportRequest['outputs']>>({ combined_video: true, rally_videos: false, premiere_xml: false });
  return <CustomCutPage video={video} analysis={result} clips={clips} playbackMode={playbackMode} onPlaybackModeChange={setPlaybackMode} translations={messages('zh-CN')} mediaAvailable onClipsChange={setClips} onToggleAll={(selected) => setClips((current) => selected
    ? current.reduce((next, clip) => setCustomClipSelected(next, clip.clipId, true, result.video.duration_seconds, result.video.fps), current)
    : current.map((clip) => ({ ...clip, selected: false })))} outputs={outputs} onOutputsChange={setOutputs} onExport={vi.fn()} />;
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

it('shows board counts for continuous-visibility results that include bounce metadata', () => {
  render(<ContinuousBoardHarness />);
  expect(screen.getByText('板数 2')).toBeVisible();
});

describe('custom multi-select card', () => {
  it('opens from Multi-select and keeps Select all and Clear all behavior', () => {
    render(<SelectionHarness />);
    const trigger = screen.getByRole('button', { name: '多选' });
    expect(screen.queryByRole('button', { name: '全选' })).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: '多选选项' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getAllByRole('checkbox', { name: /回合/ }).every((input) => (input as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByRole('dialog', { name: '多选选项' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取消全选' }));
    expect(screen.getAllByRole('checkbox', { name: /回合/ }).every((input) => !(input as HTMLInputElement).checked)).toBe(true);
  });

  it('applies inclusive board matches on Enter without changing playback or removing clips', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    try {
      render(<SelectionHarness />);
      const monitor = document.querySelector('.custom-monitor video') as HTMLVideoElement;
      setVideoTime(monitor, 4.5);
      fireEvent.click(screen.getByRole('button', { name: '多选' }));
      const input = screen.getByRole('textbox', { name: '板数大于等于' });
      fireEvent.change(input, { target: { value: '5' } });
      expect(screen.getByText('3 / 4')).toBeVisible();
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getAllByRole('checkbox', { name: /回合/ }).map((checkbox) => (checkbox as HTMLInputElement).checked)).toEqual([false, false, true, true]);
      expect(document.querySelectorAll('.custom-rally-table tbody tr')).toHaveLength(4);
      expect(monitor.currentTime).toBe(4.5);
      expect(play).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: '多选选项' })).toBeNull();
    } finally { play.mockRestore(); pause.mockRestore(); }
  });

  it('accepts only 1–10 integers, permits clearing, and ignores empty Enter', () => {
    render(<SelectionHarness />);
    fireEvent.click(screen.getByRole('button', { name: '多选' }));
    const input = screen.getByRole('textbox', { name: '板数大于等于' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: '多选选项' })).toBeVisible();
    for (const value of ['0', '11', '-1', '1.5', 'abc', '01']) {
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveValue('');
    }
    fireEvent.change(input, { target: { value: '1' } });
    expect(input).toHaveValue('1');
    fireEvent.change(input, { target: { value: '10' } });
    expect(input).toHaveValue('10');
    fireEvent.change(input, { target: { value: '20' } });
    expect(input).toHaveValue('10');
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('0 / 4')).toBeVisible();
  });

  it('closes on Escape, an outside click, or focus leaving the card', () => {
    render(<SelectionHarness />);
    const trigger = screen.getByRole('button', { name: '多选' });
    fireEvent.click(trigger);
    const input = screen.getByRole('textbox', { name: '板数大于等于' });
    act(() => input.focus());
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    act(() => screen.getByRole('textbox', { name: '板数大于等于' }).focus());
    act(() => screen.getByRole('button', { name: '取消全选' }).focus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('disables board filtering for old continuous results without board metadata', () => {
    const legacy: AnalysisResultV1 = {
      schema_version: 2, video: analysis.video,
      rallies: [{ id: 'rally_001', index: 1, start_time_seconds: 3, end_time_seconds: 4 }],
      rally_recognition: { method: 'continuous_visibility', start_visible_seconds: .2, end_invisible_seconds: .5 },
    };
    render(<SelectionHarness result={legacy} />);
    fireEvent.click(screen.getByRole('button', { name: '多选' }));
    expect(screen.getByRole('textbox', { name: '板数大于等于' })).toBeDisabled();
    expect(screen.getByText('重新分析后可按板数筛选')).toBeVisible();
    expect(screen.getByRole('button', { name: '全选' })).toBeEnabled();
  });
});

describe('playback rally location', () => {
  it.each(['list', 'timeline'])('plays the requested clip after delayed metadata from the %s', async (entry) => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    try {
      render(<PlaybackHarness />);
      const monitor = document.querySelector('.custom-monitor video') as HTMLVideoElement;
      if (entry === 'list') fireEvent.click(document.querySelectorAll('.custom-rally-table tbody tr')[1]!);
      else fireEvent.pointerDown(document.querySelector('.timeline-clip[data-clip-id="rally_002"]')!, { button: 0 });
      expect(play).not.toHaveBeenCalled();
      Object.defineProperties(monitor, { readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
      await act(async () => { fireEvent.loadedMetadata(monitor); });
      expect(monitor.currentTime).toBe(4);
      expect(play).toHaveBeenCalledOnce();
    } finally { play.mockRestore(); }
  });

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
  it.each(['.timeline-track-window', '.timeline-ruler'])('zooms with ordinary wheel input over %s only while the zoom tool is active', (target) => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    try {
      render(<Harness />);
      const viewport = document.querySelector<HTMLElement>('.timeline-viewport')!;
      const surface = document.querySelector(target)!;
      const zoom = screen.getByRole('button', { name: 'Zoom timeline' });
      expect(zoom.nextElementSibling).toBe(screen.getByRole('button', { name: 'Source playback' }));
      fireEvent.wheel(surface, { deltaY: -120, clientX: 50 });
      expect(Number(viewport.dataset.zoom)).toBe(1);
      fireEvent.click(zoom);
      expect(zoom).toHaveAttribute('aria-pressed', 'true');
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: 50 });
      fireEvent(surface, wheel);
      expect(wheel.defaultPrevented).toBe(true);
      expect(Number(viewport.dataset.zoom)).toBeCloseTo(1.18);
      fireEvent.wheel(surface, { deltaY: 120, clientX: 50 });
      expect(Number(viewport.dataset.zoom)).toBeCloseTo(1);
      fireEvent.click(zoom);
      fireEvent.wheel(surface, { deltaY: -120, clientX: 50 });
      expect(Number(viewport.dataset.zoom)).toBeCloseTo(1);
      fireEvent.wheel(surface, { ctrlKey: true, deltaY: -120, clientX: 50 });
      expect(Number(viewport.dataset.zoom)).toBeGreaterThan(1);
      fireEvent.wheel(surface, { metaKey: true, deltaY: 120, clientX: 50 });
      expect(Number(viewport.dataset.zoom)).toBeCloseTo(1);
    } finally { width.mockRestore(); }
  });

  it('makes zoom exclusive with editing tools and cancels it without changing playback or boundaries', () => {
    render(<Harness />);
    const zoom = screen.getByRole('button', { name: 'Zoom timeline' });
    const add = screen.getByRole('button', { name: 'Add rally' });
    const remove = screen.getByRole('button', { name: 'Delete rally' });
    fireEvent.click(add);
    fireEvent.click(zoom);
    expect(add).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('slider', { name: 'Resize clip start 1' })).toBeVisible();
    fireEvent.click(remove);
    expect(zoom).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(zoom);
    expect(remove).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Source playback' }));
    expect(zoom).toHaveAttribute('aria-pressed', 'true');
    const monitor = document.querySelector('.custom-monitor video') as HTMLVideoElement;
    setVideoTime(monitor, 1.4);
    for (const target of [document.querySelector('.timeline-ruler')!, screen.getByRole('slider', { name: 'Custom cut timeline' }), screen.getByRole('slider', { name: 'Resize clip start 1' })]) {
      if (zoom.getAttribute('aria-pressed') === 'false') fireEvent.click(zoom);
      fireEvent.pointerDown(target, { button: 2, pointerId: 6, clientX: 50 });
      fireEvent.contextMenu(target);
      expect(zoom).toHaveAttribute('aria-pressed', 'false');
      expect(monitor.currentTime).toBe(1.4);
      expect(screen.getByRole('slider', { name: 'Resize clip start 1' })).toHaveAttribute('aria-valuenow', '3');
      expect(screen.getByRole('button', { name: 'Rally playback' })).toHaveAttribute('aria-pressed', 'true');
    }
  });

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

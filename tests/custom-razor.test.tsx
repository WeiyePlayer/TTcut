import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomCutPage } from '../src/renderer/CustomCutPage';
import { useCustomClipHistory } from '../src/renderer/use-custom-clip-history';
import { messages } from '../src/renderer/i18n';
import { CUSTOM_GUIDE_STORAGE_KEY } from '../src/renderer/custom-guide-preference';
import type { CustomRallyClip } from '../src/domain/custom-clips';
import type { AnalysisResultV1 } from '../src/shared/contracts';
import type { CustomPlaybackMode } from '../src/domain/custom-playback';

const clips: CustomRallyClip[] = [{ clipId: 'a', source: 'detected', sourceRallyId: 'a', rallyIndex: 1,
  start: 1, end: 5, defaultStart: 1, defaultEnd: 5, bounceCount: 3, selected: true,
  score: { left: 2, right: 1 }, winner: 'left' },
  { clipId: 'b', source: 'detected', sourceRallyId: 'b', rallyIndex: 2,
    start: 6, end: 9, defaultStart: 6, defaultEnd: 9, bounceCount: 1, selected: true }];
const analysis: AnalysisResultV1 = { schema_version: 1,
  video: { path: '/match.mp4', duration_seconds: 10, width: 1280, height: 720, fps: 30, variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4' },
  rallies: clips.map(clip => ({ id: clip.clipId, index: clip.rallyIndex, start_time_seconds: clip.start, end_time_seconds: clip.end, bounce_count: clip.bounceCount! })),
  bounce_times_seconds: [1.5, 3, 4, 7] };

beforeEach(() => {
  window.localStorage.setItem(CUSTOM_GUIDE_STORAGE_KEY, '1');
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('ttcut', { platform: 'win32' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Harness({ initialMode = 'source', initialClips = clips }: { initialMode?: CustomPlaybackMode; initialClips?: CustomRallyClip[] }) {
  const history = useCustomClipHistory(initialClips);
  const [mode, setMode] = useState(initialMode);
  useLayoutEffect(() => {
    const video = document.querySelector('video')!;
    Object.defineProperties(video, { readyState: { configurable: true, value: 4 },
      videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 720 } });
  }, []);
  return <CustomCutPage video={{ path: '/match.mp4', name: 'match', size: 1, mediaUrl: 'file:///match.mp4' }} analysis={analysis}
    clips={history.clips!} playbackMode={mode} onPlaybackModeChange={setMode} translations={messages('en')} mediaAvailable
    onClipsChange={history.edit} onToggleAll={selected => history.edit(current => current!.map(clip => ({ ...clip, selected })))}
    outputs={{ combined_video: true, rally_videos: false, premiere_xml: false }} onOutputsChange={() => {}} onExport={() => {}}
    scoreboard={{ enabled: true, x: 0.5, y: 0.1 }} canUndo={history.canUndo} canRedo={history.canRedo}
    onUndo={history.undo} onRedo={history.redo} onEditStart={history.begin} onEditEnd={history.commit}
    onReset={() => history.load(initialClips)} />;
}
const clip = (id = 'a') => document.querySelector<HTMLElement>(`.timeline-clip[data-clip-id="${id}"]`)!;
const monitor = () => document.querySelector<HTMLVideoElement>('video')!;
function position(time: number) { monitor().currentTime = time; fireEvent.timeUpdate(monitor()); }
function cutAt(x = 306) {
  fireEvent.pointerMove(clip(), { clientX: x });
  fireEvent.pointerDown(clip(), { clientX: x, button: 0 });
}

describe('custom razor editor', () => {
  it('snaps at 8 pixels, clears annotations, preserves transport, and supports undo/redo', () => {
    render(<Harness />); position(3);
    expect(clip().querySelector('.clip-score-annotation')).not.toBeNull();
    expect(clip('b').querySelector('.clip-score-annotation')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Razor tool' }));
    fireEvent.pointerMove(clip(), { clientX: 308 });
    expect(document.querySelector('.razor-cut-line')).toHaveAttribute('data-cut-time', '3');
    fireEvent.pointerMove(clip(), { clientX: 309 });
    expect(document.querySelector('.razor-cut-line')).toHaveAttribute('data-cut-time', '3.09');
    cutAt();
    expect(document.querySelectorAll('.timeline-clip')).toHaveLength(3);
    expect(clip().style.width).toBe('200px');
    const rightId = document.querySelector<HTMLElement>('[data-clip-id^="split_"]')!.dataset.clipId!;
    expect(document.querySelectorAll('.clip-score-annotation')).toHaveLength(0);
    expect(monitor().currentTime).toBe(3); expect(monitor().paused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo clip edit' }));
    expect(document.querySelectorAll('.timeline-clip')).toHaveLength(2);
    expect(document.querySelectorAll('.clip-score-annotation')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Redo clip edit' }));
    expect(document.querySelector(`[data-clip-id="${rightId}"]`)).not.toBeNull();
    expect(document.querySelectorAll('.clip-score-annotation')).toHaveLength(0);
  });

  it('ignores invalid cuts and A/D, remains exclusive, and cancels by Escape/right click', () => {
    render(<Harness />); position(1.5);
    fireEvent.click(screen.getByRole('button', { name: 'Razor tool' }));
    expect(screen.queryByRole('slider', { name: 'Resize clip start 1' })).toBeNull();
    cutAt(100); cutAt(101); cutAt(500);
    fireEvent.pointerDown(document.querySelector('.timeline-track-window')!, { clientX: 550 });
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA' });
    fireEvent.keyDown(document.body, { key: 'd', code: 'KeyD' });
    expect(document.querySelectorAll('.timeline-clip')).toHaveLength(2);
    expect(clip().style.width).toBe('400px');
    expect(screen.getByRole('button', { name: 'Undo clip edit' })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Razor tool' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Add rally' }));
    fireEvent.click(screen.getByRole('button', { name: 'Razor tool' }));
    expect(screen.getByRole('button', { name: 'Add rally' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.contextMenu(document.querySelector('.custom-workspace')!);
    expect(screen.getByRole('button', { name: 'Razor tool' })).toHaveAttribute('aria-pressed', 'false');
  });

  it.each(['darwin', 'win32'])('uses conventional shortcuts on %s and leaves text undo alone', platform => {
    vi.stubGlobal('ttcut', { platform });
    render(<Harness />); position(3);
    fireEvent.click(screen.getByRole('button', { name: 'Razor tool' })); cutAt();
    const modifier = platform === 'darwin' ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(document.body, { key: 'z', ...modifier });
    expect(document.querySelectorAll('.timeline-clip')).toHaveLength(2);
    fireEvent.keyDown(document.body, { key: 'Z', shiftKey: true, ...modifier });
    expect(document.querySelectorAll('.timeline-clip')).toHaveLength(3);
    if (platform === 'win32') {
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
      expect(document.querySelectorAll('.timeline-clip')).toHaveLength(3);
    }
    const input = document.createElement('input'); document.body.append(input);
    const event = new KeyboardEvent('keydown', { key: 'z', ...modifier, bubbles: true, cancelable: true });
    input.dispatchEvent(event); input.remove();
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelectorAll('.timeline-clip')).toHaveLength(3);
    fireEvent.keyDown(document.body, { key: 'z', ...modifier, isComposing: true });
    expect(document.querySelectorAll('.timeline-clip')).toHaveLength(3);
  });

  it('marks explicit zero scores and winners but does not mark inherited scores or enabling the board', () => {
    render(<Harness initialClips={clips.map((clip, i) => ({ ...clip, score: i === 0 ? { left: 0, right: 0 } : undefined, winner: undefined }))} />);
    expect(document.querySelectorAll('.clip-score-annotation')).toHaveLength(1);
    expect(clip('b').querySelector('.clip-score-annotation')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
    expect(document.querySelectorAll('.clip-score-annotation')).toHaveLength(1);
  });

  it('marks a winner-only annotation without marking the following inherited score', () => {
    render(<Harness initialClips={clips.map((clip, i) => ({ ...clip, score: undefined, winner: i === 0 ? 'left' : undefined }))} />);
    expect(document.querySelectorAll('.clip-score-annotation')).toHaveLength(1);
    expect(clip('b').querySelector('.clip-score-annotation')).toBeNull();
  });

  it('remaps a paused loop target into the right child and groups boundary drags', () => {
    render(<Harness initialMode="loop" />); position(4);
    fireEvent.click(screen.getByRole('button', { name: 'Razor tool' })); cutAt(300);
    expect(document.querySelectorAll('tr[data-loop-target="true"]')).toHaveLength(1);
    expect(document.querySelector('tr[data-loop-target="true"]')?.textContent).toContain('Rally 2');
    expect(monitor().currentTime).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: 'Undo clip edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Razor tool' }));
    const handle = screen.getByRole('slider', { name: 'Resize clip end 1' });
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 500 });
    fireEvent.pointerMove(handle, { clientX: 480 }); fireEvent.pointerMove(handle, { clientX: 460 });
    fireEvent.pointerUp(handle);
    expect(Number.parseFloat(clip().style.width)).toBeCloseTo(360);
    fireEvent.click(screen.getByRole('button', { name: 'Undo clip edit' }));
    expect(clip().style.width).toBe('400px');
    expect(screen.getByRole('button', { name: 'Undo clip edit' })).toBeDisabled();
  });
});

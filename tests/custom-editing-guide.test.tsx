import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomCutPage } from '../src/renderer/CustomCutPage';
import { messages, type Language } from '../src/renderer/i18n';
import type { AnalysisResultV1 } from '../src/shared/contracts';

const preference = vi.hoisted(() => ({ seen: false, hasSeen: vi.fn(), markSeen: vi.fn() }));
vi.mock('../src/renderer/custom-guide-preference', () => ({ customGuidePreference: preference }));
const initial = [{ clipId: 'a', source: 'manual' as const, sourceRallyId: null, rallyIndex: 1, start: 2, end: 8, defaultStart: 2, defaultEnd: 8, selected: true, bounceCount: 3 }];
const analysis: AnalysisResultV1 = { schema_version: 1, rallies: [], video: { path: '/match.mp4', duration_seconds: 10, width: 1280, height: 720, fps: 30, variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4' } };
const edit = vi.fn(); const undo = vi.fn(); const redo = vi.fn(); const modeChange = vi.fn();

function Harness({ allowed = true, language = 'en', ready = 4 }: { allowed?: boolean; language?: Language; ready?: number }) {
  const [mounted, setMounted] = useState(true);
  useLayoutEffect(() => {
    const video = document.querySelector('video');
    if (!video) return;
    Object.defineProperties(video, { readyState: { configurable: true, value: ready, writable: true }, currentTime: { configurable: true, value: 4, writable: true }, paused: { configurable: true, value: false, writable: true }, videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 720 } });
  }, [mounted, ready]);
  return <><button onClick={() => setMounted(value => !value)}>Mount editor</button>{mounted && <CustomCutPage
    video={{ path: '/match.mp4', name: 'match.mp4', size: 1, mediaUrl: 'ttcut-media://match' }} analysis={analysis} clips={initial}
    playbackMode="source" onPlaybackModeChange={modeChange} translations={messages(language)} language={language} autoGuideAllowed={allowed}
    mediaAvailable onClipsChange={edit} onToggleAll={vi.fn()} outputs={{ combined_video: true, rally_videos: false, premiere_xml: false }}
    onOutputsChange={vi.fn()} onExport={vi.fn()} onReset={vi.fn()} canUndo canRedo onUndo={undo} onRedo={redo} />}</>;
}

beforeEach(() => {
  preference.seen = false;
  preference.hasSeen.mockImplementation(() => preference.seen);
  preference.markSeen.mockImplementation(() => { preference.seen = true; });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); }) });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) { Object.defineProperty(this, 'paused', { configurable: true, value: true, writable: true }); });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.stubGlobal('ttcut', { platform: 'darwin' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('custom editing guide', () => {
  it('automatically opens once, pauses without moving the playhead, and restores focus when closed', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Custom editing guide' });
    const video = document.querySelector('video')!;
    expect(video.paused).toBe(true); expect(video.currentTime).toBe(4);
    expect(within(dialog).getAllByRole('heading', { level: 3 })).toHaveLength(10);
    expect(within(dialog).getByRole('button', { name: 'Close editing guide' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Custom editing guide' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Mount editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mount editor' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Custom editing guide' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(edit).not.toHaveBeenCalled(); expect(modeChange).not.toHaveBeenCalled();
  });

  it('defers the initial guide while another modal is active', () => {
    const view = render(<Harness allowed={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<Harness allowed />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('temporarily yields to a later application modal without marking the guide as read', () => {
    const view = render(<Harness />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.rerender(<Harness allowed={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(preference.markSeen).not.toHaveBeenCalled();
    view.rerender(<Harness allowed />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('blocks background edits and playback but lets modal controls use Space', () => {
    render(<Harness />);
    const close = screen.getByRole('button', { name: 'Close editing guide' });
    for (const event of [{ key: ' ', code: 'Space' }, { key: 'a', code: 'KeyA' }, { key: 'd', code: 'KeyD' }, { key: 'z', metaKey: true }, { key: 'z', metaKey: true, shiftKey: true }]) fireEvent.keyDown(close, event);
    expect(edit).not.toHaveBeenCalled(); expect(undo).not.toHaveBeenCalled(); expect(redo).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(close, { key: ' ', code: 'Space' })).toBe(true);
  });

  it('clears an active tool and closes editing popovers when opened manually', () => {
    preference.seen = true; render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Razor tool' }));
    fireEvent.click(screen.getByRole('button', { name: 'Multi-select' }));
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Start cutting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom editing guide' }));
    expect(screen.getByRole('button', { name: 'Razor tool' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('dialog', { name: 'Multi-select options' })).toBeNull();
    expect(document.querySelector('.custom-export-launcher')).not.toHaveClass('is-open');
  });

  it('cancels a queued play request while metadata is unavailable', () => {
    preference.seen = true; render(<Harness ready={0} />);
    const video = document.querySelector('video')!;
    fireEvent.click(document.querySelector('.custom-rally-table tr')!);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Custom editing guide' }));
    Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
    fireEvent.loadedMetadata(video);
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(2);
    expect(video.paused).toBe(true);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(video.paused).toBe(true);
  });

  it('cycles focus, locates numbered topics and supports native Escape and backdrop dismissal', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog'); const done = screen.getByRole('button', { name: 'Got it' });
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true }); expect(done).toHaveFocus();
    fireEvent.keyDown(done, { key: 'Tab' }); expect(screen.getByRole('button', { name: 'Close editing guide' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '6. Scoreboard and red dots' }));
    expect(screen.getByRole('heading', { name: 'Scoreboard and red dots' })).toHaveFocus();
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Custom editing guide' }));
    fireEvent.click(screen.getByRole('dialog'), { clientX: -1, clientY: -1 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['darwin', 'win32'])('localizes screenshots and platform shortcuts (%s)', platform => {
    vi.stubGlobal('ttcut', { platform });
    render(<Harness language="zh-CN" />);
    const dialog = screen.getByRole('dialog', { name: '自定义操作指南' });
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', expect.stringContaining('custom-guide-zh.png'));
    expect(within(dialog).getByText(platform === 'darwin' ? '⌘Z' : 'Ctrl+Z')).toBeInTheDocument();
    expect(within(dialog).getByText(platform === 'darwin' ? '⌘⇧Z' : 'Ctrl+Y / Ctrl+Shift+Z')).toBeInTheDocument();
  });
});

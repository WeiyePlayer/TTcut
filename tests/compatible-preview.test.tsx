import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCompatiblePreview } from '../src/renderer/use-compatible-preview';

function Harness({ source = 'ttcut-media://media/source' }: { source?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const preview = useCompatiblePreview(ref, source);
  return <><video ref={ref} src={preview.url} /><span>{preview.status}</span></>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup() {
  const prepareVideoPreview = vi.fn().mockResolvedValue('ttcut-media://media/proxy');
  vi.stubGlobal('ttcut', { prepareVideoPreview });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  return prepareVideoPreview;
}

describe('compatible preview recovery', () => {
  it('defers to the native macOS preview pipeline instead of racing a second transcode', () => {
    const prepareVideoPreview = vi.fn();
    vi.stubGlobal('ttcut', { platform: 'darwin', preparePreview: vi.fn(), prepareVideoPreview });
    render(<Harness />);
    const video = document.querySelector('video')!;
    fireEvent.error(video);
    expect(prepareVideoPreview).not.toHaveBeenCalled();
    expect(video).toHaveAttribute('src', 'ttcut-media://media/source');
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('recovers audio-only metadata without waiting for an error event', async () => {
    const prepare = setup();
    render(<Harness />);
    const video = document.querySelector('video')!;
    video.currentTime = 12;
    await act(async () => { fireEvent.loadedMetadata(video); });
    expect(prepare).toHaveBeenCalledExactlyOnceWith('ttcut-media://media/source');
    expect(video.src).toBe('ttcut-media://media/proxy');
    expect(screen.getByText('preparing')).toBeInTheDocument();
    Object.defineProperty(video, 'videoWidth', { value: 1280 });
    Object.defineProperty(video, 'videoHeight', { value: 720 });
    fireEvent.loadedData(video);
    expect(video.currentTime).toBe(12);
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('keeps a decodable source and does not generate a proxy', () => {
    const prepare = setup();
    render(<Harness />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 3840 });
    Object.defineProperty(video, 'videoHeight', { value: 2160 });
    fireEvent.loadedMetadata(video);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not loop when the proxy also fails to decode', async () => {
    const prepare = setup();
    render(<Harness />);
    const video = document.querySelector('video')!;
    await act(async () => { fireEvent.error(video); });
    fireEvent.error(video);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('ignores a completed preparation after switching source videos', async () => {
    const prepare = setup();
    let finish!: (url: string) => void;
    prepare.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const view = render(<Harness />);
    await act(async () => { fireEvent.error(document.querySelector('video')!); });
    view.rerender(<Harness source="ttcut-media://media/other" />);
    await act(async () => { finish('ttcut-media://media/stale'); });
    expect(document.querySelector('video')!.src).toBe('ttcut-media://media/other');
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('recovers when audio advances without decoded video frames', async () => {
    vi.useFakeTimers();
    const prepare = setup();
    render(<Harness />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'paused', { value: false });
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 0 }) as VideoPlaybackQuality;
    fireEvent.playing(video);
    video.currentTime = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCompatiblePreview } from '../src/renderer/use-compatible-preview';

function Harness({ source = 'ttcut-media://media/source' }: { source?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const preview = useCompatiblePreview(ref, source);
  return <><video ref={ref} src={preview.url} /><span>{preview.status}</span><button onClick={() => preview.seekTo(12, true)}>Play clip</button><button onClick={() => preview.seekTo(24, true)}>Next clip</button><button onClick={preview.togglePlayback}>Toggle</button></>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup() {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    Object.defineProperty(video, 'readyState', { value: 2 });
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
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('queues the latest clip until metadata is available', async () => {
    setup();
    const ready = vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(0);
    render(<Harness />);
    const video = document.querySelector('video')!;
    fireEvent.click(screen.getByText('Play clip'));
    fireEvent.click(screen.getByText('Next clip'));
    expect(video.play).not.toHaveBeenCalled();
    Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    ready.mockReturnValue(1);
    await act(async () => { fireEvent.loadedMetadata(video); });
    expect(video.currentTime).toBe(24);
    expect(video.play).toHaveBeenCalledOnce();
  });

  it('preserves a newer clip request made while the proxy is being prepared', async () => {
    const prepare = setup();
    let finish!: (url: string) => void;
    prepare.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    render(<Harness />);
    const video = document.querySelector('video')!;
    await act(async () => { fireEvent.error(video); });
    fireEvent.click(screen.getByText('Next clip'));
    await act(async () => { finish('ttcut-media://media/proxy'); });
    Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    await act(async () => { fireEvent.loadedData(video); });
    expect(video.currentTime).toBe(24);
    expect(video.play).toHaveBeenCalledOnce();
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('honors pause while waiting for proxy readiness', async () => {
    setup(); render(<Harness />);
    const video = document.querySelector('video')!;
    await act(async () => { fireEvent.error(video); });
    fireEvent.click(screen.getByText('Play clip'));
    fireEvent.click(screen.getByText('Toggle'));
    Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    await act(async () => { fireEvent.loadedData(video); });
    expect(video.currentTime).toBe(12);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('retries an interrupted play after canplay without losing the selected time', async () => {
    const prepare = setup(); render(<Harness />);
    const video = document.querySelector('video')!;
    Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    vi.mocked(video.play).mockRejectedValueOnce(new DOMException('Source changed', 'AbortError'));
    await act(async () => { fireEvent.click(screen.getByText('Play clip')); });
    video.currentTime = 0;
    await act(async () => { fireEvent.canPlay(video); });
    expect(video.currentTime).toBe(12);
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('recovers a frozen frame even when neither time nor playing advances', async () => {
    vi.useFakeTimers(); const prepare = setup(); render(<Harness />);
    const video = document.querySelector('video')!;
    Object.defineProperties(video, { videoWidth: { value: 1280 }, videoHeight: { value: 720 }, paused: { value: false } });
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 1 }) as VideoPlaybackQuality;
    fireEvent.play(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('does not transcode when autoplay permission, rather than decoding, rejects play', async () => {
    const prepare = setup(); render(<Harness />);
    const video = document.querySelector('video')!;
    Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    vi.mocked(video.play).mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
    await act(async () => { fireEvent.click(screen.getByText('Play clip')); });
    expect(prepare).not.toHaveBeenCalled();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it.each([true, false])('does not recover a healthy or paused player (paused=%s)', async (paused) => {
    vi.useFakeTimers(); const prepare = setup(); render(<Harness />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'paused', { value: paused });
    let frames = 10;
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: frames }) as VideoPlaybackQuality;
    fireEvent.waiting(video);
    if (!paused) frames = 20;
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(prepare).not.toHaveBeenCalled();
  });

});

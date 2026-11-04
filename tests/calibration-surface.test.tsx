import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalibrationSurface } from '../src/renderer/CalibrationSurface';
import type { Calibration, VideoMetadata } from '../src/shared/contracts';

const video = { path: 'source.mov', name: 'source.mov', size: 100, mediaUrl: 'ttcut-media://media/source' };
const metadata: VideoMetadata = {
  path: video.path, duration_seconds: 60, width: 3840, height: 2160,
  fps: 60, variable_frame_rate: false, video_codec: 'hevc', audio_codec: null, container: 'mov',
};
let extract: ReturnType<typeof vi.fn>;
let prepare: ReturnType<typeof vi.fn>;

beforeEach(() => {
  extract = vi.fn().mockResolvedValue('ttcut-media://media/frame-0');
  prepare = vi.fn();
  vi.stubGlobal('ttcut', { platform: 'win32', extractPreviewFrame: extract, prepareVideoPreview: prepare });
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function surface() {
  return document.querySelector('.video-surface')!;
}
function image() {
  return surface().querySelector('img')!;
}
async function unsupported() {
  await act(async () => { fireEvent.loadedMetadata(surface().querySelector('video')!); });
}
function deferred() {
  let resolve!: (url: string) => void;
  const promise = new Promise<string>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe('calibration frame fallback', () => {
  it('requests the current frame immediately after decoder failure and waits for the image to load', async () => {
    const change = vi.fn();
    render(<CalibrationSurface video={video} metadata={metadata} points={{}} onPointsChange={change} />);
    await unsupported();
    expect(extract).toHaveBeenCalledExactlyOnceWith(video.mediaUrl, 0);
    expect(prepare).not.toHaveBeenCalled();
    expect(image()).toHaveAttribute('src', 'ttcut-media://media/frame-0');
    expect(surface().querySelector('video')).toHaveStyle({ visibility: 'hidden' });
    expect(screen.getByRole('status')).toHaveTextContent('正在加载画面…');
    fireEvent.pointerDown(surface(), { clientX: 100, clientY: 100 });
    expect(change).not.toHaveBeenCalled();
    fireEvent.load(image());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('uses the selected native time when decoding fails after scrubbing', async () => {
    render(<CalibrationSurface video={video} metadata={metadata} points={{}} onPointsChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '12' } });
    await unsupported();
    expect(extract).toHaveBeenCalledExactlyOnceWith(video.mediaUrl, 12);
  });

  it('debounces dragging to the last position while keeping the existing frame visible', async () => {
    vi.useFakeTimers();
    render(<CalibrationSurface video={video} metadata={metadata} points={{}} onPointsChange={vi.fn()} />);
    await unsupported();
    fireEvent.load(image());
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    fireEvent.change(slider, { target: { value: '2' } });
    fireEvent.change(slider, { target: { value: '3' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(199); });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenLastCalledWith(video.mediaUrl, 3);
    expect(surface().querySelector('video')!.currentTime).toBe(0);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('discards old responses during the debounce and after a newer frame is displayed', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    const third = deferred();
    extract.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    render(<CalibrationSurface video={video} metadata={metadata} points={{}} onPointsChange={vi.fn()} />);
    await unsupported();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });
    await act(async () => { first.resolve('ttcut-media://media/obsolete-before-debounce'); });
    expect(image()).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => { third.resolve('ttcut-media://media/latest'); });
    expect(image()).toHaveAttribute('src', 'ttcut-media://media/latest');
    await act(async () => { second.resolve('ttcut-media://media/obsolete-after-latest'); });
    expect(image()).toHaveAttribute('src', 'ttcut-media://media/latest');
  });

  it('maps portrait image coordinates and point positions through letterboxing to original dimensions', async () => {
    const change = vi.fn();
    function Harness() {
      const [points, setPoints] = useState<Partial<Calibration['points']>>({});
      return <CalibrationSurface video={video} metadata={{ ...metadata, width: 2160, height: 3840 }} points={points} onPointsChange={(next) => { change(next); setPoints(next); }} />;
    }
    render(<Harness />);
    await unsupported();
    const rect = { left: 10, top: 20, width: 800, height: 600 } as DOMRect;
    vi.spyOn(surface(), 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(image(), 'getBoundingClientRect').mockReturnValue(rect);
    Object.defineProperties(image(), { naturalWidth: { value: 405 }, naturalHeight: { value: 720 } });
    fireEvent.load(image());
    // The displayed portrait is 337.5 x 600, centered with 231.25px side bars.
    fireEvent.pointerDown(image(), { clientX: 100, clientY: 100 });
    expect(change).not.toHaveBeenCalled();
    fireEvent.pointerDown(image(), { clientX: 325.625, clientY: 470 });
    expect(change).toHaveBeenCalledWith({ top_left: [540, 2880] });
    expect(screen.getByRole('button', { name: 'Calibration point 1' })).toHaveStyle({ left: '315.625px', top: '450px' });
  });

  it('shows extraction failure with retry and ignores cancellation errors', async () => {
    extract.mockRejectedValueOnce(new Error('decoder failed'));
    render(<CalibrationSurface video={video} metadata={metadata} points={{}} onPointsChange={vi.fn()} language="en" />);
    await unsupported();
    expect(screen.getByRole('alert')).toHaveTextContent('Preview could not be loaded.');
    extract.mockRejectedValueOnce(new Error("Error invoking remote method 'video:preview-frame': Error: PREVIEW_CANCELLED"));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading frame…');
  });

  it('retries a failed frame at the latest scrubber position', async () => {
    vi.useFakeTimers();
    extract.mockRejectedValueOnce(new Error('decoder failed'));
    render(<CalibrationSurface video={video} metadata={metadata} points={{}} onPointsChange={vi.fn()} />);
    await unsupported();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '8' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
    expect(extract).toHaveBeenLastCalledWith(video.mediaUrl, 8);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(extract).toHaveBeenCalledTimes(2);
    fireEvent.load(image());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('invalidates pending requests and clears debounce work when the source changes or unmounts', async () => {
    vi.useFakeTimers();
    const first = deferred();
    extract.mockReturnValueOnce(first.promise);
    const props = { video, metadata, points: {}, onPointsChange: vi.fn() };
    const view = render(<CalibrationSurface {...props} />);
    await unsupported();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '8' } });
    view.rerender(<CalibrationSurface {...props} video={{ ...video, mediaUrl: 'ttcut-media://media/other' }} />);
    await act(async () => { first.resolve('ttcut-media://media/old-source'); await vi.advanceTimersByTimeAsync(200); });
    expect(image()).toBeNull();
    expect(screen.getByRole('slider')).toHaveValue('0');
    expect(extract).toHaveBeenCalledTimes(1);
    await unsupported();
    expect(extract).toHaveBeenLastCalledWith('ttcut-media://media/other', 0);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '10' } });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('keeps native Windows decoding and scrubbing when a video track is available', async () => {
    render(<CalibrationSurface video={video} metadata={metadata} points={{}} onPointsChange={vi.fn()} />);
    const element = surface().querySelector('video')!;
    Object.defineProperties(element, { videoWidth: { value: 3840 }, videoHeight: { value: 2160 } });
    fireEvent.loadedMetadata(element);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '12' } });
    expect(element.currentTime).toBe(12);
    expect(image()).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps macOS native preview recovery and never enters frame mode', async () => {
    const native = vi.fn().mockResolvedValue('ttcut-media://media/native-proxy');
    vi.stubGlobal('ttcut', { platform: 'darwin', preparePreview: native, extractPreviewFrame: extract, prepareVideoPreview: prepare });
    render(<CalibrationSurface video={video} metadata={metadata} points={{}} onPointsChange={vi.fn()} />);
    await unsupported();
    await act(async () => { fireEvent.error(surface().querySelector('video')!); });
    expect(native).toHaveBeenCalledWith(video.mediaUrl, expect.any(String));
    expect(extract).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(image()).toBeNull();
  });
});

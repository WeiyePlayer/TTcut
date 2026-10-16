import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportVideoPreview } from '../src/renderer/ExportVideoPreview';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('prepares a Windows HDR export playback proxy while retaining the original source identity', async () => {
  const prepareVideoPreview = vi.fn().mockResolvedValue('ttcut-media://media/sdr-proxy');
  vi.stubGlobal('ttcut', { platform: 'win32', prepareVideoPreview });
  render(<ExportVideoPreview src="ttcut-media://media/hdr-export" hdr controls />);
  await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'ttcut-media://media/sdr-proxy'));
  expect(prepareVideoPreview).toHaveBeenCalledExactlyOnceWith('ttcut-media://media/hdr-export');
});
it('recovers an unsupported Windows export through the existing preview service', async () => {
  const prepareVideoPreview = vi.fn().mockResolvedValue('ttcut-media://media/proxy');
  vi.stubGlobal('ttcut', { platform: 'win32', prepareVideoPreview });
  render(<ExportVideoPreview src="ttcut-media://media/hevc-sdr-export" controls />);
  await act(async () => { fireEvent.error(document.querySelector('video')!); });
  await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'ttcut-media://media/proxy'));
  expect(prepareVideoPreview).toHaveBeenCalledExactlyOnceWith('ttcut-media://media/hevc-sdr-export');
});

it('waits for the HDR proxy before enabling controls and honoring autoplay', async () => {
  let finish!: (value: string) => void;
  const prepareVideoPreview = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.stubGlobal('ttcut', { platform: 'win32', prepareVideoPreview });
  render(<ExportVideoPreview src="ttcut-media://media/hdr-export" hdr autoPlay controls />);
  const video = document.querySelector('video')!;
  expect(video.controls).toBe(false);
  expect(play).not.toHaveBeenCalled();
  await waitFor(() => expect(prepareVideoPreview).toHaveBeenCalledOnce());
  await act(async () => { finish('ttcut-media://media/proxy'); });
  Object.defineProperties(video, { readyState: { configurable: true, value: 4 }, videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 720 } });
  await act(async () => { fireEvent.loadedData(video); });
  expect(video.controls).toBe(true);
  expect(play).toHaveBeenCalledOnce();
});

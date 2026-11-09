import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CompatibleVideo } from '../src/renderer/CompatibleVideo';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  document.documentElement.lang = 'en';
  const preparePreview = vi.fn().mockResolvedValue('ttcut-media://media/proxy');
  const cancelTask = vi.fn().mockResolvedValue(undefined);
  const idleListeners = new Set<() => void>();
  const onTasksIdle = vi.fn((listener: () => void) => { idleListeners.add(listener); return () => { idleListeners.delete(listener); }; });
  const announceIdle = () => act(async () => { for (const listener of [...idleListeners]) listener(); });
  vi.stubGlobal('ttcut', { platform: 'darwin', preparePreview, cancelTask, onTasksIdle });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  return { preparePreview, cancelTask, announceIdle, idleListeners };
}
it('logs a proxy failure without notice while the original stays playable', async () => {
  const { preparePreview } = setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  preparePreview.mockRejectedValueOnce(new Error("Error invoking remote method 'preview': Error: PREVIEW_VALIDATION_FAILED:VIDEO_TRUNCATED"));
  render(<CompatibleVideo src="ttcut-media://media/source" hdr />);
  await act(async () => {});
  expect(document.querySelector('video')).toHaveAttribute('src', 'ttcut-media://media/source');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('PREVIEW_VALIDATION_FAILED:VIDEO_TRUNCATED'));
});
it('shows the native failure once nothing is playable and retries without changing the analysis source', async () => {
  const { preparePreview } = setup();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  preparePreview.mockRejectedValueOnce(new Error("Error invoking remote method 'preview': Error: PREVIEW_VALIDATION_FAILED:VIDEO_TRUNCATED"));
  render(<CompatibleVideo src="ttcut-media://media/source" hdr />);
  await act(async () => {});
  await act(async () => { fireEvent.error(document.querySelector('video')!); });
  expect(preparePreview).toHaveBeenCalledOnce();
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('PREVIEW_VALIDATION_FAILED:VIDEO_TRUNCATED');
  expect(screen.getByRole('alert')).not.toHaveTextContent('remote method');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(preparePreview).toHaveBeenCalledTimes(2);
  expect(preparePreview.mock.calls.every(args => args[0] === 'ttcut-media://media/source')).toBe(true);
  expect(document.querySelector('video')).toHaveAttribute('src', 'ttcut-media://media/proxy');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('exposes a proxy decode failure without looping and reloads a same-URL retry', async () => {
  const { preparePreview } = setup();
  const ref = { current: null as HTMLVideoElement | null };
  render(<CompatibleVideo ref={ref} src="ttcut-media://media/source" />);
  const video = document.querySelector('video')!;
  expect(ref.current).toBe(video);
  await act(async () => { fireEvent.error(video); });
  fireEvent.error(video);
  expect(preparePreview).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert')).toHaveTextContent('Preview playback failed');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(preparePreview).toHaveBeenCalledTimes(2);
  expect(video.load).toHaveBeenCalledOnce();
});
it('ignores stale native completion and cancels its tracked task when switching sources', async () => {
  const { preparePreview, cancelTask } = setup();
  let finish!: (url: string) => void;
  preparePreview.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  const view = render(<CompatibleVideo src="ttcut-media://media/source" hdr />);
  view.rerender(<CompatibleVideo src="ttcut-media://media/other" />);
  await act(async () => { finish('ttcut-media://media/stale'); });
  expect(cancelTask).toHaveBeenCalledOnce();
  expect(document.querySelector('video')).toHaveAttribute('src', 'ttcut-media://media/other');
});
it('prepares the HDR proxy silently while the original keeps playing, then swaps to it', async () => {
  const { preparePreview } = setup();
  let finish!: (url: string) => void;
  preparePreview.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  render(<CompatibleVideo src="ttcut-media://media/source" hdr />);
  expect(preparePreview).toHaveBeenCalledOnce();
  expect(document.querySelector('video')).toHaveAttribute('src', 'ttcut-media://media/source');
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  await act(async () => { finish('ttcut-media://media/proxy'); });
  expect(document.querySelector('video')).toHaveAttribute('src', 'ttcut-media://media/proxy');
  expect(screen.queryByRole('status')).toBeNull();
});
it.each([
  ['preempted by a user task', "Error invoking remote method 'preview': Error: CANCELLED"],
  ['deferred by a busy task slot', "Error invoking remote method 'preview': Error: TASK_BUSY"],
])('keeps the original playing without any notice when the preview is %s', async (_label, message) => {
  const { preparePreview } = setup();
  preparePreview.mockRejectedValueOnce(new Error(message));
  render(<CompatibleVideo src="ttcut-media://media/source" hdr />);
  await act(async () => {});
  expect(preparePreview).toHaveBeenCalledOnce();
  expect(document.querySelector('video')).toHaveAttribute('src', 'ttcut-media://media/source');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});
it('falls back to the playable HDR original when its proxy cannot be decoded', async () => {
  const { preparePreview } = setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  render(<CompatibleVideo src="ttcut-media://media/source" hdr />);
  await act(async () => {});
  const video = document.querySelector('video')!;
  expect(video).toHaveAttribute('src', 'ttcut-media://media/proxy');
  await act(async () => { fireEvent.error(video); });
  expect(video).toHaveAttribute('src', 'ttcut-media://media/source');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(warn).toHaveBeenCalledOnce();
  await act(async () => { fireEvent.error(video); });
  expect(preparePreview).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert')).toHaveTextContent('Preview playback failed');
});
it('resumes a preempted preview exactly once when the user task ends', async () => {
  const { preparePreview, announceIdle } = setup();
  preparePreview.mockRejectedValueOnce(new Error("Error invoking remote method 'preview': Error: CANCELLED"));
  render(<CompatibleVideo src="ttcut-media://media/source" hdr />);
  await act(async () => {});
  expect(preparePreview).toHaveBeenCalledOnce();
  await announceIdle();
  expect(preparePreview).toHaveBeenCalledTimes(2);
  expect(preparePreview).toHaveBeenLastCalledWith('ttcut-media://media/source', expect.any(String));
  expect(document.querySelector('video')).toHaveAttribute('src', 'ttcut-media://media/proxy');
  await announceIdle();
  expect(preparePreview).toHaveBeenCalledTimes(2);
});
it('does not re-prepare a preview that was never deferred', async () => {
  const { preparePreview, announceIdle } = setup();
  render(<CompatibleVideo src="ttcut-media://media/source" hdr />);
  await act(async () => {});
  await announceIdle();
  expect(preparePreview).toHaveBeenCalledOnce();
});
it('stops waiting for the idle event after unmount or a source change', async () => {
  const { preparePreview, announceIdle, idleListeners } = setup();
  preparePreview.mockRejectedValue(new Error("Error invoking remote method 'preview': Error: TASK_BUSY"));
  const view = render(<CompatibleVideo src="ttcut-media://media/source" hdr />);
  await act(async () => {});
  view.rerender(<CompatibleVideo src="ttcut-media://media/other" />);
  await announceIdle();
  expect(preparePreview).toHaveBeenCalledOnce();
  view.rerender(<CompatibleVideo src="ttcut-media://media/third" hdr />);
  await act(async () => {});
  expect(preparePreview).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(idleListeners.size).toBe(0);
  await announceIdle();
  expect(preparePreview).toHaveBeenCalledTimes(2);
});

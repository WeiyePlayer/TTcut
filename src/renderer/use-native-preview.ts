import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativePreviewCommand, NativePreviewEvent, PreviewBounds } from '../shared/native-preview';
import type { PreviewController } from './preview-controller';

export function useNativePreview(source: string, enabled: boolean) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const session = useRef<string | null>(null);
  const onFrame = useRef<(event: Extract<NativePreviewEvent, { type: 'state' }>) => void>(() => undefined);
  const onInput = useRef<(event: NativePreviewEvent) => void>(() => undefined);
  const [status, setStatus] = useState<PreviewController['status']>('preparing');
  const [error, setError] = useState<string | null>(null);
  const actual = useRef({ time: 0, playing: false, seeking: false, sequence: 0 });
  const intent = useRef<{ time: number; playing: boolean; sequence: number } | null>(null);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrub = useRef<Extract<NativePreviewCommand, { type: 'seek' }> | null>(null);
  const failure = useCallback((error: unknown) => { setError(String(error)); setStatus('failed'); }, []);
  const send = useCallback((command: NativePreviewCommand) => {
    const id = session.current;
    if (id) void window.ttcut.nativePreviewCommand!(id, command).catch(failure);
  }, [failure]);
  const seekTo = useCallback((time: number, playing = false, exact = true) => {
    const next = { time, playing, sequence: ++sequence.current };
    intent.current = next;
    const command: Extract<NativePreviewCommand, { type: 'seek' }> = { type: 'seek', ...next, exact };
    if (exact) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null; scrub.current = null; send(command);
    } else {
      scrub.current = command;
      if (!timer.current) timer.current = setTimeout(() => {
        timer.current = null;
        if (scrub.current) send(scrub.current);
        scrub.current = null;
      }, 45);
    }
  }, [send]);
  const getPlaybackIntent = useCallback(() => ({
    time: intent.current?.time ?? actual.current.time,
    playing: intent.current?.playing ?? actual.current.playing,
    pending: intent.current !== null,
    seeking: actual.current.seeking,
  }), []);
  const togglePlayback = useCallback(() => {
    const current = getPlaybackIntent(); seekTo(current.time, !current.playing);
  }, [getPlaybackIntent, seekTo]);
  const retry = useCallback(() => { setStatus('preparing'); setError(null); send({ type: 'retry' }); }, [send]);
  useEffect(() => {
    if (!enabled || !surfaceRef.current) return;
    const surface = surfaceRef.current;
    const id = crypto.randomUUID(); session.current = id;
    const openedAt = performance.now(); delete surface.dataset.firstFrameMs;
    actual.current = { time: 0, playing: false, seeking: false, sequence: 0 }; intent.current = null; sequence.current = 0;
    setStatus('preparing'); setError(null);
    let failed = false, disposed = false, opened = false, frame = 0, lastBounds = '';
    const bounds = (): PreviewBounds => {
      const rect = surface.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: !failed && document.visibilityState !== 'hidden' && !document.querySelector('.modal-backdrop') && rect.width > 0 && rect.height > 0 };
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const value = bounds(); const signature = JSON.stringify(value);
        if (opened && !disposed && signature !== lastBounds) { lastBounds = signature; send({ type: 'bounds', bounds: value }); }
      });
    };
    const off = window.ttcut.onNativePreviewEvent!(event => {
      if (event.sessionId !== id || disposed) return;
      if (event.type === 'error') { failed = true; failure(event.message); update(); }
      else if (event.type === 'loading') { failed = false; setStatus('preparing'); setError(null); update(); }
      else if (event.type === 'state') {
        surface.dataset.time = String(event.time); surface.dataset.paused = String(event.paused);
        surface.setAttribute('aria-pressed', String(!event.paused));
        surface.dataset.ready = String(event.ready); surface.dataset.samples = String(event.samples);
        surface.dataset.decoder = event.decoder; surface.dataset.mode = event.mode; surface.dataset.seeking = String(event.seeking);
        if (!event.ready) return;
        surface.dataset.firstFrameMs ??= String(performance.now() - openedAt);
        setStatus('ready');
        actual.current = { time: event.time, playing: !event.paused && !event.ended, seeking: event.seeking, sequence: event.sequence };
        if (intent.current && event.sequence >= intent.current.sequence && !event.seeking) intent.current = null;
        onFrame.current(event);
      } else onInput.current(event);
    });
    void window.ttcut.nativePreviewOpen!({ sessionId: id, mediaUrl: source, bounds: bounds() }).then(() => { opened = true; update(); }).catch(failure);
    const resize = new ResizeObserver(update); resize.observe(surface);
    const observer = new MutationObserver(update); observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true); document.addEventListener('visibilitychange', update);
    return () => {
      disposed = true; off(); resize.disconnect(); observer.disconnect(); cancelAnimationFrame(frame);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null; scrub.current = null;
      window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); document.removeEventListener('visibilitychange', update);
      if (session.current === id) session.current = null;
      void window.ttcut.nativePreviewClose!(id).catch(() => undefined);
    };
  }, [enabled, source, failure, send]);
  return { native: true as const, status, error, url: source, seekTo, togglePlayback, getPlaybackIntent, retry, surfaceRef, onFrame, onInput, send };
}

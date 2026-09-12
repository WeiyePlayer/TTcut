import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

type PreviewState = { source: string; url: string; status: 'ready' | 'preparing' | 'failed' };

export function useCompatiblePreview(videoRef: RefObject<HTMLVideoElement | null>, source: string) {
  const [state, setState] = useState<PreviewState>({ source, url: source, status: 'ready' });
  // Keep user intent separate from the media element: loading a source/proxy
  // resets currentTime and can abort an outstanding play() promise.
  const pending = useRef<{ source: string; time: number; playing: boolean } | null>(null);
  const preparing = useRef(false);
  const recover = useRef<((reason?: string) => void) | null>(null);
  const applyPending = useCallback(() => {
    const intent = pending.current;
    const video = videoRef.current;
    if (!video || !intent || intent.source !== source || preparing.current) return;
    if (video.readyState < 1) return;
    if (Math.abs(video.currentTime - intent.time) > 0.000001) video.currentTime = intent.time;
    if (!intent.playing) { video.pause(); pending.current = null; return; }
    if (!video.paused) { pending.current = null; return; }
    void Promise.resolve(video.play()).then(() => {
      if (pending.current === intent) pending.current = null;
    }).catch((error: unknown) => {
      if (pending.current !== intent) return;
      // Source replacement/seek interrupts play; loadeddata/canplay retries it.
      const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError') {
        pending.current = null;
        setState((current) => ({ ...current, status: 'failed' }));
        return;
      }
      recover.current?.('play-rejected');
    });
  }, [source, videoRef]);
  const seekTo = useCallback((time: number, playing = false) => {
    pending.current = { source, time, playing };
    applyPending();
  }, [applyPending, source]);
  const getPlaybackIntent = useCallback(() => {
    const video = videoRef.current;
    const intent = pending.current?.source === source ? pending.current : null;
    return {
      time: intent?.time ?? video?.currentTime ?? 0,
      playing: intent?.playing ?? (video ? !video.paused && !video.ended : false),
      pending: intent !== null,
    };
  }, [source, videoRef]);
  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const intent = pending.current?.source === source ? pending.current : null;
    seekTo(intent?.time ?? video.currentTime, !(intent?.playing ?? !video.paused));
  }, [seekTo, source, videoRef]);

  useEffect(() => {
    // macOS has a native preview path with progress, cancellation, HDR tone
    // mapping and a persistent bounded cache. Keep this FFmpeg fallback for
    // other platforms so the two proxy generators cannot race each other.
    const nativePreview = window.ttcut?.platform === 'darwin' && window.ttcut.preparePreview;
    const video = videoRef.current;
    if (!video) return;
    preparing.current = false;
    if (pending.current?.source !== source) pending.current = null;
    let disposed = false;
    let attempted = false;
    let proxy = false;
    let resumeTime = 0;
    let resumePlayback = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    setState({ source, url: source, status: 'ready' });

    const fallback = (reason: string | Event = 'media-error') => {
      if (disposed || nativePreview) return;
      if (proxy) {
        setState((current) => ({ ...current, status: 'failed' }));
        return;
      }
      if (attempted) return;
      attempted = true;
      console.warn('[preview] Recovery requested', JSON.stringify({
        reason: typeof reason === 'string' ? reason : 'media-error',
        mediaError: video.error?.code ?? null, readyState: video.readyState,
        currentTime: video.currentTime, paused: video.paused,
        frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
      }));
      resumeTime = pending.current?.time ?? (Number.isFinite(video.currentTime) ? video.currentTime : 0);
      resumePlayback = pending.current?.playing ?? !video.paused;
      pending.current ??= { source, time: resumeTime, playing: resumePlayback };
      preparing.current = true;
      video.pause();
      setState({ source, url: source, status: 'preparing' });
      void Promise.resolve().then(() => window.ttcut.prepareVideoPreview(source)).then((url) => {
        if (disposed) return;
        proxy = true;
        setState({ source, url, status: 'preparing' });
      }).catch(() => {
        if (!disposed) setState({ source, url: source, status: 'failed' });
      });
    };
    const metadata = () => {
      // Chromium may accept the audio track and emit loadedmetadata without
      // raising MediaError when the HEVC video track is unsupported.
      if (!video.videoWidth || !video.videoHeight) fallback('missing-video-track');
      else applyPending();
    };
    const loaded = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      if (proxy && preparing.current) {
        preparing.current = false;
        pending.current ??= { source, time: Math.min(resumeTime, Number.isFinite(video.duration) ? video.duration : resumeTime), playing: resumePlayback };
        setState((current) => ({ ...current, status: 'ready' }));
      }
      applyPending();
    };
    const playing = () => {
      if (watchdog) clearTimeout(watchdog);
      const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      const start = video.currentTime;
      watchdog = setTimeout(() => {
        const unchanged = typeof video.getVideoPlaybackQuality === 'function'
          ? video.getVideoPlaybackQuality().totalVideoFrames === frames
          : video.currentTime <= start;
        // A stalled decoder may never emit `playing` or advance currentTime.
        if (!video.paused && unchanged) fallback('stalled-video');
      }, 8000);
    };
    recover.current = fallback;
    video.addEventListener('canplay', loaded);
    video.addEventListener('error', fallback);
    video.addEventListener('loadedmetadata', metadata);
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('play', playing);
    video.addEventListener('seeking', playing);
    video.addEventListener('waiting', playing);
    video.addEventListener('stalled', playing);
    video.addEventListener('playing', playing);
    if (video.error) fallback();
    else if (video.readyState >= 1) metadata();
    return () => {
      disposed = true;
      recover.current = null;
      video.removeEventListener('canplay', loaded);
      if (watchdog) clearTimeout(watchdog);
      video.removeEventListener('error', fallback);
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('play', playing);
      video.removeEventListener('seeking', playing);
      video.removeEventListener('waiting', playing);
      video.removeEventListener('stalled', playing);
      video.removeEventListener('playing', playing);
    };
  }, [source, videoRef, applyPending]);
  return { ...(state.source === source ? state : { source, url: source, status: 'ready' as const }), seekTo, togglePlayback, getPlaybackIntent };
}

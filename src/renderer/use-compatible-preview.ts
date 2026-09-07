import { useEffect, useState, type RefObject } from 'react';

type PreviewState = { source: string; url: string; status: 'ready' | 'preparing' | 'failed' };

export function useCompatiblePreview(videoRef: RefObject<HTMLVideoElement | null>, source: string) {
  const [state, setState] = useState<PreviewState>({ source, url: source, status: 'ready' });
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    let attempted = false;
    let proxy = false;
    let resumeTime = 0;
    let resumePlayback = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    setState({ source, url: source, status: 'ready' });

    const fallback = () => {
      if (disposed) return;
      if (proxy) {
        setState((current) => ({ ...current, status: 'failed' }));
        return;
      }
      if (attempted) return;
      attempted = true;
      resumeTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      resumePlayback = !video.paused;
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
      if (!video.videoWidth || !video.videoHeight) fallback();
    };
    const loaded = () => {
      if (!proxy || !video.videoWidth || !video.videoHeight) return;
      video.currentTime = Math.min(resumeTime, Number.isFinite(video.duration) ? video.duration : resumeTime);
      setState((current) => ({ ...current, status: 'ready' }));
      if (resumePlayback) void video.play().catch(() => undefined);
    };
    const playing = () => {
      if (watchdog) clearTimeout(watchdog);
      const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      const start = video.currentTime;
      watchdog = setTimeout(() => {
        if (!video.paused && video.currentTime > start + 0.5
          && (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) === frames) fallback();
      }, 2500);
    };
    video.addEventListener('error', fallback);
    video.addEventListener('loadedmetadata', metadata);
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('playing', playing);
    if (video.error) fallback();
    else if (video.readyState >= 1) metadata();
    return () => {
      disposed = true;
      if (watchdog) clearTimeout(watchdog);
      video.removeEventListener('error', fallback);
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('playing', playing);
    };
  }, [source, videoRef]);
  return state.source === source ? state : { source, url: source, status: 'ready' as const };
}

import { CompatibleVideo } from './CompatibleVideo';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Calibration, VideoMetadata } from '../shared/contracts';
import type { SelectedVideo } from '../shared/api';
import { formatTimestamp } from '../domain/time';
import { fittedVideoRectangle } from '../domain/video-input';
import { orderCalibrationPolygon, type CalibrationPoint } from '../domain/calibration';
import { useCompatiblePreview } from './use-compatible-preview';
import { messages, type Language } from './i18n';

type PointName = keyof Calibration['points'];

const pointOrder: PointName[] = ['top_left', 'top_right', 'bottom_right', 'bottom_left'];

export function CalibrationSurface({
  video, metadata, points, onPointsChange, language = 'zh-CN',
}: {
  video: SelectedVideo;
  metadata: VideoMetadata;
  points: Partial<Record<PointName, [number, number]>>;
  onPointsChange: (points: Partial<Record<PointName, [number, number]>>) => void;
  language?: Language;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLImageElement>(null);
  const preview = useCompatiblePreview(videoRef, video.mediaUrl, undefined,
    window.ttcut?.platform === 'darwin' ? undefined : { fallback: 'report' });
  const frameMode = window.ttcut?.platform !== 'darwin' && preview.status === 'unsupported';
  const t = messages(language);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const currentTimeRef = useRef(0);
  const [frame, setFrame] = useState<{ source: string; url: string; loaded: boolean } | null>(null);
  const [frameError, setFrameError] = useState(false);
  const frameGeneration = useRef(0);
  const frameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentFrame = frame?.source === video.mediaUrl ? frame : null;
  const hasFrame = Boolean(currentFrame?.loaded);
  const canCalibrate = frameMode ? hasFrame : preview.status === 'ready';
  const dragging = useRef<PointName | null>(null);

  const requestFrame = useCallback((seconds: number, generation = ++frameGeneration.current) => {
    if (generation !== frameGeneration.current) return;
    clearTimeout(frameTimer.current);
    setFrameError(false);
    void Promise.resolve().then(() => {
      if (generation !== frameGeneration.current) throw new Error('PREVIEW_CANCELLED');
      if (!window.ttcut.extractPreviewFrame) throw new Error('PREVIEW_FRAME_UNSUPPORTED');
      return window.ttcut.extractPreviewFrame(video.mediaUrl, seconds);
    }).then((url) => {
      if (generation !== frameGeneration.current) return;
      setFrame((previous) => ({ source: video.mediaUrl, url, loaded: previous?.source === video.mediaUrl && previous.loaded }));
    }).catch((error: unknown) => {
      if (generation !== frameGeneration.current || String(error).includes('PREVIEW_CANCELLED')) return;
      console.warn('[preview] Frame extraction failed', error);
      setFrameError(true);
    });
  }, [video.mediaUrl]);

  useEffect(() => {
    currentTimeRef.current = 0;
    setCurrentTime(0);
    dragging.current = null;
  }, [video.mediaUrl]);

  useEffect(() => {
    frameGeneration.current++;
    setFrame(null);
    setFrameError(false);
    if (frameMode) requestFrame(currentTimeRef.current);
    return () => {
      frameGeneration.current++;
      clearTimeout(frameTimer.current);
    };
  }, [frameMode, requestFrame]);

  const displayedMedia = useCallback(() => {
    if (frameMode) {
      const element = frameRef.current;
      if (!element?.naturalWidth || !element.naturalHeight) return null;
      return { rect: element.getBoundingClientRect(), width: element.naturalWidth, height: element.naturalHeight };
    }
    const element = videoRef.current;
    if (!element) return null;
    return { rect: element.getBoundingClientRect(), width: element.videoWidth || metadata.width, height: element.videoHeight || metadata.height };
  }, [frameMode, metadata]);

  const toSource = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const media = displayedMedia();
    if (!media) return null;
    const fitted = fittedVideoRectangle(media.rect, media.width, media.height);
    if (!fitted.width || !fitted.height) return null;
    const normalizedX = (clientX - fitted.left) / fitted.width;
    const normalizedY = (clientY - fitted.top) / fitted.height;
    if (normalizedX < 0 || normalizedY < 0 || normalizedX >= 1 || normalizedY >= 1) return null;
    return [
      Math.max(0, Math.min(metadata.width - 1, normalizedX * metadata.width)),
      Math.max(0, Math.min(metadata.height - 1, normalizedY * metadata.height)),
    ];
  }, [metadata, displayedMedia]);

  const sourceToSurface = (point: [number, number]): CalibrationPoint => {
    const surface = surfaceRef.current;
    const media = displayedMedia();
    if (!surface || !media) return [0, 0];
    const parent = surface.getBoundingClientRect();
    const fitted = fittedVideoRectangle(
      media.rect, media.width, media.height,
    );
    const x = fitted.left - parent.left + point[0] / metadata.width * fitted.width;
    const y = fitted.top - parent.top + point[1] / metadata.height * fitted.height;
    return [x, y];
  };

  const sourceToPosition = (point: [number, number]) => {
    const [x, y] = sourceToSurface(point);
    return { left: `${x}px`, top: `${y}px` };
  };

  const setAtPointer = (event: ReactPointerEvent, name?: PointName) => {
    if (!canCalibrate) return;
    const next = toSource(event.clientX, event.clientY);
    if (!next) return;
    const target = name ?? pointOrder.find((item) => !points[item]);
    if (target) onPointsChange({ ...points, [target]: next });
  };

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const update = () => {
      if (frameMode) return;
      currentTimeRef.current = element.currentTime;
      setCurrentTime(element.currentTime);
    };
    element.addEventListener('timeupdate', update);
    return () => element.removeEventListener('timeupdate', update);
  }, [frameMode]);

  const completePoints = pointOrder
    .map((name) => points[name])
    .filter((point): point is CalibrationPoint => point !== undefined);
  const polygon = completePoints.length === 4
    ? orderCalibrationPolygon(completePoints).map(sourceToSurface)
    : [];

  return (
    <div className="calibration-shell">
      <div
        className="video-surface"
        ref={surfaceRef}
        onPointerDown={(event) => {
          if (!canCalibrate) return;
          if ((event.target as HTMLElement).closest('.calibration-point')) return;
          setAtPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) setAtPointer(event, dragging.current);
        }}
        onPointerUp={() => { dragging.current = null; }}
      >
        <CompatibleVideo hdr={Boolean(metadata.native_video && metadata.native_video.hdr !== 'sdr')} ref={videoRef} src={preview.url} style={frameMode ? { visibility: 'hidden' } : undefined} preload={preview.url === video.mediaUrl ? 'metadata' : 'auto'} muted playsInline />
        {frameMode && currentFrame && <img ref={frameRef} src={currentFrame.url} alt=""
          onLoad={() => setFrame((current) => current?.url === currentFrame.url ? { ...current, loaded: true } : current)}
          onError={() => setFrameError(true)} />}
        {(frameMode ? frameError || !hasFrame : preview.status !== 'ready') && <div
          className="custom-preview-status"
          role={(frameMode ? frameError : preview.status === 'failed') ? 'alert' : 'status'}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span>{frameMode ? (frameError ? t.previewFailed : t.previewFrameLoading) : (preview.status === 'preparing' ? t.previewPreparing : t.previewFailed)}</span>
          {(frameMode ? frameError : preview.status === 'failed') && <button type="button" onClick={() => {
            if (frameMode) requestFrame(currentTimeRef.current);
            else preview.retry();
          }}>{t.previewRetry}</button>}
        </div>}
        {polygon.length === 4 && (
          <svg className="calibration-polygon" aria-hidden="true">
            <polygon points={polygon.map(([x, y]) => `${x},${y}`).join(' ')} />
          </svg>
        )}
        {pointOrder.map((name, index) => points[name] && (
          <button
            type="button"
            key={name}
            className="calibration-point"
            style={sourceToPosition(points[name]!)}
            aria-label={`Calibration point ${index + 1}`}
            onPointerDown={(event) => {
              if (!canCalibrate) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragging.current = name;
              event.stopPropagation();
            }}
            onPointerMove={(event) => {
              if (dragging.current === name) setAtPointer(event, name);
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId);
              dragging.current = null;
            }}
          >{index + 1}</button>
        ))}
      </div>
      <div className="scrubber-row">
        <span>{formatTimestamp(currentTime)}</span>
        <input
          aria-label="Video position"
          type="range"
          min={0}
          max={metadata.duration_seconds}
          step={0.01}
          value={currentTime}
          onChange={(event) => {
            const value = Number(event.target.value);
            currentTimeRef.current = value;
            setCurrentTime(value);
            if (frameMode) {
              // Invalidate in-flight responses immediately, including while the
              // trailing debounce has not submitted the next extraction yet.
              const generation = ++frameGeneration.current;
              clearTimeout(frameTimer.current);
              frameTimer.current = setTimeout(() => requestFrame(value, generation), 200);
            } else if (videoRef.current) videoRef.current.currentTime = value;
          }}
        />
        <span>{formatTimestamp(metadata.duration_seconds)}</span>
      </div>
    </div>
  );
}

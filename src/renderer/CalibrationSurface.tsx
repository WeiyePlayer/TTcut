import { CompatibleVideo } from './CompatibleVideo';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Calibration, VideoMetadata } from '../shared/contracts';
import type { SelectedVideo } from '../shared/api';
import { formatTimestamp } from '../domain/time';
import { fittedVideoRectangle } from '../domain/video-input';
import { orderCalibrationPolygon, type CalibrationPoint } from '../domain/calibration';

type PointName = keyof Calibration['points'];

const pointOrder: PointName[] = ['top_left', 'top_right', 'bottom_right', 'bottom_left'];

export function CalibrationSurface({
  video, metadata, points, onPointsChange,
}: {
  video: SelectedVideo;
  metadata: VideoMetadata;
  points: Partial<Record<PointName, [number, number]>>;
  onPointsChange: (points: Partial<Record<PointName, [number, number]>>) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const dragging = useRef<PointName | null>(null);

  const toSource = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const element = videoRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const intrinsicWidth = element.videoWidth || metadata.width;
    const intrinsicHeight = element.videoHeight || metadata.height;
    const fitted = fittedVideoRectangle(rect, intrinsicWidth, intrinsicHeight);
    const normalizedX = (clientX - fitted.left) / fitted.width;
    const normalizedY = (clientY - fitted.top) / fitted.height;
    if (normalizedX < 0 || normalizedY < 0 || normalizedX >= 1 || normalizedY >= 1) return null;
    return [
      Math.max(0, Math.min(metadata.width - 1, normalizedX * metadata.width)),
      Math.max(0, Math.min(metadata.height - 1, normalizedY * metadata.height)),
    ];
  }, [metadata]);

  const sourceToSurface = (point: [number, number]): CalibrationPoint => {
    const surface = surfaceRef.current;
    const element = videoRef.current;
    if (!surface || !element) return [0, 0];
    const rect = element.getBoundingClientRect();
    const parent = surface.getBoundingClientRect();
    const fitted = fittedVideoRectangle(
      rect,
      element.videoWidth || metadata.width,
      element.videoHeight || metadata.height,
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
    const next = toSource(event.clientX, event.clientY);
    if (!next) return;
    const target = name ?? pointOrder.find((item) => !points[item]);
    if (target) onPointsChange({ ...points, [target]: next });
  };

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const update = () => setCurrentTime(element.currentTime);
    element.addEventListener('timeupdate', update);
    return () => element.removeEventListener('timeupdate', update);
  }, []);

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
          if ((event.target as HTMLElement).closest('.calibration-point')) return;
          setAtPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) setAtPointer(event, dragging.current);
        }}
        onPointerUp={() => { dragging.current = null; }}
      >
        <CompatibleVideo hdr={Boolean(metadata.native_video && metadata.native_video.hdr !== 'sdr')} ref={videoRef} src={video.mediaUrl} preload="metadata" muted playsInline />
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
            setCurrentTime(value);
            if (videoRef.current) videoRef.current.currentTime = value;
          }}
        />
        <span>{formatTimestamp(metadata.duration_seconds)}</span>
      </div>
    </div>
  );
}

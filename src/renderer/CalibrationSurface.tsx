import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Calibration, VideoMetadata } from '../shared/contracts';
import type { SelectedVideo } from '../shared/api';
import { formatTimestamp } from '../domain/time';

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
    const scale = Math.min(rect.width / metadata.width, rect.height / metadata.height);
    const renderedWidth = metadata.width * scale;
    const renderedHeight = metadata.height * scale;
    const offsetX = rect.left + (rect.width - renderedWidth) / 2;
    const offsetY = rect.top + (rect.height - renderedHeight) / 2;
    const x = (clientX - offsetX) / scale;
    const y = (clientY - offsetY) / scale;
    if (x < 0 || y < 0 || x >= metadata.width || y >= metadata.height) return null;
    return [Math.max(0, Math.min(metadata.width - 1, x)), Math.max(0, Math.min(metadata.height - 1, y))];
  }, [metadata]);

  const sourceToPercent = (point: [number, number]) => {
    const surface = surfaceRef.current;
    const element = videoRef.current;
    if (!surface || !element) return { left: '50%', top: '50%' };
    const rect = element.getBoundingClientRect();
    const parent = surface.getBoundingClientRect();
    const scale = Math.min(rect.width / metadata.width, rect.height / metadata.height);
    const renderedWidth = metadata.width * scale;
    const renderedHeight = metadata.height * scale;
    const x = rect.left - parent.left + (rect.width - renderedWidth) / 2 + point[0] * scale;
    const y = rect.top - parent.top + (rect.height - renderedHeight) / 2 + point[1] * scale;
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
        <video ref={videoRef} src={video.mediaUrl} preload="metadata" muted playsInline />
        {pointOrder.map((name, index) => points[name] && (
          <button
            type="button"
            key={name}
            className="calibration-point"
            style={sourceToPercent(points[name]!)}
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

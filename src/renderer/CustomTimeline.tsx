import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CustomRallyClip } from '../domain/custom-clips';

const RULER_HEIGHT = 34;
const LABEL_SPACING = 150;

type Edge = 'start' | 'end';

type ResizeFeedback = {
  rallyId: string;
  edge: Edge;
  boundaryTime: number;
  durationDelta: number;
};

export function chooseTimelineInterval(secondsPerPixel: number): number {
  const target = secondsPerPixel * LABEL_SPACING;
  const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return intervals.find((interval) => interval >= target) ?? 7200;
}

export function formatTimelineLabel(value: number): string {
  if (value >= 60 && value % 60 === 0) return `${value / 60}′`;
  if (value < 60) return `${value}″`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes}′${String(seconds).padStart(2, '0')}″`;
}

export function formatResizeDelta(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return '0.00 s';
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)} s`;
}

export function timelineWheelDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  viewportWidth: number,
): number {
  const rawDelta = Math.abs(deltaX) > 0.01 ? deltaX : deltaY;
  if (deltaMode === 1) return rawDelta * 16;
  if (deltaMode === 2) return rawDelta * viewportWidth;
  return rawDelta;
}

export function timelineWheelScroll(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  deltaX: number,
  deltaY: number,
  deltaMode: number,
): { nextScroll: number; shouldPreventDefault: boolean } {
  const maximumScroll = Math.max(0, scrollWidth - clientWidth);
  if (maximumScroll <= 0) return { nextScroll: scrollLeft, shouldPreventDefault: false };
  const delta = timelineWheelDelta(deltaX, deltaY, deltaMode, clientWidth);
  if (delta === 0) return { nextScroll: scrollLeft, shouldPreventDefault: false };
  const nextScroll = Math.max(0, Math.min(maximumScroll, scrollLeft + delta));
  return {
    nextScroll,
    shouldPreventDefault: Math.abs(nextScroll - scrollLeft) >= 0.01,
  };
}

export function CustomTimeline({
  clips,
  duration,
  fps,
  currentTime,
  timelineLabel,
  resizeStartLabel,
  resizeEndLabel,
  onSeek,
  onPlayClip,
  onResize,
}: {
  clips: readonly CustomRallyClip[];
  duration: number;
  fps: number;
  currentTime: number;
  timelineLabel: string;
  resizeStartLabel: string;
  resizeEndLabel: string;
  onSeek: (time: number) => void;
  onPlayClip: (clip: CustomRallyClip) => void;
  onResize: (rallyId: string, edge: Edge, time: number) => number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewportWidth, setViewportWidth] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [resizeFeedback, setResizeFeedback] = useState<ResizeFeedback | null>(null);
  const playheadDraggingRef = useRef<number | null>(null);
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>(() => undefined);
  const draggingRef = useRef<{
    pointerId: number;
    rallyId: string;
    edge: Edge;
    startX: number;
    initialTime: number;
  } | null>(null);

  const maximumZoom = Math.max(1, duration * 150 / viewportWidth);
  const actualZoom = Math.min(zoom, maximumZoom);
  const contentWidth = Math.max(viewportWidth, viewportWidth * actualZoom);
  const pixelsPerSecond = contentWidth / Math.max(duration, 0.001);
  const selectedClips = useMemo(() => clips.filter((clip) => clip.selected), [clips]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setViewportWidth(Math.max(1, viewport.clientWidth));
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const drawRuler = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = viewportWidth;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.round(RULER_HEIGHT * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${RULER_HEIGHT}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, RULER_HEIGHT);
    context.fillStyle = '#6e6e73';
    context.strokeStyle = 'rgba(29, 29, 31, .22)';
    context.font = '11px InterVariable, Segoe UI, sans-serif';
    context.textBaseline = 'top';
    const interval = chooseTimelineInterval(1 / pixelsPerSecond);
    const minor = interval / 5;
    const visibleStart = scrollLeft / pixelsPerSecond;
    const visibleEnd = Math.min(duration, (scrollLeft + width) / pixelsPerSecond);
    const firstMinor = Math.max(0, Math.floor(visibleStart / minor) * minor);
    for (let time = firstMinor; time <= visibleEnd + minor / 2; time += minor) {
      const x = Math.round(time * pixelsPerSecond - scrollLeft) + 0.5;
      const major = Math.abs(time / interval - Math.round(time / interval)) < 0.001;
      context.beginPath();
      context.moveTo(x, major ? 19 : 25);
      context.lineTo(x, RULER_HEIGHT);
      context.stroke();
      if (major && time > 0) {
        const atRightEdge = duration - time < minor / 2;
        context.textAlign = atRightEdge ? 'right' : 'left';
        context.fillText(formatTimelineLabel(Math.round(time)), x + (atRightEdge ? -4 : 4), 3);
      }
    }
  }, [duration, pixelsPerSecond, scrollLeft, viewportWidth]);

  useEffect(drawRuler, [drawRuler]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || duration <= 0) return;
    const x = currentTime * pixelsPerSecond;
    const margin = Math.min(90, viewport.clientWidth * 0.15);
    if (x < viewport.scrollLeft + margin || x > viewport.scrollLeft + viewport.clientWidth - margin) {
      viewport.scrollLeft = Math.max(0, x - viewport.clientWidth * 0.35);
    }
  }, [currentTime, duration, pixelsPerSecond]);

  const setZoomAnchored = (nextZoom: number, anchorClientX?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounded = Math.max(1, Math.min(maximumZoom, nextZoom));
    const rect = viewport.getBoundingClientRect();
    const anchor = anchorClientX === undefined ? viewport.clientWidth / 2 : anchorClientX - rect.left;
    const time = (viewport.scrollLeft + anchor) / pixelsPerSecond;
    setZoom(bounded);
    window.requestAnimationFrame(() => {
      const nextPixelsPerSecond = Math.max(viewport.clientWidth, viewport.clientWidth * bounded) / Math.max(duration, 0.001);
      viewport.scrollLeft = Math.max(0, time * nextPixelsPerSecond - anchor);
    });
  };

  wheelHandlerRef.current = (event) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (event.ctrlKey) {
      const zoomDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (zoomDelta === 0) return;
      event.preventDefault();
      setZoomAnchored(actualZoom * (zoomDelta < 0 ? 1.18 : 1 / 1.18), event.clientX);
      return;
    }

    const { nextScroll, shouldPreventDefault } = timelineWheelScroll(
      viewport.scrollLeft,
      viewport.clientWidth,
      viewport.scrollWidth,
      event.deltaX,
      event.deltaY,
      event.deltaMode,
    );
    if (!shouldPreventDefault) return;
    event.preventDefault();
    viewport.scrollLeft = nextScroll;
    setScrollLeft(nextScroll);
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => wheelHandlerRef.current(event);
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, []);

  const seekFromPointer = (clientX: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const x = clientX - viewport.getBoundingClientRect().left + viewport.scrollLeft;
    onSeek(Math.max(0, Math.min(duration, x / pixelsPerSecond)));
  };

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>, clip: CustomRallyClip, edge: Edge) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = {
      pointerId: event.pointerId,
      rallyId: clip.rallyId,
      edge,
      startX: event.clientX,
      initialTime: edge === 'start' ? clip.start : clip.end,
    };
    setResizeFeedback({
      rallyId: clip.rallyId,
      edge,
      boundaryTime: edge === 'start' ? clip.start : clip.end,
      durationDelta: 0,
    });
  };

  const moveResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragging = draggingRef.current;
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const boundaryTime = onResize(
      dragging.rallyId,
      dragging.edge,
      dragging.initialTime + (event.clientX - dragging.startX) / pixelsPerSecond,
    );
    setResizeFeedback({
      rallyId: dragging.rallyId,
      edge: dragging.edge,
      boundaryTime,
      durationDelta: dragging.edge === 'start'
        ? dragging.initialTime - boundaryTime
        : boundaryTime - dragging.initialTime,
    });
  };

  const endResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (draggingRef.current?.pointerId !== event.pointerId) return;
    draggingRef.current = null;
    setResizeFeedback(null);
  };

  const keyboardResize = (event: React.KeyboardEvent<HTMLButtonElement>, clip: CustomRallyClip, edge: Edge) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 1 / Math.max(fps, 1);
    const current = edge === 'start' ? clip.start : clip.end;
    onResize(clip.rallyId, edge, current + (event.key === 'ArrowLeft' ? -step : step));
  };

  const beginPlayheadDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    playheadDraggingRef.current = event.pointerId;
    setIsScrubbing(true);
    seekFromPointer(event.clientX);
  };

  const movePlayhead = (event: React.PointerEvent<HTMLDivElement>) => {
    if (playheadDraggingRef.current !== event.pointerId) return;
    seekFromPointer(event.clientX);
  };

  const endPlayheadDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (playheadDraggingRef.current !== event.pointerId) return;
    seekFromPointer(event.clientX);
    playheadDraggingRef.current = null;
    setIsScrubbing(false);
  };

  const cancelPlayheadDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (playheadDraggingRef.current !== event.pointerId) return;
    playheadDraggingRef.current = null;
    setIsScrubbing(false);
  };

  const keyboardSeek = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      onSeek(event.key === 'Home' ? 0 : duration);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 1 / Math.max(fps, 1);
    onSeek(currentTime + (event.key === 'ArrowLeft' ? -step : step));
  };

  return (
    <section className="custom-timeline" aria-label={timelineLabel}>
      <div
        ref={viewportRef}
        className="timeline-viewport"
        data-zoom={actualZoom}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
      >
        <div className="timeline-content" style={{ width: contentWidth }}>
          <div className="timeline-ruler" onPointerDown={(event) => seekFromPointer(event.clientX)}>
            <canvas ref={canvasRef} style={{ transform: `translateX(${scrollLeft}px)` }} />
          </div>
          <div className="timeline-track">
            {selectedClips.map((clip, index) => {
              const left = clip.start * pixelsPerSecond;
              const width = Math.max(1, (clip.end - clip.start) * pixelsPerSecond);
              const minimumDuration = 1 / Math.max(fps, 1);
              const previous = selectedClips[index - 1];
              const following = selectedClips[index + 1];
              return (
                <div
                  key={clip.rallyId}
                  className="timeline-clip"
                  data-rally-id={clip.rallyId}
                  style={{ left, width }}
                  onPointerDown={() => onPlayClip(clip)}
                >
                  <button
                    type="button"
                    className="clip-handle start"
                    role="slider"
                    aria-orientation="horizontal"
                    aria-label={`${resizeStartLabel} ${clip.rallyIndex}`}
                    aria-valuemin={previous?.end ?? 0}
                    aria-valuemax={clip.end - minimumDuration}
                    aria-valuenow={clip.start}
                    onPointerDown={(event) => beginResize(event, clip, 'start')}
                    onPointerMove={moveResize}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    onLostPointerCapture={endResize}
                    onKeyDown={(event) => keyboardResize(event, clip, 'start')}
                  />
                  <span>{clip.rallyIndex}</span>
                  <button
                    type="button"
                    className="clip-handle end"
                    role="slider"
                    aria-orientation="horizontal"
                    aria-label={`${resizeEndLabel} ${clip.rallyIndex}`}
                    aria-valuemin={clip.start + minimumDuration}
                    aria-valuemax={following?.start ?? duration}
                    aria-valuenow={clip.end}
                    onPointerDown={(event) => beginResize(event, clip, 'end')}
                    onPointerMove={moveResize}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    onLostPointerCapture={endResize}
                    onKeyDown={(event) => keyboardResize(event, clip, 'end')}
                  />
                </div>
              );
            })}
          </div>
          {resizeFeedback ? (
            <div
              className="resize-feedback"
              style={{ left: resizeFeedback.boundaryTime * pixelsPerSecond }}
              data-rally-id={resizeFeedback.rallyId}
              data-edge={resizeFeedback.edge}
            >
              {formatResizeDelta(resizeFeedback.durationDelta)}
            </div>
          ) : null}
          <div
            className={`timeline-playhead${isScrubbing ? ' dragging' : ''}`}
            style={{ left: currentTime * pixelsPerSecond }}
            role="slider"
            aria-orientation="horizontal"
            tabIndex={0}
            aria-label={timelineLabel}
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={currentTime}
            onPointerDown={beginPlayheadDrag}
            onPointerMove={movePlayhead}
            onPointerUp={endPlayheadDrag}
            onPointerCancel={cancelPlayheadDrag}
            onLostPointerCapture={cancelPlayheadDrag}
            onKeyDown={keyboardSeek}
          ><i /></div>
        </div>
      </div>
    </section>
  );
}

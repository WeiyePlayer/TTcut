import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CustomRallyClip } from '../domain/custom-clips';

const RULER_HEIGHT = 34;
const LABEL_SPACING = 150;
const CLIP_EDGE_HIT_OUTSET = 8;
const CLIP_EDGE_HIT_INSET = 4;
const CLIP_BOUNDARY_MARKER_MIN_WIDTH = 24;

export type TimelineToolMode = 'add' | 'delete' | null;
type Edge = 'start' | 'end';

type ResizeFeedback = {
  clipId: string;
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

export function clipEdgeHitWidth(clipWidth: number): number {
  const safeWidth = Number.isFinite(clipWidth) ? Math.max(0, clipWidth) : 0;
  return CLIP_EDGE_HIT_OUTSET + Math.min(CLIP_EDGE_HIT_INSET, safeWidth / 2);
}

export function shouldShowClipBoundaryMarkers(clipWidth: number): boolean {
  return Number.isFinite(clipWidth) && clipWidth >= CLIP_BOUNDARY_MARKER_MIN_WIDTH;
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
  return { nextScroll, shouldPreventDefault: Math.abs(nextScroll - scrollLeft) >= 0.01 };
}

export function clampTimelineScrollLeft(scrollLeft: number, viewportWidth: number, contentWidth: number): number {
  const safeScrollLeft = Number.isFinite(scrollLeft) ? scrollLeft : 0;
  const maximumScroll = Math.max(0, contentWidth - viewportWidth);
  return Math.max(0, Math.min(maximumScroll, safeScrollLeft));
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h16M10 11v6m4-6v6M9 7l.8-2h4.4l.8 2M6.5 7l.8 12h9.4l.8-12" />
    </svg>
  );
}

export function CustomTimeline({
  clips,
  duration,
  fps,
  currentTime,
  timelineLabel,
  resizeStartLabel,
  resizeEndLabel,
  toolMode,
  onSeek,
  onPlayClip,
  onResize,
  onAddAt,
  onDeleteClip,
}: {
  clips: readonly CustomRallyClip[];
  duration: number;
  fps: number;
  currentTime: number;
  timelineLabel: string;
  resizeStartLabel: string;
  resizeEndLabel: string;
  toolMode: TimelineToolMode;
  onSeek: (time: number) => void;
  onPlayClip: (clip: CustomRallyClip) => void;
  onResize: (clipId: string, edge: Edge, time: number) => number;
  onAddAt: (time: number) => boolean;
  onDeleteClip: (clipId: string) => void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackWindowRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewportWidth, setViewportWidth] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [resizeFeedback, setResizeFeedback] = useState<ResizeFeedback | null>(null);
  const [addTargetValid, setAddTargetValid] = useState<boolean | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const playheadDraggingRef = useRef<number | null>(null);
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>(() => undefined);
  const draggingRef = useRef<{
    pointerId: number;
    clipId: string;
    edge: Edge;
    startX: number;
    initialTime: number;
  } | null>(null);

  const maximumZoom = Math.max(1, duration * 150 / viewportWidth);
  const actualZoom = Math.min(zoom, maximumZoom);
  const contentWidth = Math.max(viewportWidth, viewportWidth * actualZoom);
  const pixelsPerSecond = contentWidth / Math.max(duration, 0.001);
  const visibleScrollLeft = clampTimelineScrollLeft(scrollLeft, viewportWidth, contentWidth);
  const selectedClips = useMemo(() => clips.filter((clip) => clip.selected), [clips]);

  useEffect(() => {
    setAddTargetValid(null);
    setDeleteTargetId(null);
    setResizeFeedback(null);
  }, [toolMode]);

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

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextScrollLeft = clampTimelineScrollLeft(viewport.scrollLeft, viewport.clientWidth, contentWidth);
    if (Math.abs(viewport.scrollLeft - nextScrollLeft) >= 0.01) viewport.scrollLeft = nextScrollLeft;
    setScrollLeft(nextScrollLeft);
  }, [contentWidth]);

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
    const visibleStart = visibleScrollLeft / pixelsPerSecond;
    const visibleEnd = Math.min(duration, (visibleScrollLeft + width) / pixelsPerSecond);
    const firstMinor = Math.max(0, Math.floor(visibleStart / minor) * minor);
    for (let time = firstMinor; time <= visibleEnd + minor / 2; time += minor) {
      const x = Math.round(time * pixelsPerSecond - visibleScrollLeft) + 0.5;
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
  }, [duration, pixelsPerSecond, viewportWidth, visibleScrollLeft]);

  useEffect(drawRuler, [drawRuler]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || duration <= 0) return;
    const x = currentTime * pixelsPerSecond;
    const margin = Math.min(90, viewport.clientWidth * 0.15);
    if (x < viewport.scrollLeft + margin || x > viewport.scrollLeft + viewport.clientWidth - margin) {
      const nextScrollLeft = clampTimelineScrollLeft(x - viewport.clientWidth * 0.35, viewport.clientWidth, contentWidth);
      viewport.scrollLeft = nextScrollLeft;
      setScrollLeft(nextScrollLeft);
    }
  }, [contentWidth, currentTime, duration, pixelsPerSecond]);

  const setZoomAnchored = (nextZoom: number, anchorClientX?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounded = Math.max(1, Math.min(maximumZoom, nextZoom));
    const rect = viewport.getBoundingClientRect();
    const anchor = anchorClientX === undefined ? viewport.clientWidth / 2 : anchorClientX - rect.left;
    const time = (viewport.scrollLeft + anchor) / pixelsPerSecond;
    setZoom(bounded);
    window.requestAnimationFrame(() => {
      const nextContentWidth = Math.max(viewport.clientWidth, viewport.clientWidth * bounded);
      const nextPixelsPerSecond = nextContentWidth / Math.max(duration, 0.001);
      const nextScrollLeft = clampTimelineScrollLeft(time * nextPixelsPerSecond - anchor, viewport.clientWidth, nextContentWidth);
      viewport.scrollLeft = nextScrollLeft;
      setScrollLeft(nextScrollLeft);
    });
  };

  wheelHandlerRef.current = (event) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (event.ctrlKey) {
      // The track is the sole owner of Ctrl+wheel while the pointer is over it.
      // This prevents Chromium/Electron page zoom from resizing the monitor.
      event.preventDefault();
      event.stopPropagation();
      const zoomDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (zoomDelta !== 0) setZoomAnchored(actualZoom * (zoomDelta < 0 ? 1.18 : 1 / 1.18), event.clientX);
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
    const surface = surfaceRef.current;
    if (!surface) return;
    const handleWheel = (event: WheelEvent) => wheelHandlerRef.current(event);
    // Capture makes this reliable for ruler, clip, handle, and empty-track targets.
    surface.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    return () => surface.removeEventListener('wheel', handleWheel, true);
  }, []);

  const timeFromTrackPointer = (clientX: number) => {
    const track = trackWindowRef.current;
    if (!track) return 0;
    const content = track.querySelector<HTMLElement>('.timeline-track');
    // Use the rendered track position rather than either scroll state. This
    // keeps insertion aligned with what the user sees during a scroll render.
    const contentLeft = content?.getBoundingClientRect().left ?? track.getBoundingClientRect().left;
    return Math.max(0, Math.min(duration, (clientX - contentLeft) / pixelsPerSecond));
  };

  const canAddAt = (time: number) => (
    Number.isFinite(time)
    && time >= 0
    && time + 1 <= duration
    && !clips.some((clip) => time < clip.end && time + 1 > clip.start)
  );

  const seekFromPointer = (clientX: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const x = clientX - viewport.getBoundingClientRect().left + viewport.scrollLeft;
    onSeek(Math.max(0, Math.min(duration, x / pixelsPerSecond)));
  };

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>, clip: CustomRallyClip, edge: Edge) => {
    if (toolMode) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = { pointerId: event.pointerId, clipId: clip.clipId, edge, startX: event.clientX, initialTime: edge === 'start' ? clip.start : clip.end };
    setResizeFeedback({ clipId: clip.clipId, edge, boundaryTime: edge === 'start' ? clip.start : clip.end, durationDelta: 0 });
  };

  const moveResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragging = draggingRef.current;
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const boundaryTime = onResize(dragging.clipId, dragging.edge, dragging.initialTime + (event.clientX - dragging.startX) / pixelsPerSecond);
    setResizeFeedback({ clipId: dragging.clipId, edge: dragging.edge, boundaryTime, durationDelta: dragging.edge === 'start' ? dragging.initialTime - boundaryTime : boundaryTime - dragging.initialTime });
  };

  const endResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (draggingRef.current?.pointerId !== event.pointerId) return;
    draggingRef.current = null;
    setResizeFeedback(null);
  };

  const keyboardResize = (event: React.KeyboardEvent<HTMLButtonElement>, clip: CustomRallyClip, edge: Edge) => {
    if (toolMode || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 1 / Math.max(fps, 1);
    const current = edge === 'start' ? clip.start : clip.end;
    onResize(clip.clipId, edge, current + (event.key === 'ArrowLeft' ? -step : step));
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
    if (playheadDraggingRef.current === event.pointerId) seekFromPointer(event.clientX);
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

  const updateAddTarget = (clientX: number) => {
    if (toolMode === 'add') setAddTargetValid(canAddAt(timeFromTrackPointer(clientX)));
  };

  const addAtPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || toolMode !== 'add') return;
    event.preventDefault();
    event.stopPropagation();
    const time = timeFromTrackPointer(event.clientX);
    if (canAddAt(time)) onAddAt(time);
  };

  return (
    <section ref={surfaceRef} className={`custom-timeline${toolMode ? ` is-${toolMode}-mode` : ''}${toolMode === 'add' && addTargetValid === false ? ' is-add-unavailable' : ''}`} aria-label={timelineLabel}>
      <div ref={viewportRef} className="timeline-viewport" data-zoom={actualZoom} onScroll={(event) => setScrollLeft(clampTimelineScrollLeft(event.currentTarget.scrollLeft, event.currentTarget.clientWidth, event.currentTarget.scrollWidth))}>
        <div className="timeline-content" style={{ width: contentWidth }}>
          <div className="timeline-ruler" onPointerDown={(event) => seekFromPointer(event.clientX)}><canvas ref={canvasRef} style={{ transform: `translateX(${visibleScrollLeft}px)` }} /></div>
          {resizeFeedback ? <div className="resize-feedback" style={{ left: resizeFeedback.boundaryTime * pixelsPerSecond }} data-clip-id={resizeFeedback.clipId} data-edge={resizeFeedback.edge}>{formatResizeDelta(resizeFeedback.durationDelta)}</div> : null}
          <div className={`timeline-playhead${isScrubbing ? ' dragging' : ''}`} style={{ left: currentTime * pixelsPerSecond }} role="slider" aria-orientation="horizontal" tabIndex={0} aria-label={timelineLabel} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={currentTime} onPointerDown={beginPlayheadDrag} onPointerMove={movePlayhead} onPointerUp={endPlayheadDrag} onPointerCancel={cancelPlayheadDrag} onLostPointerCapture={cancelPlayheadDrag} onKeyDown={keyboardSeek}><i /></div>
        </div>
      </div>
      <div ref={trackWindowRef} className="timeline-track-window" onPointerMove={(event) => updateAddTarget(event.clientX)} onPointerLeave={() => setAddTargetValid(null)} onPointerDown={addAtPointer}>
        <div className="timeline-track" style={{ width: contentWidth, transform: `translateX(${-visibleScrollLeft}px)` }}>
          {selectedClips.map((clip, index) => {
            const left = clip.start * pixelsPerSecond;
            const width = Math.max(1, (clip.end - clip.start) * pixelsPerSecond);
            const edgeHitWidth = clipEdgeHitWidth(width);
            const showBoundaryMarkers = shouldShowClipBoundaryMarkers(width);
            const minimumDuration = 1 / Math.max(fps, 1);
            const previous = selectedClips[index - 1];
            const following = selectedClips[index + 1];
            const deleteTarget = toolMode === 'delete' && deleteTargetId === clip.clipId;
            return (
              <div key={clip.clipId} className={`timeline-clip${deleteTarget ? ' delete-target' : ''}`} data-clip-id={clip.clipId} data-rally-id={clip.sourceRallyId ?? undefined} style={{ left, width }} onPointerEnter={() => { if (toolMode === 'delete') setDeleteTargetId(clip.clipId); }} onPointerLeave={() => { if (deleteTargetId === clip.clipId) setDeleteTargetId(null); }} onPointerDown={(event) => {
                // Right-click is reserved for CustomCutPage's context-menu cancellation.
                if (event.button !== 0) return;
                if (toolMode === 'delete') { event.preventDefault(); event.stopPropagation(); onDeleteClip(clip.clipId); return; }
                if (toolMode === 'add') { event.preventDefault(); event.stopPropagation(); return; }
                onPlayClip(clip);
              }}>
                {!toolMode ? <button type="button" className="clip-handle start" role="slider" aria-orientation="horizontal" aria-label={`${resizeStartLabel} ${clip.rallyIndex}`} aria-valuemin={previous?.end ?? 0} aria-valuemax={clip.end - minimumDuration} aria-valuenow={clip.start} style={{ left: -CLIP_EDGE_HIT_OUTSET, width: edgeHitWidth }} onPointerDown={(event) => beginResize(event, clip, 'start')} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={(event) => keyboardResize(event, clip, 'start')} /> : null}
                {!deleteTarget ? <span>{clip.rallyIndex}</span> : null}
                {deleteTarget ? <i className="timeline-delete-overlay"><TrashIcon /></i> : null}
                {showBoundaryMarkers ? <><i className="clip-boundary-marker start" aria-hidden="true" /><i className="clip-boundary-marker end" aria-hidden="true" /></> : null}
                {!toolMode ? <button type="button" className="clip-handle end" role="slider" aria-orientation="horizontal" aria-label={`${resizeEndLabel} ${clip.rallyIndex}`} aria-valuemin={clip.start + minimumDuration} aria-valuemax={following?.start ?? duration} aria-valuenow={clip.end} style={{ right: -CLIP_EDGE_HIT_OUTSET, width: edgeHitWidth }} onPointerDown={(event) => beginResize(event, clip, 'end')} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={(event) => keyboardResize(event, clip, 'end')} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

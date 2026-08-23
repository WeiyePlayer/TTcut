import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SelectedVideo } from '../shared/api';
import type { AnalysisResultV1, ExportRequest } from '../shared/contracts';
import {
  createManualCustomClip,
  deleteCustomClip,
  resizeCustomClip,
  setCustomClipSelected,
  type CustomRallyClip,
} from '../domain/custom-clips';
import { CustomTimeline, type TimelineToolMode } from './CustomTimeline';
import type { Messages } from './i18n';

export function formatCustomClipTime(seconds: number): string {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalTenths = Math.round(safeSeconds * 10);
  const minutes = Math.floor(totalTenths / 600);
  const secondTenths = totalTenths % 600;
  const secondText = `${Math.floor(secondTenths / 10)}.${secondTenths % 10}`.padStart(4, '0');
  return `${String(minutes).padStart(2, '0')}:${secondText}`;
}

export function formatCustomClipDuration(start: number, end: number): string {
  return `${Math.max(0, end - start).toFixed(1)}s`;
}

export function calculateRallyScrollbar(scrollTop: number, clientHeight: number, scrollHeight: number) {
  const viewportHeight = Math.max(0, clientHeight);
  const maximumScroll = Math.max(0, scrollHeight - viewportHeight);
  if (viewportHeight === 0 || maximumScroll === 0) return { visible: false, height: 0, top: 0, maximumScroll };
  const nativeThumbHeight = viewportHeight * viewportHeight / Math.max(scrollHeight, 1);
  const height = Math.min(viewportHeight, Math.max(20, nativeThumbHeight / 2));
  const top = Math.max(0, Math.min(viewportHeight - height, scrollTop / maximumScroll * (viewportHeight - height)));
  return { visible: true, height, top, maximumScroll };
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M10 11v6m4-6v6M9 7l.8-2h4.4l.8 2M6.5 7l.8 12h9.4l.8-12" /></svg>;
}

function manualClipId(): string | null {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `manual_${globalThis.crypto.randomUUID()}`;
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return null;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `manual_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function RallyScrollbar({ scrollRef, contentRef }: { scrollRef: React.RefObject<HTMLDivElement | null>; contentRef: React.RefObject<HTMLTableElement | null> }) {
  const [metrics, setMetrics] = useState(() => calculateRallyScrollbar(0, 0, 0));
  const dragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number } | null>(null);

  const updateMetrics = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    setMetrics(calculateRallyScrollbar(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight));
  }, [scrollRef]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll) return;
    updateMetrics();
    scroll.addEventListener('scroll', updateMetrics, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateMetrics);
    observer?.observe(scroll);
    if (content) observer?.observe(content);
    return () => {
      scroll.removeEventListener('scroll', updateMetrics);
      observer?.disconnect();
    };
  }, [contentRef, scrollRef, updateMetrics]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: scroll.scrollTop };
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroll = scrollRef.current;
    const drag = dragRef.current;
    if (!scroll || !drag || drag.pointerId !== event.pointerId || metrics.height >= scroll.clientHeight) return;
    scroll.scrollTop = Math.max(0, Math.min(
      metrics.maximumScroll,
      drag.startScrollTop + (event.clientY - drag.startY) * metrics.maximumScroll / (scroll.clientHeight - metrics.height),
    ));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  if (!metrics.visible) return null;
  return <div className="custom-rally-scrollbar-thumb" role="scrollbar" aria-controls="custom-rally-scroll" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={metrics.maximumScroll} aria-valuenow={scrollRef.current?.scrollTop ?? 0} style={{ height: metrics.height, transform: `translateY(${metrics.top}px)` }} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} />;
}

export function CustomCutPage({
  video,
  analysis,
  clips,
  translations,
  mediaAvailable,
  onClipsChange,
  onToggleAll,
  outputs,
  onOutputsChange,
  onExport,
}: {
  video: SelectedVideo;
  analysis: AnalysisResultV1;
  clips: readonly CustomRallyClip[];
  translations: Messages;
  mediaAvailable: boolean;
  onClipsChange: (clips: CustomRallyClip[]) => void;
  onToggleAll: (selected: boolean) => void;
  outputs: NonNullable<ExportRequest['outputs']>;
  onOutputsChange: (outputs: NonNullable<ExportRequest['outputs']>) => void;
  onExport: (outputs: NonNullable<ExportRequest['outputs']>) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rallyScrollRef = useRef<HTMLDivElement>(null);
  const rallyTableRef = useRef<HTMLTableElement>(null);
  const exportCloseTimerRef = useRef<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [toolMode, setToolMode] = useState<TimelineToolMode>(null);
  const [exportOptionsOpen, setExportOptionsOpen] = useState(false);
  const selectedCount = clips.filter((clip) => clip.selected).length;

  const cancelExportClose = useCallback(() => {
    if (exportCloseTimerRef.current === null) return;
    window.clearTimeout(exportCloseTimerRef.current);
    exportCloseTimerRef.current = null;
  }, []);

  const scheduleExportClose = useCallback(() => {
    cancelExportClose();
    exportCloseTimerRef.current = window.setTimeout(() => {
      exportCloseTimerRef.current = null;
      setExportOptionsOpen(false);
    }, 160);
  }, [cancelExportClose]);

  useEffect(() => () => cancelExportClose(), [cancelExportClose]);

  const seek = useCallback((time: number) => {
    const player = videoRef.current;
    if (!player) return;
    player.currentTime = Math.max(0, Math.min(analysis.video.duration_seconds, time));
    setCurrentTime(player.currentTime);
  }, [analysis.video.duration_seconds]);

  const togglePlayback = useCallback(() => {
    const player = videoRef.current;
    if (!player) return;
    if (player.paused) void player.play().catch(() => undefined);
    else player.pause();
  }, []);

  const handleVideoKeyDown = useCallback((event: React.KeyboardEvent<HTMLVideoElement>) => {
    if (event.repeat || (event.code !== 'Space' && event.key !== ' ')) return;
    event.preventDefault();
    togglePlayback();
  }, [togglePlayback]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || (event.code !== 'Space' && event.key !== ' ')) return;
      const target = event.target;
      if (target instanceof Element) {
        const control = target.closest('input, textarea, select, button, video, [contenteditable="true"]');
        if (control && !control.matches('[role="slider"]')) return;
      }
      event.preventDefault();
      togglePlayback();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlayback]);

  const playClip = (clip: CustomRallyClip) => {
    const player = videoRef.current;
    if (!player) return;
    player.currentTime = clip.start;
    setCurrentTime(clip.start);
    void player.play().catch(() => undefined);
  };

  const toggleTool = (nextTool: Exclude<TimelineToolMode, null>) => {
    setToolMode((active) => active === nextTool ? null : nextTool);
  };

  const addManualAt = (start: number) => {
    const clipId = manualClipId();
    if (!clipId) return false;
    const nextClips = createManualCustomClip(
      clips,
      clipId,
      start,
      analysis.video.duration_seconds,
      analysis.bounce_times_seconds,
    );
    if (!nextClips) return false;
    onClipsChange(nextClips);
    return true;
  };

  const updateExportOutputs = (nextOutputs: NonNullable<ExportRequest['outputs']>) => {
    cancelExportClose();
    setExportOptionsOpen(true);
    onOutputsChange(nextOutputs);
  };

  return (
    <div className="custom-cut-page">
      <div className="custom-workspace" onContextMenu={(event) => { event.preventDefault(); setToolMode(null); }}>
        <section className="custom-rally-list" aria-label={translations.rally}>
          <div className="table-tools">
            <div className="custom-list-selection"><strong>{selectedCount} / {clips.length}</strong><span>{translations.rally}</span></div>
            <div className="custom-list-actions"><button className="text-button" type="button" onClick={() => onToggleAll(true)}>{translations.selectAll}</button><button className="text-button" type="button" onClick={() => onToggleAll(false)}>{translations.clearAll}</button></div>
          </div>
          <div className="custom-rally-scroll-shell">
            <div ref={rallyScrollRef} id="custom-rally-scroll" className="table-scroll">
              <table ref={rallyTableRef} className="custom-rally-table"><tbody>{clips.map((clip) => (
                <tr key={clip.clipId} tabIndex={0} onClick={() => playClip(clip)} onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  playClip(clip);
                }}>
                  <td className="custom-rally-check" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    <label className="rally-checkbox">
                      <input type="checkbox" aria-label={`${translations.rally} ${clip.rallyIndex}`} checked={clip.selected} onChange={(event) => onClipsChange(setCustomClipSelected(clips, clip.clipId, event.currentTarget.checked, analysis.video.duration_seconds, analysis.video.fps))} />
                      <span className="rally-checkbox-control" aria-hidden="true" />
                    </label>
                  </td>
                  <td colSpan={3}>
                    <div className="custom-rally-meta"><strong>{translations.rally} {clip.rallyIndex}</strong><span title={clip.bounceCount === null ? translations.manualBounceUnavailable : undefined}>{translations.strokes} {clip.bounceCount ?? '—'}</span></div>
                    <div className="custom-rally-times"><span>{formatCustomClipTime(clip.start)}</span><div className="custom-rally-duration"><strong>{formatCustomClipDuration(clip.start, clip.end)}</strong><i /></div><span>{formatCustomClipTime(clip.end)}</span></div>
                  </td>
                </tr>
              ))}</tbody></table>
            </div>
            <RallyScrollbar scrollRef={rallyScrollRef} contentRef={rallyTableRef} />
          </div>
        </section>

        <div className="custom-workspace-right">
          <div className="custom-monitor-slot"><div className="custom-monitor">
            <video ref={videoRef} src={video.mediaUrl} controls={false} preload="metadata" playsInline tabIndex={0} aria-label={translations.togglePlayback} onClick={togglePlayback} onKeyDown={handleVideoKeyDown} onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0; setCurrentTime(0); }} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)} />
          </div></div>

          <CustomTimeline clips={clips} duration={analysis.video.duration_seconds} fps={analysis.video.fps} currentTime={currentTime} timelineLabel={translations.timeline} resizeStartLabel={translations.resizeStart} resizeEndLabel={translations.resizeEnd} toolMode={toolMode} onSeek={seek} onPlayClip={playClip} onAddAt={addManualAt} onDeleteClip={(clipId) => onClipsChange(deleteCustomClip(clips, clipId))} onResize={(clipId, edge, time) => {
            const nextClips = resizeCustomClip(clips, clipId, edge, time, analysis.video.duration_seconds, analysis.video.fps, analysis.bounce_times_seconds);
            onClipsChange(nextClips);
            const resized = nextClips.find((clip) => clip.clipId === clipId);
            return resized ? resized[edge] : time;
          }} />

          <div className="custom-timeline-actions">
            <div className="timeline-tool-buttons" role="group" aria-label={translations.timelineTools}>
              <button className={`timeline-tool${toolMode === 'add' ? ' is-active' : ''}`} type="button" aria-label={translations.addManualRally} title={translations.addManualRally} aria-pressed={toolMode === 'add'} onClick={() => toggleTool('add')}><PlusIcon /></button>
              <button className={`timeline-tool${toolMode === 'delete' ? ' is-active' : ''}`} type="button" aria-label={translations.deleteRally} title={translations.deleteRally} aria-pressed={toolMode === 'delete'} onClick={() => toggleTool('delete')}><TrashIcon /></button>
            </div>
            <div className={`custom-export-launcher floating-launcher${exportOptionsOpen ? ' is-open' : ''}`} onPointerLeave={scheduleExportClose}>
              <div className="custom-export-options floating-launch-options" role="group" aria-label={translations.customExportOptions} onPointerEnter={cancelExportClose} onPointerLeave={scheduleExportClose}>
                <label className="export-checkbox">
                  <input type="checkbox" checked={outputs.rally_videos} disabled={!mediaAvailable} onChange={(event) => updateExportOutputs({ combined_video: false, rally_videos: event.currentTarget.checked, premiere_xml: outputs.premiere_xml })} />
                  <span className="export-checkbox-control" aria-hidden="true"><span className="export-checkbox-gloss" /></span>
                  <span className="export-checkbox-text">{translations.exportRallyVideos}</span>
                </label>
                <label className="export-checkbox">
                  <input type="checkbox" checked={outputs.premiere_xml} onChange={(event) => updateExportOutputs({ combined_video: false, rally_videos: outputs.rally_videos, premiere_xml: event.currentTarget.checked })} />
                  <span className="export-checkbox-control" aria-hidden="true"><span className="export-checkbox-gloss" /></span>
                  <span className="export-checkbox-text">{translations.exportPremiereXml}</span>
                </label>
              </div>
              <button className="primary floating-launch-start" type="button" disabled={!selectedCount || (!outputs.premiere_xml && !outputs.rally_videos && !mediaAvailable)} onPointerEnter={() => { cancelExportClose(); setExportOptionsOpen(true); }} onFocus={() => { cancelExportClose(); setExportOptionsOpen(true); }} onClick={() => onExport({ combined_video: !outputs.rally_videos && !outputs.premiere_xml, rally_videos: outputs.rally_videos, premiere_xml: outputs.premiere_xml })}>{translations.startCutting}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

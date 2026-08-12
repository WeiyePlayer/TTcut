import { useCallback, useEffect, useRef, useState } from 'react';
import type { SelectedVideo } from '../shared/api';
import type { AnalysisResultV1, ExportRequest } from '../shared/contracts';
import { resizeCustomClip, setCustomClipSelected, type CustomRallyClip } from '../domain/custom-clips';
import { formatTimestamp } from '../domain/time';
import { CustomTimeline } from './CustomTimeline';
import type { Messages } from './i18n';

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
  const [currentTime, setCurrentTime] = useState(0);
  const selectedCount = clips.filter((clip) => clip.selected).length;

  const seek = useCallback((time: number) => {
    const player = videoRef.current;
    if (!player) return;
    player.currentTime = Math.max(0, Math.min(analysis.video.duration_seconds, time));
    setCurrentTime(player.currentTime);
  }, [analysis.video.duration_seconds]);

  const togglePlayback = useCallback(() => {
    const player = videoRef.current;
    if (!player) return;
    if (player.paused) {
      void player.play().catch(() => undefined);
    } else {
      player.pause();
    }
  }, []);

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

  return (
    <div className="custom-cut-page">
      <div className="custom-monitor">
        <video
          ref={videoRef}
          src={video.mediaUrl}
          controls
          preload="metadata"
          playsInline
          onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0; setCurrentTime(0); }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
        />
      </div>

      <CustomTimeline
        clips={clips}
        duration={analysis.video.duration_seconds}
        fps={analysis.video.fps}
        currentTime={currentTime}
        timelineLabel={translations.timeline}
        resizeStartLabel={translations.resizeStart}
        resizeEndLabel={translations.resizeEnd}
        onSeek={seek}
        onPlayClip={playClip}
        onResize={(rallyId, edge, time) => {
          const nextClips = resizeCustomClip(
            clips,
            rallyId,
            edge,
            time,
            analysis.video.duration_seconds,
            analysis.video.fps,
          );
          onClipsChange(nextClips);
          const resized = nextClips.find((clip) => clip.rallyId === rallyId);
          return resized ? resized[edge] : time;
        }}
      />

      <section className="custom-rally-list">
        <div className="table-tools">
          <button className="text-button" type="button" onClick={() => onToggleAll(true)}>{translations.selectAll}</button>
          <button className="text-button" type="button" onClick={() => onToggleAll(false)}>{translations.clearAll}</button>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th /><th>{translations.rally}</th><th>{translations.strokes}</th><th>{translations.start}</th><th>{translations.end}</th></tr></thead>
            <tbody>{clips.map((clip) => (
              <tr key={clip.rallyId} tabIndex={0} onClick={() => playClip(clip)} onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                playClip(clip);
              }}>
                <td onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`${translations.rally} ${clip.rallyIndex}`}
                    checked={clip.selected}
                    onChange={(event) => {
                      onClipsChange(setCustomClipSelected(
                        clips,
                        clip.rallyId,
                        event.currentTarget.checked,
                        analysis.video.duration_seconds,
                        analysis.video.fps,
                      ));
                    }}
                  />
                </td>
                <td>{clip.rallyIndex}</td>
                <td>{clip.bounceCount}</td>
                <td>{formatTimestamp(clip.start)}</td>
                <td>{formatTimestamp(clip.end)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <div className="footer-actions custom-footer">
        <span>{selectedCount} / {clips.length}</span>
        <div className="custom-export-launcher floating-launcher">
          <div className="custom-export-options floating-launch-options" role="group" aria-label={translations.customExportOptions}>
            <label>
              <input type="checkbox" checked={outputs.rally_videos} disabled={!mediaAvailable} onChange={(event) => onOutputsChange({ combined_video: false, rally_videos: event.currentTarget.checked, premiere_xml: outputs.premiere_xml })} />
              <span>{translations.exportRallyVideos}</span>
            </label>
            <label>
              <input type="checkbox" checked={outputs.premiere_xml} onChange={(event) => onOutputsChange({ combined_video: false, rally_videos: outputs.rally_videos, premiere_xml: event.currentTarget.checked })} />
              <span>{translations.exportPremiereXml}</span>
            </label>
          </div>
          <button
            className="primary floating-launch-start"
            type="button"
            disabled={!selectedCount || (!outputs.premiere_xml && !outputs.rally_videos && !mediaAvailable)}
            onClick={() => onExport({
              combined_video: !outputs.rally_videos && !outputs.premiere_xml,
              rally_videos: outputs.rally_videos,
              premiere_xml: outputs.premiere_xml,
            })}
          >
            {translations.startCutting}
          </button>
        </div>
      </div>
    </div>
  );
}

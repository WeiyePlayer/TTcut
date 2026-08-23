import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CustomCutPage } from '../src/renderer/CustomCutPage';
import type { AnalysisResultV1, ExportRequest } from '../src/shared/contracts';
import type { SelectedVideo } from '../src/shared/api';
import type { CustomRallyClip } from '../src/domain/custom-clips';
import { messages } from '../src/renderer/i18n';

const analysis: AnalysisResultV1 = {
  schema_version: 1,
  video: { path: 'D:/match.mp4', duration_seconds: 10, width: 1280, height: 720, fps: 30, variable_frame_rate: false, video_codec: 'h264', audio_codec: 'aac', container: 'mp4' },
  rallies: [{ id: 'rally_001', index: 1, bounce_count: 3, start_time_seconds: 3, end_time_seconds: 4 }],
  bounce_times_seconds: [3.2, 3.8, 7.2, 7.9],
};

const video: SelectedVideo = { path: analysis.video.path, name: 'match.mp4', size: 1, mediaUrl: 'ttcut-media://match' };
const initialClips: CustomRallyClip[] = [{
  clipId: 'rally_001', source: 'detected', sourceRallyId: 'rally_001', rallyIndex: 1, bounceCount: 3,
  defaultStart: 3, defaultEnd: 4, start: 3, end: 4, selected: true,
}];

function Harness() {
  const [clips, setClips] = useState(initialClips);
  const [outputs, setOutputs] = useState<NonNullable<ExportRequest['outputs']>>({ combined_video: true, rally_videos: false, premiere_xml: false });
  return <CustomCutPage video={video} analysis={analysis} clips={clips} translations={messages('en')} mediaAvailable onClipsChange={setClips} onToggleAll={vi.fn()} outputs={outputs} onOutputsChange={setOutputs} onExport={vi.fn()} />;
}

describe('manual timeline tools', () => {
  it('keeps export options open while the pointer moves from the trigger into the popover', () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      const launcher = document.querySelector('.custom-export-launcher') as HTMLDivElement;
      const options = screen.getByRole('group', { name: 'Custom export options' });
      const startCutting = screen.getByRole('button', { name: 'Start cutting' });

      fireEvent.pointerEnter(startCutting);
      expect(launcher).toHaveClass('is-open');
      fireEvent.pointerLeave(launcher);
      fireEvent.pointerEnter(options);
      act(() => vi.advanceTimersByTime(200));
      expect(launcher).toHaveClass('is-open');

      fireEvent.pointerLeave(options);
      act(() => vi.advanceTimersByTime(200));
      expect(launcher).not.toHaveClass('is-open');
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('creates and deletes a one-second manual clip from the icon-only tools', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    render(<Harness />);
    const track = document.querySelector('.timeline-track-window') as HTMLDivElement;
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 42, width: 100, height: 42, toJSON: () => ({}) });

    fireEvent.click(screen.getByRole('button', { name: 'Add rally' }));
    fireEvent.pointerDown(track, { button: 2, clientX: 70, clientY: 20 });
    fireEvent.contextMenu(track);
    expect(document.querySelector('.timeline-clip[data-clip-id^="manual_"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add rally' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Add rally' }));
    fireEvent.pointerDown(track, { clientX: 70, clientY: 20 });
    const manualClip = document.querySelector<HTMLElement>('.timeline-clip[data-clip-id^="manual_"]');
    expect(manualClip).not.toBeNull();
    expect(screen.getByText('Bounces 2')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Delete rally' }));
    fireEvent.pointerEnter(manualClip!);
    expect(manualClip).toHaveClass('delete-target');
    expect(manualClip!.querySelector('span')).toBeNull();
    fireEvent.pointerDown(manualClip!, { button: 2, clientX: 75, clientY: 20 });
    fireEvent.contextMenu(manualClip!);
    expect(document.querySelector('.timeline-clip[data-clip-id^="manual_"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Delete rally' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Delete rally' }));
    fireEvent.pointerEnter(manualClip!);
    fireEvent.pointerDown(manualClip!, { clientX: 75, clientY: 20 });
    expect(document.querySelector('.timeline-clip[data-clip-id^="manual_"]')).toBeNull();
    width.mockRestore();
  });
});

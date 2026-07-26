import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiTaskPage } from '../src/renderer/MultiTaskPage';
import type { AppEvent, SelectedVideo, TTcutApi } from '../src/shared/api';
import type { AnalysisResultV1, Calibration, VideoMetadata } from '../src/shared/contracts';

const videos: SelectedVideo[] = [
  { path: 'C:\video\first.mp4', name: 'first.mp4', size: 100, mediaUrl: 'ttcut-media://first' },
  { path: 'C:\video\second.mp4', name: 'second.mp4', size: 200, mediaUrl: 'ttcut-media://second' },
];

const calibration: Calibration = {
  video_width: 1920,
  video_height: 1080,
  points: {
    top_left: [600, 300], top_right: [1300, 300], bottom_right: [1500, 850], bottom_left: [400, 850],
  },
};

function metadata(path: string): VideoMetadata {
  return {
    path, duration_seconds: 90, width: 1920, height: 1080, fps: 59.94,
    variable_frame_rate: false, video_codec: 'h264', audio_codec: 'aac', container: 'mp4',
  };
}

function analysis(path: string): AnalysisResultV1 {
  return {
    schema_version: 1,
    video: metadata(path),
    rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 1, end_time_seconds: 8 }],
    calibration,
  };
}

describe('multi-task clipping', () => {
  let listener: ((event: AppEvent) => void) | null;
  let startAnalysis: ReturnType<typeof vi.fn>;
  let startExport: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listener = null;
    startAnalysis = vi.fn()
      .mockResolvedValueOnce('analysis-task-1')
      .mockResolvedValueOnce('analysis-task-2');
    startExport = vi.fn().mockResolvedValueOnce('export-task-1');
    const api = {
      probeVideo: vi.fn((path: string) => Promise.resolve(metadata(path))),
      startAnalysis,
      startExport,
      onTaskEvent: vi.fn((next: (event: AppEvent) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
      selectVideos: vi.fn().mockResolvedValue([]),
      acceptDroppedVideo: vi.fn(),
      pathForDroppedFile: vi.fn(),
      cancelTask: vi.fn().mockResolvedValue(undefined),
      deleteAnalysis: vi.fn().mockResolvedValue(undefined),
      revealOutput: vi.fn().mockResolvedValue(undefined),
    } as unknown as TTcutApi;
    Object.defineProperty(window, 'ttcut', { configurable: true, value: api });
  });

  it('allows each pending video mode to be selected with the mouse', async () => {
    const { unmount } = render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} exportStrategy="compatible" onOpenAnalysis={vi.fn()} />);
    await screen.findByText('first.mp4');

    const group = screen.getByRole('group', { name: 'first.mp4 的剪辑模式' });
    const highlight = within(group).getByRole('button', { name: '精彩回合' });
    fireEvent.click(highlight);

    expect(highlight).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { name: '5板' })[0]).toBeVisible();

    const analyzeOnly = within(group).getByRole('button', { name: '只分析' });
    fireEvent.click(analyzeOnly);
    expect(analyzeOnly).toHaveAttribute('aria-pressed', 'true');
    unmount();
  });

  it('runs videos serially with automatic calibration and 70/30 progress mapping', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} exportStrategy="compatible" onOpenAnalysis={vi.fn()} />);
    await screen.findByText('first.mp4');
    await screen.findByText('second.mp4');

    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    expect(startAnalysis).toHaveBeenCalledWith({
      videoPath: videos[0]!.path,
      calibrationChoice: { method: 'automatic' },
      device: 'auto',
      historyVisibility: 'deferred',
    });

    act(() => listener?.({
      type: 'progress',
      data: { taskId: 'analysis-task-1', kind: 'analysis', stage: 'analysis', percent: 50 },
    }));
    expect(await screen.findByText('35%')).toBeVisible();

    act(() => listener?.({
      type: 'analysis-result', taskId: 'analysis-task-1', analysisId: '11111111-1111-4111-8111-111111111111',
      calibration, data: analysis(videos[0]!.path),
    }));
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(1));
    expect(startExport).toHaveBeenCalledWith(expect.objectContaining({
      analysis_id: '11111111-1111-4111-8111-111111111111',
      destination: 'source',
      export_strategy: 'compatible',
      selection: { mode: 'all', pre_roll_seconds: 2.5, post_roll_seconds: 1 },
    }));
    expect(startAnalysis).toHaveBeenCalledTimes(1);

    act(() => listener?.({
      type: 'progress',
      data: { taskId: 'export-task-1', kind: 'export', stage: 'encoding', percent: 50 },
    }));
    expect(await screen.findByText('85%')).toBeVisible();

    act(() => listener?.({
      type: 'export-result',
      taskId: 'export-task-1',
      data: {
        taskId: 'export-task-1', analysisId: '11111111-1111-4111-8111-111111111111',
        outputPath: 'C:\video\first_TTcut_所有回合.mp4', outputName: 'first_TTcut_所有回合.mp4', mediaUrl: 'ttcut-media://output',
      },
    }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(2));
    expect(startAnalysis.mock.calls[1]?.[0]).toMatchObject({ videoPath: videos[1]!.path });
  });

  it('marks an export cancelled from the backend terminal code', async () => {
    const { container } = render(
      <MultiTaskPage
        initialVideos={[videos[0]!]}
        preRoll={2.5}
        postRoll={1}
        exportStrategy="fast_segmented"
        onOpenAnalysis={vi.fn()}
      />,
    );
    await screen.findByText('first.mp4');
    fireEvent.click(container.querySelector('.batch-start')!);
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: analysis(videos[0]!.path),
    }));
    await waitFor(() => expect(startExport).toHaveBeenCalledWith(expect.objectContaining({
      export_strategy: 'fast_segmented',
    })));
    act(() => listener?.({
      type: 'error',
      taskId: 'export-task-1',
      code: 'EXPORT_CANCELLED',
      message: 'EXPORT_CANCELLED',
    }));
    await waitFor(() => expect(container.querySelector('.batch-row.cancelled')).not.toBeNull());
  });
});

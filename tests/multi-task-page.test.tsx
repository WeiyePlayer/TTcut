import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiTaskPage } from '../src/renderer/MultiTaskPage';
import type { AppEvent, SelectedVideo, TTcutApi } from '../src/shared/api';
import type { AnalysisResultV1, Calibration, TableAnalysis, VideoMetadata } from '../src/shared/contracts';

const videos: SelectedVideo[] = [
  { path: 'C:\\video\\first.mp4', name: 'first.mp4', size: 100, mediaUrl: 'ttcut-media://first' },
  { path: 'C:\\video\\second.mp4', name: 'second.mp4', size: 200, mediaUrl: 'ttcut-media://second' },
];
const thirdVideo: SelectedVideo = {
  path: 'C:\\video\\third.mp4',
  name: 'third.mp4',
  size: 300,
  mediaUrl: 'ttcut-media://third',
};

const calibration: Calibration = {
  video_width: 1920,
  video_height: 1080,
  points: {
    top_left: [600, 300], top_right: [1300, 300], bottom_right: [1500, 850], bottom_left: [400, 850],
  },
};

const tableAnalysis = {} as TableAnalysis;

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
  let startAutoCalibration: ReturnType<typeof vi.fn>;
  let startAnalysis: ReturnType<typeof vi.fn>;
  let startExport: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listener = null;
    startAutoCalibration = vi.fn()
      .mockResolvedValueOnce('calibration-task-1')
      .mockResolvedValueOnce('calibration-task-2')
      .mockResolvedValueOnce('calibration-task-3');
    startAnalysis = vi.fn()
      .mockResolvedValueOnce('analysis-task-1')
      .mockResolvedValueOnce('analysis-task-2');
    startExport = vi.fn().mockResolvedValueOnce('export-task-1');
    const api = {
      probeVideo: vi.fn((path: string) => Promise.resolve(metadata(path))),
      startAutoCalibration,
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

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function finishCalibration(taskId: string, itemCalibration = calibration) {
    act(() => listener?.({
      type: 'calibration-result',
      taskId,
      calibration: itemCalibration,
      tableAnalysis,
    }));
  }

  it('auto-calibrates sequentially before allowing mode selection', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} onOpenAnalysis={vi.fn()} />);
    await screen.findByText('first.mp4');
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));

    act(() => listener?.({
      type: 'progress',
      data: { taskId: 'calibration-task-1', kind: 'calibration', stage: 'table_sampling', percent: 100 },
    }));
    expect(await screen.findByText('40%')).toBeVisible();
    act(() => listener?.({
      type: 'progress',
      data: { taskId: 'calibration-task-1', kind: 'calibration', stage: 'table_model', percent: 0 },
    }));
    expect(screen.getByText('40%')).toBeVisible();
    act(() => listener?.({
      type: 'progress',
      data: { taskId: 'calibration-task-1', kind: 'calibration', stage: 'table_inference', percent: 50 },
    }));
    expect(await screen.findByText('80%')).toBeVisible();

    await finishCalibration('calibration-task-1');
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    expect(startAutoCalibration.mock.calls[1]?.[0]).toMatchObject({ videoPath: videos[1]!.path });
    await finishCalibration('calibration-task-2');

    const group = screen.getByRole('group', { name: 'first.mp4 的剪辑模式' });
    const highlight = within(group).getByRole('button', { name: '精彩回合' });
    await waitFor(() => expect(highlight).not.toBeDisabled());
    fireEvent.click(highlight);
    expect(highlight).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { name: '5板' })[0]).toBeVisible();
  });

  it('runs ready videos serially with precalibrated analysis and 70/30 progress mapping', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} onOpenAnalysis={vi.fn()} />);
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    await finishCalibration('calibration-task-1');
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');

    fireEvent.click(await screen.findByRole('button', { name: '开始分析剪辑' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    expect(startAnalysis).toHaveBeenCalledWith({
      videoPath: videos[0]!.path,
      calibrationChoice: { method: 'precalibrated', calibration, table_analysis: tableAnalysis },
      device: 'auto',
      historyVisibility: 'deferred',
      ballModelProfile: 'tracknet_v1',
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
      selection: { mode: 'all', pre_roll_seconds: 2.5, post_roll_seconds: 1 },
    }));

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
        outputPath: 'C:\\video\\first_TTcut_所有回合.mp4', outputName: 'first_TTcut_所有回合.mp4', mediaUrl: 'ttcut-media://output',
        timing: {
          targetSeconds: 10,
          actualSeconds: 10.05,
          driftSeconds: 0.05,
          allowedDriftSeconds: 0.1,
          segmentCount: 1,
        },
      },
    }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(2));
    expect(startAnalysis.mock.calls[1]?.[0]).toMatchObject({ videoPath: videos[1]!.path });
  });

  it('shows manual calibration for an automatic failure without exposing the raw code', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} onOpenAnalysis={vi.fn()} />);
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'error',
      taskId: 'calibration-task-1',
      code: 'AUTO_CALIBRATION_FAILED',
      message: 'AUTO_CALIBRATION_FAILED',
    }));

    expect(await screen.findByText('标定失败')).toBeVisible();
    expect(screen.getByText('手动标定')).toBeVisible();
    expect(screen.queryByText('AUTO_CALIBRATION_FAILED')).toBeNull();
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'first.mp4 手动标定' }));
    expect(await screen.findByRole('heading', { name: '标定球桌' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /返回多任务/ }));
    expect(await screen.findByRole('heading', { name: '多任务剪辑' })).toBeVisible();
  });

  it('continues ready items while a failed item waits for manual calibration', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} onOpenAnalysis={vi.fn()} />);
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'error',
      taskId: 'calibration-task-1',
      code: 'AUTO_CALIBRATION_FAILED',
      message: 'AUTO_CALIBRATION_FAILED',
    }));
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');

    fireEvent.click(await screen.findByRole('button', { name: '开始分析剪辑' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    expect(startAnalysis.mock.calls[0]?.[0].videoPath).toBe(videos[1]!.path);
  });

  it('retains a duration-mismatch output and continues the remaining batch', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} language="en" onOpenAnalysis={vi.fn()} />);
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    await finishCalibration('calibration-task-1');
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');

    fireEvent.click(await screen.findByRole('button', { name: 'Start analysis and cutting' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: analysis(videos[0]!.path),
    }));
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(1));

    act(() => listener?.({
      type: 'error',
      taskId: 'export-task-1',
      code: 'EXPORT_DURATION_MISMATCH',
      message: 'duration mismatch',
      recoveredOutputPath: 'C:\\video\\first_TTcut_duration_mismatch.mp4',
      timing: {
        targetSeconds: 100,
        actualSeconds: 102.128,
        driftSeconds: 2.128,
        allowedDriftSeconds: 0.1,
        segmentCount: 1,
      },
    }));

    const openRetained = await screen.findByRole('button', { name: 'Open retained file' });
    fireEvent.click(openRetained);
    expect(window.ttcut.revealOutput).toHaveBeenCalledWith('C:\\video\\first_TTcut_duration_mismatch.mp4');
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(2));
    expect(startAnalysis.mock.calls[1]?.[0]).toMatchObject({ videoPath: videos[1]!.path });
  });

  it('notifies once after every currently completable batch cut has ended', async () => {
    const onCompletableTasksFinished = vi.fn();
    render(
      <MultiTaskPage
        initialVideos={videos}
        preRoll={2.5}
        postRoll={1}
        onOpenAnalysis={vi.fn()}
        onCompletableTasksFinished={onCompletableTasksFinished}
      />,
    );
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'error',
      taskId: 'calibration-task-1',
      code: 'AUTO_CALIBRATION_FAILED',
      message: 'AUTO_CALIBRATION_FAILED',
    }));
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');
    expect(onCompletableTasksFinished).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: '开始分析剪辑' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '22222222-2222-4222-8222-222222222222',
      calibration,
      data: analysis(videos[1]!.path),
    }));
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'export-result',
      taskId: 'export-task-1',
      data: {
        taskId: 'export-task-1',
        analysisId: '22222222-2222-4222-8222-222222222222',
        outputPath: 'C:\\video\\second_TTcut_所有回合.mp4',
        outputName: 'second_TTcut_所有回合.mp4',
        mediaUrl: 'ttcut-media://second-output',
        timing: {
          targetSeconds: 10,
          actualSeconds: 10.05,
          driftSeconds: 0.05,
          allowedDriftSeconds: 0.1,
          segmentCount: 1,
        },
      },
    }));

    await waitFor(() => expect(onCompletableTasksFinished).toHaveBeenCalledTimes(1));
    expect(screen.getByText('标定失败')).toBeVisible();
  });

  it('turns all remaining items into manual calibration when the model is unavailable', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} onOpenAnalysis={vi.fn()} />);
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'error',
      taskId: 'calibration-task-1',
      code: 'TABLE_MODEL_RESOURCE_ERROR',
      message: 'TABLE_MODEL_RESOURCE_ERROR',
    }));
    expect(await screen.findByText(/自动标定模型不可用/)).toBeVisible();
    expect(screen.getAllByText('手动标定')).toHaveLength(2);
    expect(startAutoCalibration).toHaveBeenCalledTimes(1);

    vi.mocked(window.ttcut.selectVideos).mockResolvedValueOnce([thirdVideo]);
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加视频' }));
    expect(await screen.findByText('third.mp4')).toBeVisible();
    await waitFor(() => expect(screen.getAllByText('手动标定')).toHaveLength(3));
    expect(startAutoCalibration).toHaveBeenCalledTimes(1);
  });

  it('adds a manual repair to a batch that is already running', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} onOpenAnalysis={vi.fn()} />);
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'error',
      taskId: 'calibration-task-1',
      code: 'AUTO_CALIBRATION_FAILED',
      message: 'AUTO_CALIBRATION_FAILED',
    }));
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');

    const secondModes = screen.getByRole('group', { name: 'second.mp4 的剪辑模式' });
    fireEvent.click(within(secondModes).getByRole('button', { name: '只分析' }));
    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'first.mp4 手动标定' }));
    vi.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 450, width: 800, height: 450,
      toJSON: () => ({}),
    } as DOMRect);
    const surface = document.querySelector('.video-surface');
    expect(surface).not.toBeNull();
    for (const [clientX, clientY] of [[250, 125], [542, 125], [625, 354], [167, 354]]) {
      fireEvent.pointerDown(surface!, { clientX, clientY });
    }
    const finish = screen.getByRole('button', { name: '完成标定' });
    expect(finish).toBeEnabled();
    fireEvent.click(finish);
    expect(await screen.findByRole('heading', { name: '多任务剪辑' })).toBeVisible();

    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: analysis(videos[1]!.path),
    }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(2));
    expect(startAnalysis.mock.calls[1]?.[0]).toMatchObject({
      videoPath: videos[0]!.path,
      calibrationChoice: { method: 'precalibrated' },
    });
  });

  it('calibrates an added video before resuming requested processing', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} onOpenAnalysis={vi.fn()} />);
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    await finishCalibration('calibration-task-1');
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');

    const firstModes = screen.getByRole('group', { name: 'first.mp4 的剪辑模式' });
    fireEvent.click(within(firstModes).getByRole('button', { name: '只分析' }));
    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));

    vi.mocked(window.ttcut.selectVideos).mockResolvedValueOnce([thirdVideo]);
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加视频' }));
    expect(await screen.findByText('third.mp4')).toBeVisible();

    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: analysis(videos[0]!.path),
    }));
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(3));
    expect(startAutoCalibration.mock.calls[2]?.[0]).toMatchObject({ videoPath: thirdVideo.path });
    expect(startAnalysis).toHaveBeenCalledTimes(1);

    await finishCalibration('calibration-task-3');
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(2));
    expect(startAnalysis.mock.calls[1]?.[0]).toMatchObject({ videoPath: videos[1]!.path });
  });

  it('continues the batch after cancellation without retrying the cancelled item', async () => {
    const onTaskStateChange = vi.fn();
    render(
      <MultiTaskPage
        initialVideos={videos}
        preRoll={2.5}
        postRoll={1}
        onOpenAnalysis={vi.fn()}
        onTaskStateChange={onTaskStateChange}
      />,
    );
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    await finishCalibration('calibration-task-1');
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');

    for (const group of screen.getAllByRole('group')) {
      fireEvent.click(within(group).getAllByRole('button')[2]!);
    }
    fireEvent.click(document.querySelector('.batch-start')!);
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    fireEvent.click(document.querySelector('.batch-cover.processing')!);
    await waitFor(() => expect(window.ttcut.cancelTask).toHaveBeenCalledWith('analysis-task-1'));

    act(() => listener?.({
      type: 'error', taskId: 'analysis-task-1', code: 'WORKER_EXITED', message: 'cancelled',
    }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(2));
    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-2',
      analysisId: '22222222-2222-4222-8222-222222222222',
      calibration,
      data: analysis(videos[1]!.path),
    }));

    await waitFor(() => expect(onTaskStateChange).toHaveBeenLastCalledWith(false));
    expect(startAnalysis).toHaveBeenCalledTimes(2);
  });

  it('freezes processing settings for the lifetime of a batch', async () => {
    const view = render(
      <MultiTaskPage
        initialVideos={videos}
        preRoll={2.5}
        postRoll={1}
        exportStrategy="compatible"
        ballModelProfile="tracknet_v1"
        onOpenAnalysis={vi.fn()}
      />,
    );
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(1));
    await finishCalibration('calibration-task-1');
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');

    view.rerender(
      <MultiTaskPage
        initialVideos={videos}
        preRoll={5}
        postRoll={4}
        exportStrategy="fast_segmented"
        ballModelProfile="uplifting_dual_v1"
        onOpenAnalysis={vi.fn()}
      />,
    );
    fireEvent.click(document.querySelector('.batch-start')!);
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    expect(startAnalysis.mock.calls[0]?.[0]).toMatchObject({ ballModelProfile: 'tracknet_v1' });

    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: analysis(videos[0]!.path),
    }));
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(1));
    expect(startExport.mock.calls[0]?.[0]).toMatchObject({
      export_strategy: 'compatible',
      selection: { pre_roll_seconds: 2.5, post_roll_seconds: 1 },
    });
  });
});

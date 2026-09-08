import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiTaskPage } from '../src/renderer/MultiTaskPage';
import type { AppEvent, SelectedVideo, TTcutApi } from '../src/shared/api';
import type { AnalysisResultV1, Calibration, TableAnalysis, VideoMetadata } from '../src/shared/contracts';
import { hybridAnalysisResultV3Schema } from '../src/shared/contracts';
import hybridProvenance from './fixtures/hybrid-provenance.json';

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
  return hybridAnalysisResultV3Schema.parse({
    schema_version: 3,
    rally_recognition: hybridProvenance,
    excluded_fragments: [],
    bounce_times_seconds: [1, 2, 3, 4, 5],
    video: metadata(path),
    rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 1, end_time_seconds: 8 }],
    calibration,
  });
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
      startBatchExport: vi.fn().mockResolvedValue('batch-export-1'),
      onTaskEvent: vi.fn((next: (event: AppEvent) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
      selectVideos: vi.fn().mockResolvedValue([]),
      acceptDroppedVideo: vi.fn(),
      pathForDroppedFile: vi.fn(),
      cancelTask: vi.fn().mockResolvedValue(undefined),
      shutdownSystem: vi.fn().mockResolvedValue(undefined),
      deleteAnalysis: vi.fn().mockResolvedValue(undefined),
      revealOutput: vi.fn().mockResolvedValue(undefined),
      revealLogs: vi.fn().mockResolvedValue(undefined),
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

  async function prepareMergedBatch(onFinished = vi.fn(), initialVideos = videos) {
    render(<MultiTaskPage initialVideos={initialVideos} preRoll={2.5} postRoll={1}
      onOpenAnalysis={vi.fn()} onCompletableTasksFinished={onFinished} />);
    for (let index = 0; index < initialVideos.length; index += 1) {
      await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(index + 1));
      await finishCalibration(`calibration-task-${index + 1}`);
    }
    fireEvent.click(screen.getByRole('checkbox', { name: '合并为一个视频' }));
    return onFinished;
  }

  async function finishAnalysis(index: number, path = videos[index - 1]!.path) {
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(index));
    act(() => listener?.({ type: 'analysis-result', taskId: `analysis-task-${index}`,
      analysisId: `${index}${'1'.repeat(7)}-1111-4111-8111-111111111111`, calibration, data: analysis(path) }));
  }

  it('merges in addition order and completes only after the merged result arrives without shutdown', async () => {
    const finished = await prepareMergedBatch();
    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    expect(screen.getByRole('checkbox', { name: '合并为一个视频' })).toBeDisabled();
    await finishAnalysis(1);
    await finishAnalysis(2);
    expect(startAnalysis.mock.calls.every((call) => call[0].historyVisibility === 'visible')).toBe(true);
    await waitFor(() => expect(window.ttcut.startBatchExport).toHaveBeenCalledTimes(1));
    expect(startExport).not.toHaveBeenCalled();
    expect(window.ttcut.startBatchExport).toHaveBeenCalledWith({ items: [
      { analysis_id: '11111111-1111-4111-8111-111111111111', selection: { mode: 'all', pre_roll_seconds: 2.5, post_roll_seconds: 1 } },
      { analysis_id: '21111111-1111-4111-8111-111111111111', selection: { mode: 'all', pre_roll_seconds: 2.5, post_roll_seconds: 1 } },
    ] });
    expect(finished).not.toHaveBeenCalled();
    expect(window.ttcut.shutdownSystem).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '＋ 添加视频' })).toBeDisabled();
    for (const group of screen.getAllByRole('group')) {
      expect(within(group).getByRole('button', { name: '所有回合' })).toBeDisabled();
    }
    expect(screen.queryByRole('checkbox', { name: '完成本任务后关机' })).not.toBeInTheDocument();
    act(() => listener?.({ type: 'progress', data: { taskId: 'batch-export-1', kind: 'export', stage: 'concatenating', percent: 90 } }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '90');
    act(() => listener?.({ type: 'batch-export-result', taskId: 'batch-export-1', data: {
      outputPath: 'C:\\video\\first_TTcut_合并集锦.mp4', mediaUrl: 'ttcut-media://merged',
      width: 1280, height: 720, skippedAnalysisIds: [],
    } }));
    expect(screen.getByRole('button', { name: '开始分析剪辑' })).toBeDisabled();
    expect(window.ttcut.shutdownSystem).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(screen.getByText('合并视频已完成')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '预览输出' }));
    expect(document.querySelector('.batch-preview video')).toHaveAttribute('src', 'ttcut-media://merged');
  });

  it('disables and unchecks merging when every video is analysis only, including an empty list', async () => {
    await prepareMergedBatch();
    for (const group of screen.getAllByRole('group')) {
      fireEvent.click(within(group).getByRole('button', { name: '只分析' }));
    }
    const merge = screen.getByRole('checkbox', { name: '合并为一个视频' });
    expect(merge).toBeDisabled();
    expect(merge).not.toBeChecked();
    expect(merge.closest('label')).toHaveAttribute('title', '至少一个视频选择“所有回合”或“精彩回合”后可用。');
    for (const video of videos) fireEvent.click(screen.getByRole('button', { name: `删除 ${video.name}` }));
    expect(merge).toBeDisabled();
    expect(merge).not.toBeChecked();
  });

  it('allows one participating video and excludes analysis-only videos', async () => {
    await prepareMergedBatch();
    fireEvent.click(within(screen.getByRole('group', { name: 'second.mp4 的剪辑模式' })).getByRole('button', { name: '只分析' }));
    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    await finishAnalysis(1);
    await finishAnalysis(2);
    await waitFor(() => expect(window.ttcut.startBatchExport).toHaveBeenCalledTimes(1));
    expect(vi.mocked(window.ttcut.startBatchExport).mock.calls[0]![0].items).toHaveLength(1);
    expect(startExport).not.toHaveBeenCalled();
  });

  it('uses edits to an already analyzed item and includes videos added during analysis', async () => {
    await prepareMergedBatch();
    vi.mocked(window.ttcut.selectVideos).mockResolvedValue([thirdVideo]);
    startAnalysis.mockResolvedValueOnce('analysis-task-3');
    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    await finishAnalysis(1);
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(2));
    fireEvent.click(within(screen.getByRole('group', { name: 'first.mp4 的剪辑模式' })).getByRole('button', { name: '精彩回合' }));
    fireEvent.click(screen.getByRole('radio', { name: '7板' }));
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加视频' }));
    await screen.findByText('third.mp4');
    await finishAnalysis(2);
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(3));
    await finishCalibration('calibration-task-3');
    await finishAnalysis(3, thirdVideo.path);
    await waitFor(() => expect(window.ttcut.startBatchExport).toHaveBeenCalledTimes(1));
    const request = vi.mocked(window.ttcut.startBatchExport).mock.calls[0]![0];
    expect(request.items.map((item) => item.analysis_id[0])).toEqual(['1', '2', '3']);
    expect(request.items[0]!.selection).toMatchObject({ mode: 'highlight', criterion: { kind: 'bounce_count', threshold: 7 } });
    expect(startAnalysis).toHaveBeenCalledTimes(3);
  });

  it('blocks merging after a cancelled item and reuses completed analysis on retry', async () => {
    const finished = await prepareMergedBatch();
    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '取消 first.mp4' }));
    act(() => listener?.({ type: 'error', taskId: 'analysis-task-1', code: 'ANALYSIS_CANCELLED', message: 'cancelled' }));
    await finishAnalysis(2);
    await screen.findByText('请完成标定、重试或移除未完成的视频后再合并。');
    expect(window.ttcut.startBatchExport).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(window.ttcut.shutdownSystem).not.toHaveBeenCalled();
    startAnalysis.mockResolvedValueOnce('analysis-task-3');
    fireEvent.click(screen.getByRole('button', { name: '重试合并' }));
    await finishAnalysis(3, videos[0]!.path);
    await waitFor(() => expect(window.ttcut.startBatchExport).toHaveBeenCalledTimes(1));
    expect(vi.mocked(window.ttcut.startBatchExport).mock.calls[0]![0].items.map((item) => item.analysis_id[0])).toEqual(['3', '2']);
    expect(startAnalysis).toHaveBeenCalledTimes(3);
  });

  it('waits for an open add-video dialog before taking the final merge snapshot', async () => {
    await prepareMergedBatch(vi.fn(), videos.slice(0, 1));
    let resolveSelection!: (videos: SelectedVideo[]) => void;
    vi.mocked(window.ttcut.selectVideos).mockImplementation(() => new Promise((resolve) => { resolveSelection = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加视频' }));
    await finishAnalysis(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(window.ttcut.startBatchExport).not.toHaveBeenCalled();
    await act(async () => { resolveSelection([videos[1]!]); });
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');
    await finishAnalysis(2);
    await waitFor(() => expect(window.ttcut.startBatchExport).toHaveBeenCalledTimes(1));
    expect(vi.mocked(window.ttcut.startBatchExport).mock.calls[0]![0].items).toHaveLength(2);
  });

  it('does not request shutdown when a merged batch contains an analysis warning', async () => {
    await prepareMergedBatch(vi.fn(), videos.slice(0, 1));
    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    act(() => listener?.({ type: 'analysis-result', taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111', calibration,
      data: { ...analysis(videos[0]!.path), processing: {
        mode: 'vfr_fallback', warning_code: 'CFR_FALLBACK',
      } } as AnalysisResultV1,
    }));
    await waitFor(() => expect(window.ttcut.startBatchExport).toHaveBeenCalledTimes(1));
    act(() => listener?.({ type: 'batch-export-result', taskId: 'batch-export-1', data: {
      outputPath: 'C:\\merged.mp4', mediaUrl: 'ttcut-media://merged', width: 1920, height: 1080, skippedAnalysisIds: [],
    } }));
    expect(window.ttcut.shutdownSystem).not.toHaveBeenCalled();
  });

  it.each(['EXPORT_FAILED', 'EXPORT_CANCELLED', 'BATCH_EXPORT_EMPTY'])('does not shut down for %s and retries export without analysis', async (code) => {
    const finished = await prepareMergedBatch(vi.fn(), videos.slice(0, 1));
    fireEvent.click(screen.getByRole('button', { name: '开始分析剪辑' }));
    await finishAnalysis(1);
    await waitFor(() => expect(window.ttcut.startBatchExport).toHaveBeenCalledTimes(1));
    if (code === 'EXPORT_CANCELLED') {
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      expect(window.ttcut.cancelTask).toHaveBeenCalledWith('batch-export-1');
    }
    act(() => listener?.({ type: 'error', taskId: 'batch-export-1', code, message: code }));
    expect(finished).not.toHaveBeenCalled();
    expect(window.ttcut.shutdownSystem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试合并' }));
    await waitFor(() => expect(window.ttcut.startBatchExport).toHaveBeenCalledTimes(2));
    expect(startAnalysis).toHaveBeenCalledTimes(1);
  });

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
    expect(screen.getByRole('radio', { name: '5板' })).toBeChecked();
  });

  it('runs ready videos serially with precalibrated analysis and 70/30 progress mapping', async () => {
    render(<MultiTaskPage initialVideos={videos} preRoll={2.5} postRoll={1} normalizeVariableFrameRate onOpenAnalysis={vi.fn()} />);
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
      normalizeVariableFrameRate: true,
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

  it('marks a usable warning output as done and continues the remaining batch', async () => {
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
      type: 'export-result',
      taskId: 'export-task-1',
      data: {
        taskId: 'export-task-1',
        analysisId: '11111111-1111-4111-8111-111111111111',
        outputPath: 'C:\\video\\first_TTcut.mp4',
        outputName: 'first_TTcut.mp4',
        mediaUrl: 'ttcut-media://first-output',
        timing: {
          targetSeconds: 100,
          actualSeconds: 102.128,
          driftSeconds: 2.128,
          allowedDriftSeconds: 0.1,
          segmentCount: 1,
        },
        warning: {
          code: 'EXPORT_DURATION_MISMATCH',
          message: 'duration mismatch',
        },
      },
    }));

    expect(await screen.findByText('Exported with warning')).toBeVisible();
    expect(screen.getByText('EXPORT_DURATION_MISMATCH')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open logs' }));
    expect(window.ttcut.revealLogs).toHaveBeenCalledTimes(1);
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
    expect(window.ttcut.shutdownSystem).not.toHaveBeenCalled();
  });

  it('completes analysis-only batches without a shutdown option', async () => {
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
    await finishCalibration('calibration-task-1');
    await waitFor(() => expect(startAutoCalibration).toHaveBeenCalledTimes(2));
    await finishCalibration('calibration-task-2');

    for (const group of screen.getAllByRole('group')) {
      fireEvent.click(within(group).getAllByRole('button')[2]!);
    }
    fireEvent.click(document.querySelector('.batch-start')!);
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: analysis(videos[0]!.path),
    }));
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(2));
    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-2',
      analysisId: '22222222-2222-4222-8222-222222222222',
      calibration,
      data: analysis(videos[1]!.path),
    }));

    await waitFor(() => expect(onCompletableTasksFinished).toHaveBeenCalledTimes(1));
    expect(window.ttcut.shutdownSystem).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox', { name: '完成本任务后关机' })).not.toBeInTheDocument();
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
    for (const [clientX, clientY] of [[625, 354], [250, 125], [167, 354], [542, 125]]) {
      fireEvent.pointerDown(surface!, { clientX, clientY });
    }
    const polygon = document.querySelector('.calibration-polygon polygon');
    expect(polygon).not.toBeNull();
    const pointsBeforeDrag = polygon!.getAttribute('points');
    const firstPoint = screen.getByRole('button', { name: 'Calibration point 1' });
    Object.defineProperty(firstPoint, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(firstPoint, 'releasePointerCapture', { configurable: true, value: vi.fn() });
    fireEvent.pointerDown(firstPoint, { clientX: 625, clientY: 354, pointerId: 1 });
    fireEvent.pointerMove(firstPoint, { clientX: 610, clientY: 345, pointerId: 1 });
    fireEvent.pointerUp(firstPoint, { pointerId: 1 });
    expect(polygon!.getAttribute('points')).not.toBe(pointsBeforeDrag);
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

  it('freezes timing settings for the lifetime of a batch', async () => {
    const view = render(
      <MultiTaskPage
        initialVideos={videos}
        preRoll={2.5}
        postRoll={1}
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
        onOpenAnalysis={vi.fn()}
      />,
    );
    fireEvent.click(document.querySelector('.batch-start')!);
    await waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(1));
    expect(startAnalysis.mock.calls[0]?.[0]).not.toHaveProperty('ballModelProfile');
    expect(startAnalysis.mock.calls[0]?.[0]).not.toHaveProperty('analysisMode');
    expect(startAnalysis.mock.calls[0]?.[0]).not.toHaveProperty('rallyRecognitionMethod');

    act(() => listener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: analysis(videos[0]!.path),
    }));
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(1));
    expect(startExport.mock.calls[0]?.[0]).toMatchObject({
      selection: { pre_roll_seconds: 2.5, post_roll_seconds: 1 },
    });
  });
});

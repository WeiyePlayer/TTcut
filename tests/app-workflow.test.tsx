import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { SUPPORT_PROMPT_SNOOZE_MS, SUPPORT_PROMPT_SNOOZE_STORAGE_KEY } from '../src/domain/support-prompt';
import type { AppEvent, BootstrapData, SelectedVideo, TTcutApi } from '../src/shared/api';
import type { VideoMetadata } from '../src/shared/contracts';

const bootstrap: BootstrapData = {
  version: '1.2.4',
  settings: {
    language: 'zh-CN',
    calibration_method: 'automatic',
    ball_model_profile: 'blurball_v1',
    pre_roll_seconds: 2.5,
    post_roll_seconds: 2,
  },
  components: {
    analysis: {
      available: true,
      version: 'Python 3.12.13',
      path: 'C:\\runtime\\python.exe',
      acceleration: 'cuda',
      detail: null,
    },
    media: {
      available: true,
      version: 'ffmpeg 8.1',
      path: 'C:\\ffmpeg\\ffmpeg.exe',
      active_encoder: 'libopenh264',
      x264_available: false,
      detail: null,
    },
  },
  componentSetup: {
    analysis_offer: null,
    media_offer: null,
    x264_manual_offer: {
      id: 'media-x264',
      version: 'N-125716-g1b1f602699',
      filename: 'ffmpeg-x264.zip',
      download_size_bytes: 1,
      license_url: 'https://example.com/license',
    },
  },
  platformCompatibility: {
    status: 'supported',
    reason: 'supported',
    platform: 'win32',
    architecture: 'x64',
    build_number: 26100,
    installation_type: 'Client',
  },
  logsPath: 'C:\\logs',
};

function metadata(path: string): VideoMetadata {
  return {
    path,
    duration_seconds: 10,
    width: 1280,
    height: 720,
    fps: 30,
    variable_frame_rate: false,
    video_codec: 'h264',
    audio_codec: 'aac',
    container: 'mp4',
  };
}

const calibration = {
  video_width: 1280,
  video_height: 720,
  points: {
    top_left: [300, 200] as [number, number],
    top_right: [900, 200] as [number, number],
    bottom_right: [1000, 600] as [number, number],
    bottom_left: [200, 600] as [number, number],
  },
};

describe('App workflow notices and multi-task entry', () => {
  let taskListener: ((event: AppEvent) => void) | null;
  let selectVideos: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bootstrap.settings.language = 'zh-CN';
    window.localStorage.clear();
    taskListener = null;
    selectVideos = vi.fn().mockResolvedValue([]);
    const api = {
      bootstrap: vi.fn().mockResolvedValue(bootstrap),
      onTaskEvent: vi.fn((listener: (event: AppEvent) => void) => {
        taskListener = listener;
        return () => { taskListener = null; };
      }),
      onCloseRequested: vi.fn(() => () => undefined),
      onUpdateState: vi.fn(() => () => undefined),
      getUpdateState: vi.fn().mockResolvedValue({
        status: 'idle',
        version: null,
        message: null,
      }),
      openExternalUrl: vi.fn().mockResolvedValue(undefined),
      revealLogs: vi.fn().mockResolvedValue(undefined),
      revealOutput: vi.fn().mockResolvedValue(undefined),
      selectVideos,
      probeVideo: vi.fn((path: string) => Promise.resolve(metadata(path))),
      startAutoCalibration: vi.fn().mockResolvedValue('calibration-task-1'),
      startAnalysis: vi.fn().mockResolvedValue('analysis-task-1'),
      startExport: vi.fn().mockResolvedValue('export-task-1'),
      cancelTask: vi.fn().mockResolvedValue(undefined),
      listHistory: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn((settings) => Promise.resolve(settings)),
    } as unknown as TTcutApi;
    Object.defineProperty(window, 'ttcut', { configurable: true, value: api });
  });

  afterEach(() => {
    bootstrap.settings.language = 'zh-CN';
    bootstrap.settings.ball_model_profile = 'blurball_v1';
    bootstrap.components.analysis.acceleration = 'cuda';
    window.localStorage.clear();
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a safe verification error with a manual-download action', async () => {
    bootstrap.settings.language = 'en';
    vi.mocked(window.ttcut.getUpdateState).mockResolvedValue({
      status: 'error',
      version: null,
      message: 'UPDATE_VERIFICATION_FAILED',
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));

    expect(await screen.findByText('The downloaded update could not be verified. Download it manually from the official release page.')).toBeVisible();
    const manualDownload = screen.getByRole('button', { name: 'Download update manually' });
    fireEvent.click(manualDownload);
    expect(window.ttcut.openExternalUrl).toHaveBeenCalledWith('https://github.com/WeiyePlayer/TTcut/releases');
  });

  it('does not expose an export strategy setting', async () => {
    bootstrap.settings.language = 'en';
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));

    expect(screen.queryByRole('heading', { name: 'Export strategy' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Compatible mode|Fast segmented mode/ })).toBeNull();
  });

  it('presents video selection as a single or multi-task workflow', async () => {
    render(<App />);

    await screen.findByRole('heading', { name: '选择比赛视频' });
    expect(screen.getByText('选择 MP4 或 MOV 比赛视频开始本地分析，支持多任务批量处理。')).toBeVisible();
    expect(screen.getByText('或将 MP4 / MOV 文件拖到这里')).toBeVisible();
    expect(screen.queryByText(/单个|一次只能处理一个/)).toBeNull();
  });

  it('shows the simplified ball model profile copy', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    expect(screen.getByRole('button', { name: 'BlurBall（默认）CPU / CUDA；阈值 0.7，步长 3，最大位移 100 px。' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'TrackNet速度快，精准度一般。' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /新模型|New model/ })).toBeNull();
    expect(screen.queryByText(/双检测模型|dual detection models/i)).toBeNull();
    expect(screen.queryByText('单视频和多任务统一使用所选档位。板数仍表示落台反弹数。')).toBeNull();
  });

  it('persists the bundled BlurBall profile directly when CUDA is available', async () => {
    bootstrap.settings.language = 'en';
    bootstrap.settings.ball_model_profile = 'tracknet_v1';
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: /BlurBall/ }));

    await waitFor(() => expect(window.ttcut.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      ball_model_profile: 'blurball_v1',
    })));
  });

  it('allows the bundled BlurBall profile when only the CPU component is active', async () => {
    bootstrap.settings.language = 'en';
    bootstrap.settings.ball_model_profile = 'tracknet_v1';
    bootstrap.components.analysis.acceleration = 'cpu';
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const blurball = screen.getByRole('button', { name: /BlurBall/ });

    expect(blurball).toBeEnabled();
    fireEvent.click(blurball);

    await waitFor(() => expect(window.ttcut.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      ball_model_profile: 'blurball_v1',
    })));
  });

  it('keeps a persisted BlurBall profile ready when bootstrap resolves the CPU component', async () => {
    bootstrap.settings.language = 'en';
    bootstrap.settings.ball_model_profile = 'blurball_v1';
    bootstrap.components.analysis.acceleration = 'cpu';

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Choose match videos' })).toBeVisible();
  });

  it('hides the automatic calibration failure notice after three seconds', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: '选择比赛视频' });
    vi.useFakeTimers();

    act(() => taskListener?.({
      type: 'error',
      taskId: 'analysis-task',
      code: 'AUTO_CALIBRATION_FAILED',
      message: 'AUTO_CALIBRATION_FAILED',
    }));

    expect(screen.getByRole('status')).toHaveTextContent('自动标定不可靠，请改用手动标定。');
    act(() => vi.advanceTimersByTime(2_999));
    expect(screen.getByRole('status')).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('opens multi-task clipping directly without the test confirmation', async () => {
    const videos: SelectedVideo[] = [
      {
        path: 'C:\\video\\first.mp4',
        name: 'first.mp4',
        size: 100,
        mediaUrl: 'ttcut-media://first',
      },
      {
        path: 'C:\\video\\second.mp4',
        name: 'second.mp4',
        size: 200,
        mediaUrl: 'ttcut-media://second',
      },
    ];
    selectVideos.mockResolvedValue(videos);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />);
    await screen.findByRole('heading', { name: '选择比赛视频' });

    fireEvent.click(screen.getByRole('button', { name: /选择 MP4 \/ MOV 视频/ }));

    await screen.findByRole('heading', { name: '多任务剪辑' });
    await waitFor(() => expect(screen.getByText('first.mp4')).toBeVisible());
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '设置' })).toBeVisible();
    expect(screen.getByText('first.mp4')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '自动剪辑' }));
    expect(await screen.findByText('first.mp4')).toBeVisible();
    expect(window.ttcut.cancelTask).not.toHaveBeenCalled();
  });

  it('returns to an active single-video process across history and settings', async () => {
    bootstrap.settings.language = 'en';
    selectVideos.mockResolvedValue([{
      path: 'C:\\video\\first.mp4', name: 'first.mp4', size: 100, mediaUrl: 'ttcut-media://first',
    }]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Choose MP4 \/ MOV videos/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start analysis' }));
    expect(await screen.findByRole('heading', { name: 'Analyzing video' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByRole('heading', { name: 'History' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Auto Cut' }));
    expect(await screen.findByRole('heading', { name: 'Analyzing video' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Auto Cut' }));
    expect(await screen.findByRole('heading', { name: 'Analyzing video' })).toBeVisible();
    expect(window.ttcut.startAnalysis).toHaveBeenCalledTimes(1);
    expect(window.ttcut.cancelTask).not.toHaveBeenCalled();
  });

  it('returns home when analysis finishes while another page is open', async () => {
    bootstrap.settings.language = 'en';
    const selected = {
      path: 'C:\\video\\first.mp4', name: 'first.mp4', size: 100, mediaUrl: 'ttcut-media://first',
    };
    selectVideos.mockResolvedValue([selected]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Choose MP4 \/ MOV videos/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start analysis' }));
    await screen.findByRole('heading', { name: 'Analyzing video' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    act(() => taskListener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: {
        schema_version: 1,
        video: metadata(selected.path),
        rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 1, end_time_seconds: 5 }],
        calibration,
      },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Cut' }));

    expect(await screen.findByRole('heading', { name: 'Choose match videos' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Choose a cutting mode' })).toBeNull();
  });

  it('returns to active cutting but goes home after export completes', async () => {
    bootstrap.settings.language = 'en';
    const selected = {
      path: 'C:\\video\\first.mp4', name: 'first.mp4', size: 100, mediaUrl: 'ttcut-media://first',
    };
    selectVideos.mockResolvedValue([selected]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Choose MP4 \/ MOV videos/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start analysis' }));
    act(() => taskListener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: {
        schema_version: 1,
        video: metadata(selected.path),
        rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 1, end_time_seconds: 5 }],
        calibration,
      },
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start cutting' }));
    expect(await screen.findByRole('heading', { name: 'Preparing' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Cut' }));
    expect(await screen.findByRole('heading', { name: 'Preparing' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    act(() => taskListener?.({
      type: 'export-result',
      taskId: 'export-task-1',
      data: {
        taskId: 'export-task-1',
        analysisId: '11111111-1111-4111-8111-111111111111',
        outputPath: 'C:\\video\\first_TTcut.mp4',
        outputName: 'first_TTcut.mp4',
        mediaUrl: 'ttcut-media://output',
        timing: {
          targetSeconds: 100,
          actualSeconds: 100.05,
          driftSeconds: 0.05,
          allowedDriftSeconds: 0.1,
          segmentCount: 1,
        },
      },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Cut' }));
    expect(await screen.findByRole('heading', { name: 'Choose match videos' })).toBeVisible();
  });

  it('edits explicit custom ranges, preserves them on export cancellation, and resets them on back', async () => {
    bootstrap.settings.language = 'en';
    const selected = {
      path: 'C:\\video\\first.mp4', name: 'first.mp4', size: 100, mediaUrl: 'ttcut-media://first',
    };
    selectVideos.mockResolvedValue([selected]);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Choose MP4 \/ MOV videos/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start analysis' }));
    act(() => taskListener?.({
      type: 'analysis-result',
      taskId: 'analysis-task-1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      calibration,
      data: {
        schema_version: 1,
        video: metadata(selected.path),
        rallies: [
          { id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 1, end_time_seconds: 2 },
          { id: 'rally_002', index: 2, bounce_count: 6, start_time_seconds: 6, end_time_seconds: 7 },
        ],
        calibration,
      },
    }));

    fireEvent.click(await screen.findByRole('button', { name: /Custom/ }));
    expect(screen.getByRole('region', { name: 'Custom cut timeline' })).toBeVisible();
    const monitor = document.querySelector('.custom-monitor video') as HTMLVideoElement;
    Object.defineProperty(monitor, 'paused', { configurable: true, value: true });
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(play).toHaveBeenCalledTimes(1);
    Object.defineProperty(monitor, 'paused', { configurable: true, value: false });
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(pause).toHaveBeenCalledTimes(1);

    const viewport = document.querySelector('.timeline-viewport') as HTMLDivElement;
    expect(document.querySelector('.timeline-track')).not.toBeNull();
    expect(document.querySelector('.timeline-toolbar')).toBeNull();
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1, bottom: 78, width: 1, height: 78, toJSON: () => ({}),
    });
    const playhead = screen.getByRole('slider', { name: 'Custom cut timeline' });
    Object.defineProperty(playhead, 'setPointerCapture', { configurable: true, value: vi.fn() });
    fireEvent.pointerDown(playhead, { pointerId: 7, clientX: 0.2 });
    fireEvent.pointerMove(playhead, { pointerId: 7, clientX: 0.6 });
    expect(monitor.currentTime).toBeGreaterThan(0);
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBeCloseTo(monitor.currentTime, 4);
    fireEvent.pointerUp(playhead, { pointerId: 7, clientX: 0.6 });
    Object.defineProperty(monitor, 'paused', { configurable: true, value: true });
    playhead.focus();
    fireEvent.keyDown(playhead, { key: ' ', code: 'Space' });
    expect(play).toHaveBeenCalledTimes(2);

    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(document.querySelectorAll('.timeline-clip')).toHaveLength(2);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getAllByRole('checkbox').every((input) => (input as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Rally 2' }));
    expect(document.querySelectorAll('.timeline-clip')).toHaveLength(1);
    const endHandle = screen.getByRole('slider', { name: 'Resize clip end 1' });
    const defaultEnd = Number(endHandle.getAttribute('aria-valuenow'));
    fireEvent.keyDown(endHandle, { key: 'ArrowLeft' });
    const editedEnd = Number(screen.getByRole('slider', { name: 'Resize clip end 1' }).getAttribute('aria-valuenow'));
    expect(editedEnd).toBeLessThan(defaultEnd);

    Object.defineProperty(endHandle, 'setPointerCapture', { configurable: true, value: vi.fn() });
    fireEvent.pointerDown(endHandle, { pointerId: 8, clientX: 10 });
    fireEvent.pointerMove(endHandle, { pointerId: 8, clientX: 9.9 });
    expect(screen.getByText('-1.00 s')).toBeVisible();
    fireEvent.pointerUp(endHandle, { pointerId: 8, clientX: 9.9 });
    expect(screen.queryByText('-1.00 s')).toBeNull();
    const draggedEnd = Number(screen.getByRole('slider', { name: 'Resize clip end 1' }).getAttribute('aria-valuenow'));
    expect(draggedEnd).toBeLessThan(editedEnd);

    fireEvent.click(screen.getByRole('button', { name: 'Start cutting' }));
    await waitFor(() => expect(window.ttcut.startExport).toHaveBeenCalledWith(expect.objectContaining({
      selection: {
        mode: 'custom',
        segments: [{ rally_id: 'rally_001', start_time_seconds: 0, end_time_seconds: draggedEnd }],
      },
    })));
    act(() => taskListener?.({
      type: 'error', taskId: 'export-task-1', code: 'EXPORT_CANCELLED', message: 'EXPORT_CANCELLED',
    }));
    expect(await screen.findByRole('region', { name: 'Custom cut timeline' })).toBeVisible();
    expect(Number(screen.getByRole('slider', { name: 'Resize clip end 1' }).getAttribute('aria-valuenow'))).toBe(draggedEnd);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Choose a cutting mode' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Custom/ }));
    expect(Number(screen.getByRole('slider', { name: 'Resize clip end 1' }).getAttribute('aria-valuenow'))).toBe(defaultEnd);
    expect(screen.getAllByRole('checkbox').every((input) => (input as HTMLInputElement).checked)).toBe(true);
  });

  it('keeps the export support prompt visible across pages until it is rejected', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: '选择比赛视频' });

    act(() => taskListener?.({
      type: 'export-result',
      taskId: 'export-task-1',
      data: {
        taskId: 'export-task-1',
        analysisId: '11111111-1111-4111-8111-111111111111',
        outputPath: 'C:\\video\\first_TTcut.mp4',
        outputName: 'first_TTcut.mp4',
        mediaUrl: 'ttcut-media://output',
        timing: {
          targetSeconds: 100,
          actualSeconds: 102.128,
          driftSeconds: 2.128,
          allowedDriftSeconds: 3.4,
          segmentCount: 73,
        },
      },
    }));

    expect(await screen.findByRole('status')).toHaveTextContent('+2.13');
    const prompt = await screen.findByRole('region', { name: '使用与赞助提示' });
    expect(within(prompt).getByText((_content, element) => element?.textContent === (
      '如果使用中遇到问题请联系作者。\n\n如果软件对您有帮助希望可以赞助我，感谢'
    ))).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(prompt).toBeVisible();

    fireEvent.click(within(prompt).getByRole('button', { name: '前往赞助' }));
    expect(window.ttcut.openExternalUrl).toHaveBeenCalledWith('https://ifdian.net/a/weiye');

    fireEvent.click(within(prompt).getByRole('button', { name: '拒绝' }));
    expect(screen.queryByRole('region', { name: '使用与赞助提示' })).toBeNull();
  });

  it('honors the adjacent thirty-day rejection option on later exports', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    render(<App />);
    await screen.findByRole('heading', { name: '选择比赛视频' });

    const finishExport = () => act(() => taskListener?.({
      type: 'export-result',
      taskId: 'export-task-1',
      data: {
        taskId: 'export-task-1',
        analysisId: '11111111-1111-4111-8111-111111111111',
        outputPath: 'C:\\video\\first_TTcut.mp4',
        outputName: 'first_TTcut.mp4',
        mediaUrl: 'ttcut-media://output',
        timing: {
          targetSeconds: 100,
          actualSeconds: 100.05,
          driftSeconds: 0.05,
          allowedDriftSeconds: 0.1,
          segmentCount: 1,
        },
      },
    }));

    finishExport();
    const prompt = await screen.findByRole('region', { name: '使用与赞助提示' });
    fireEvent.click(within(prompt).getByRole('button', { name: '更多拒绝选项' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '30天内不再显示' }));

    expect(window.localStorage.getItem(SUPPORT_PROMPT_SNOOZE_STORAGE_KEY)).toBe(String(now + SUPPORT_PROMPT_SNOOZE_MS));
    expect(screen.queryByRole('region', { name: '使用与赞助提示' })).toBeNull();

    finishExport();
    expect(screen.queryByRole('region', { name: '使用与赞助提示' })).toBeNull();
  });

  it('shows a successful export page with warning details and a logs action', async () => {
    bootstrap.settings.language = 'en';
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose match videos' });

    act(() => taskListener?.({
      type: 'export-result',
      taskId: 'export-task-1',
      data: {
        taskId: 'export-task-1',
        analysisId: '11111111-1111-4111-8111-111111111111',
        outputPath: 'C:\\video\\first_TTcut.mp4',
        outputName: 'first_TTcut.mp4',
        mediaUrl: 'ttcut-media://output',
        timing: {
          targetSeconds: 100,
          actualSeconds: 102.128,
          driftSeconds: 2.128,
          allowedDriftSeconds: 0.1,
          segmentCount: 1,
        },
        warning: {
          code: 'EXPORT_DURATION_MISMATCH',
          message: 'EXPORT_DURATION_MISMATCH: target=100 actual=102.128',
        },
      },
    }));

    expect(await screen.findByRole('heading', { name: 'Export complete' })).toBeVisible();
    expect(screen.getByText('C:\\video\\first_TTcut.mp4')).toBeVisible();
    expect(screen.getByText('The video was exported with a processing warning')).toBeVisible();
    expect(screen.getByText('EXPORT_DURATION_MISMATCH')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));
    expect(window.ttcut.revealLogs).toHaveBeenCalledTimes(1);
  });
});

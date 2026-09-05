import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { SUPPORT_PROMPT_SNOOZE_MS, SUPPORT_PROMPT_SNOOZE_STORAGE_KEY } from '../src/domain/support-prompt';
import type { AppEvent, BootstrapData, SelectedVideo, TTcutApi } from '../src/shared/api';
import type { VideoMetadata } from '../src/shared/contracts';

const bootstrap: BootstrapData = {
  version: '1.2.11',
  settings: {
    language: 'zh-CN',
    calibration_method: 'automatic',
    pre_roll_seconds: 2.5,
    post_roll_seconds: 1,
    analysis_mode: 'full',
    rally_recognition_method: 'bounce_events',
    normalize_variable_frame_rate: false,
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
      pathForDroppedFile: vi.fn((file: File) => `C:\\video\\${file.name}`),
      acceptDroppedVideo: vi.fn((path: string) => Promise.resolve({
        path,
        name: path.split('\\').at(-1) ?? path,
        size: 100,
        mediaUrl: 'ttcut-media://dropped',
      })),
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

  it('keeps the video selection page copy to its two requested messages', async () => {
    render(<App />);

    await screen.findByRole('heading', { name: '选择比赛视频' });
    expect(screen.getByRole('button', { name: '选择或将文件拖到这里' })).toBeVisible();
    expect(document.querySelector('.drop-zone .drop-icon')).toBeVisible();
    expect(screen.queryByText('选择 MP4 或 MOV 比赛视频开始本地分析，支持多任务批量处理。')).toBeNull();
    expect(screen.queryByText('或将 MP4 / MOV 文件拖到这里')).toBeNull();
    expect(screen.queryByText(/单个|一次只能处理一个/)).toBeNull();
  });

  it('shows video probe progress and advances after metadata is ready', async () => {
    const selected = {
      path: 'C:\\video\\long-match.mp4', name: 'long-match.mp4', size: 100, mediaUrl: 'ttcut-media://long-match',
    };
    let resolveProbe!: (value: VideoMetadata) => void;
    selectVideos.mockResolvedValue([selected]);
    vi.mocked(window.ttcut.probeVideo).mockImplementationOnce(() => new Promise((resolve) => { resolveProbe = resolve; }));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '选择或将文件拖到这里' }));

    const loading = await screen.findByRole('button', { name: '正在读取视频' });
    expect(loading).toBeDisabled();
    expect(loading).toHaveAttribute('aria-busy', 'true');

    await act(async () => resolveProbe(metadata(selected.path)));
    expect(await screen.findByRole('heading', { name: '标定球桌' })).toBeVisible();
  });

  it('accepts a dropped video and advances after probing it', async () => {
    const file = new File(['video'], '拖放比赛.mp4', { type: 'video/mp4' });
    render(<App />);

    const dropZone = await screen.findByRole('button', { name: '选择或将文件拖到这里' });
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    expect(await screen.findByRole('heading', { name: '标定球桌' })).toBeVisible();
    expect(window.ttcut.pathForDroppedFile).toHaveBeenCalledWith(file);
    expect(window.ttcut.acceptDroppedVideo).toHaveBeenCalledWith('C:\\video\\拖放比赛.mp4');
    expect(window.ttcut.probeVideo).toHaveBeenCalledWith('C:\\video\\拖放比赛.mp4');
  });

  it('reports a file-picker failure instead of leaving the selection page stuck', async () => {
    selectVideos.mockRejectedValue(new Error('INVALID_INPUT'));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '选择或将文件拖到这里' }));

    expect(await screen.findByRole('heading', { name: '无法完成操作' })).toBeVisible();
    expect(screen.getByText('INVALID_INPUT')).toBeVisible();
  });

  it('groups both timing controls into one card and applies the glass-radio style to settings choices', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    const timingCard = document.querySelector('.timing-settings-card');
    expect(timingCard).not.toBeNull();
    expect(document.querySelectorAll('.timing-settings-card')).toHaveLength(1);
    expect(within(timingCard as HTMLElement).getByRole('heading', { name: '回合前时间' })).toBeVisible();
    expect(within(timingCard as HTMLElement).getByRole('heading', { name: '回合后时间' })).toBeVisible();
    expect(screen.getByRole('radio', { name: '简体中文' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '自动' })).toBeChecked();
    expect(screen.getByRole('radiogroup', { name: '语言' })).toHaveClass('glass-radio-group');
    expect(within(screen.getByRole('radiogroup', { name: '回合前时间' })).getByRole('radio', { name: '中' })).toBeChecked();
    expect(within(screen.getByRole('radiogroup', { name: '回合后时间' })).getByRole('radio', { name: '短' })).toBeChecked();
  });

  it('hides the temporary BlurBall threshold controls and uses session defaults', async () => {
    const selected = {
      path: 'C:\\video\\threshold.mp4', name: 'threshold.mp4', size: 100, mediaUrl: 'ttcut-media://threshold',
    };
    selectVideos.mockResolvedValue([selected]);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    expect(screen.getByRole('heading', { name: '分析精度' })).toBeVisible();
    expect(screen.getByText('高精模式识别精度很高，花费时间增长。')).toBeVisible();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(window.ttcut.saveSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '自动剪辑' }));
    fireEvent.click(await screen.findByRole('button', { name: '选择或将文件拖到这里' }));
    fireEvent.click(await screen.findByRole('button', { name: '开始分析' }));

    await waitFor(() => expect(window.ttcut.startAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      videoPath: selected.path,
      analysisMode: 'full',
      normalizeVariableFrameRate: false,
      blurballConfidenceThreshold: 0.7,
      blurballStage1ConfidenceThreshold: 0.3,
      blurballStage2ConfidenceThreshold: 0.7,
    })));
  });

  it('defaults VFR normalization to off, persists the choice, and passes it to analysis', async () => {
    const selected = {
      path: 'C:\\video\\vfr.mp4', name: 'vfr.mp4', size: 100, mediaUrl: 'ttcut-media://vfr',
    };
    selectVideos.mockResolvedValue([selected]);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const group = screen.getByRole('radiogroup', { name: '重编码为固定帧率' });
    expect(within(group).getByRole('radio', { name: '关闭' })).toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: '开启' }));
    await waitFor(() => expect(window.ttcut.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      normalize_variable_frame_rate: true,
    })));

    fireEvent.click(screen.getByRole('button', { name: '自动剪辑' }));
    fireEvent.click(await screen.findByRole('button', { name: '选择或将文件拖到这里' }));
    fireEvent.click(await screen.findByRole('button', { name: '开始分析' }));
    await waitFor(() => expect(window.ttcut.startAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      videoPath: selected.path,
      normalizeVariableFrameRate: true,
    })));
  });

  it('switches analysis precision without exposing threshold controls', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('radio', { name: '高精' }));

    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull());
    expect(window.ttcut.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ analysis_mode: 'two_stage' }));

    fireEvent.click(screen.getByRole('radio', { name: '默认' }));
    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull());
  });

  it('uses continuous visibility as a separate setting, hides precision, and preserves it for bounce events', async () => {
    bootstrap.settings.analysis_mode = 'two_stage';
    const selected = {
      path: 'C:\\video\\visible.mp4', name: 'visible.mp4', size: 100, mediaUrl: 'ttcut-media://visible',
    };
    selectVideos.mockResolvedValue([selected]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    expect(screen.getByRole('radio', { name: '落台判定' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '连续运动' }));

    await waitFor(() => expect(window.ttcut.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      rally_recognition_method: 'continuous_visibility', analysis_mode: 'two_stage',
    })));
    expect(screen.queryByRole('heading', { name: '分析精度' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '落台判定' }));
    expect(await screen.findByRole('heading', { name: '分析精度' })).toBeVisible();
    expect(screen.getByRole('radio', { name: '高精' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '连续运动' }));

    fireEvent.click(screen.getByRole('button', { name: '自动剪辑' }));
    fireEvent.click(await screen.findByRole('button', { name: '选择或将文件拖到这里' }));
    fireEvent.click(await screen.findByRole('button', { name: '开始分析' }));
    await waitFor(() => expect(window.ttcut.startAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      analysisMode: 'full', rallyRecognitionMethod: 'continuous_visibility',
    })));
    bootstrap.settings.analysis_mode = 'full';
    bootstrap.settings.rally_recognition_method = 'bounce_events';
  });

  it('opens each settings website button through the external-link API', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    for (const [name, url] of [
      ['官方网站', 'https://ttcut.vercel.app/'],
      ['GitHub', 'https://github.com/WeiyePlayer/TTcut'],
      ['打赏作者', 'https://ifdian.net/a/weiye'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(window.ttcut.openExternalUrl).toHaveBeenLastCalledWith(url);
    }
  });

  it('replaces release notes with an author-contact QR tooltip', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    expect(screen.queryByRole('button', { name: '更新日志' })).toBeNull();
    expect(screen.getByRole('button', { name: '联系作者' })).toBeVisible();
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveAttribute('id', 'contact-author-qr');
    expect(within(tooltip).getByText('微信扫码联系作者')).toBeVisible();
    expect(within(tooltip).getByRole('img', { name: '联系作者微信二维码' })).toBeVisible();
  });

  it('does not expose a ball model selector', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    expect(screen.queryByRole('heading', { name: '球识别模型' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Ball recognition model' })).toBeNull();
    expect(screen.queryByRole('button', { name: /新模型|旧模型|New model|Old model/ })).toBeNull();
  });

  it('keeps the BlurBall flow ready when bootstrap resolves the CPU component', async () => {
    bootstrap.settings.language = 'en';
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

    fireEvent.click(screen.getByRole('button', { name: '选择或将文件拖到这里' }));

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
    fireEvent.click(await screen.findByRole('button', { name: 'Choose or drop a file here' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Choose or drop a file here' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Choose or drop a file here' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Choose or drop a file here' }));
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

    expect(document.querySelector('.mode-card-navigate .mode-card-chevron')).not.toBeNull();
    expect(document.querySelector('.mode-card-navigate .radio-dot')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /Custom/ }));
    expect(screen.getByRole('region', { name: 'Custom cut timeline' })).toBeVisible();
    expect(document.querySelector('.custom-workspace-shell')).not.toBeNull();
    expect(document.querySelector('.custom-workspace')).not.toBeNull();
    const monitor = document.querySelector('.custom-monitor video') as HTMLVideoElement;
    expect(monitor.controls).toBe(false);
    Object.defineProperty(monitor, 'paused', { configurable: true, value: true });
    fireEvent.click(monitor);
    expect(play).toHaveBeenCalledTimes(1);
    Object.defineProperty(monitor, 'paused', { configurable: true, value: false });
    fireEvent.click(monitor);
    expect(pause).toHaveBeenCalledTimes(1);
    play.mockClear();
    pause.mockClear();
    Object.defineProperty(monitor, 'paused', { configurable: true, value: true });
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(play).toHaveBeenCalledTimes(1);
    Object.defineProperty(monitor, 'paused', { configurable: true, value: false });
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(pause).toHaveBeenCalledTimes(1);

    const viewport = document.querySelector('.timeline-viewport') as HTMLDivElement;
    const track = document.querySelector('.timeline-track') as HTMLDivElement;
    expect(track).not.toBeNull();
    const trackWindow = document.querySelector('.timeline-track-window') as HTMLDivElement;
    expect(trackWindow).not.toBeNull();
    expect(document.querySelector('.custom-rally-table thead')).toBeNull();
    expect(document.querySelector('.timeline-toolbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add rally' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Delete rally' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Add rally' }));
    expect(screen.getByRole('button', { name: 'Add rally' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.contextMenu(document.querySelector('.custom-workspace')!);
    expect(screen.getByRole('button', { name: 'Add rally' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByText(/^\d{2}:\d{2}\.\d$/)).toHaveLength(4);
    expect(screen.getAllByText(/^\d+\.\ds$/)).toHaveLength(2);
    const zoomBefore = Number(viewport.dataset.zoom);
    fireEvent.wheel(trackWindow, { ctrlKey: true, deltaY: -120, clientX: 0.5 });
    expect(Number(viewport.dataset.zoom)).toBeGreaterThan(zoomBefore);
    fireEvent.wheel(trackWindow, { ctrlKey: true, deltaY: 120, clientX: 0.5 });
    expect(Number(viewport.dataset.zoom)).toBeCloseTo(zoomBefore, 5);
    viewport.scrollLeft = 0.25;
    fireEvent.scroll(viewport);
    expect(track.style.transform).toBe('translateX(0px)');
    viewport.scrollLeft = 0;
    fireEvent.scroll(viewport);
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
    const shortClip = document.querySelector('.timeline-clip') as HTMLDivElement;
    expect(shortClip.style.width).toBe('1px');
    expect(shortClip.querySelectorAll('.clip-boundary-marker')).toHaveLength(0);
    const shortStartHandle = screen.getByRole('slider', { name: 'Resize clip start 1' });
    const shortEndHandle = screen.getByRole('slider', { name: 'Resize clip end 1' });
    const clipWidth = Number.parseFloat(shortClip.style.width);
    const startRight = Number.parseFloat(shortStartHandle.style.left) + Number.parseFloat(shortStartHandle.style.width);
    const endLeft = clipWidth - Number.parseFloat(shortEndHandle.style.right) - Number.parseFloat(shortEndHandle.style.width);
    expect(startRight).toBeCloseTo(endLeft, 5);
    Object.defineProperty(shortStartHandle, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(shortEndHandle, 'setPointerCapture', { configurable: true, value: vi.fn() });
    fireEvent.pointerDown(shortStartHandle, { pointerId: 81, clientX: 0 });
    expect(document.querySelector('.resize-feedback')).toHaveAttribute('data-edge', 'start');
    fireEvent.pointerUp(shortStartHandle, { pointerId: 81, clientX: 0 });
    fireEvent.pointerDown(shortEndHandle, { pointerId: 82, clientX: 1 });
    expect(document.querySelector('.resize-feedback')).toHaveAttribute('data-edge', 'end');
    fireEvent.pointerUp(shortEndHandle, { pointerId: 82, clientX: 1 });
    const rallyCheckboxes = screen.getAllByRole('checkbox', { name: /Rally/ });
    expect(rallyCheckboxes).toHaveLength(2);
    expect(rallyCheckboxes.every((input) => (input as HTMLInputElement).checked)).toBe(true);
    expect(rallyCheckboxes.every((input) => input.closest('label')?.classList.contains('rally-checkbox'))).toBe(true);
    expect(rallyCheckboxes.every((input) => input.closest('label')?.querySelector('.export-checkbox-gloss') === null)).toBe(true);

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

    const startCutting = screen.getByRole('button', { name: 'Start cutting' });
    fireEvent.pointerEnter(startCutting);
    const exportLauncher = startCutting.closest('.floating-launcher');
    if (!exportLauncher) throw new Error('Missing export launcher.');
    const rallyVideos = screen.getByRole('checkbox', { name: 'Export rally videos' });
    const premiereXml = screen.getByRole('checkbox', { name: 'Export XML' });
    fireEvent.click(rallyVideos);
    expect(exportLauncher).toHaveClass('is-open');
    fireEvent.click(rallyVideos);
    fireEvent.blur(rallyVideos, { relatedTarget: null });
    expect(exportLauncher).toHaveClass('is-open');
    fireEvent.click(rallyVideos);
    fireEvent.click(premiereXml);
    expect(rallyVideos.closest('label')).toHaveClass('export-checkbox');
    expect(premiereXml.closest('label')).toHaveClass('export-checkbox');
    expect(rallyVideos.closest('label')?.querySelector('svg')).toBeNull();
    expect(premiereXml.closest('label')?.querySelector('svg')).toBeNull();
    fireEvent.click(startCutting);
    await waitFor(() => expect(window.ttcut.startExport).toHaveBeenCalledWith(expect.objectContaining({
      selection: {
        mode: 'custom',
        segments: [{ clip_id: 'rally_001', source: 'detected', rally_id: 'rally_001', display_index: 1, start_time_seconds: 0, end_time_seconds: draggedEnd }],
      },
      outputs: { combined_video: false, rally_videos: true, premiere_xml: true },
    })));
    act(() => taskListener?.({
      type: 'error', taskId: 'export-task-1', code: 'EXPORT_CANCELLED', message: 'EXPORT_CANCELLED',
    }));
    expect(await screen.findByRole('region', { name: 'Custom cut timeline' })).toBeVisible();
    expect(Number(screen.getByRole('slider', { name: 'Resize clip end 1' }).getAttribute('aria-valuenow'))).toBe(draggedEnd);
    expect(screen.getByRole('checkbox', { name: 'Export rally videos' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Export XML' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Choose a cutting mode' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Custom/ }));
    expect(Number(screen.getByRole('slider', { name: 'Resize clip end 1' }).getAttribute('aria-valuenow'))).toBe(defaultEnd);
    expect(screen.getAllByRole('checkbox', { name: /Rally/ }).every((input) => (input as HTMLInputElement).checked)).toBe(true);
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

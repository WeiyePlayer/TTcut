import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { SUPPORT_PROMPT_SNOOZE_MS, SUPPORT_PROMPT_SNOOZE_STORAGE_KEY } from '../src/domain/support-prompt';
import type { AppEvent, BootstrapData, SelectedVideo, TTcutApi } from '../src/shared/api';
import type { VideoMetadata } from '../src/shared/contracts';

const bootstrap: BootstrapData = {
  version: '1.1.0',
  settings: {
    language: 'zh-CN',
    calibration_method: 'automatic',
    ball_model_profile: 'tracknet_v1',
    export_strategy: 'compatible',
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
    dual_ball_models: {
      available: false,
      version: null,
      path: 'C:\\models\\dual-ball-models\\1.0.0',
      detail: 'DUAL_BALL_MODELS_MISSING',
    },
  },
  componentSetup: {
    analysis_offer: null,
    media_offer: null,
    dual_ball_models_offer: null,
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
      selectVideos,
      probeVideo: vi.fn((path: string) => Promise.resolve(metadata(path))),
      startAutoCalibration: vi.fn().mockResolvedValue('calibration-task-1'),
      saveSettings: vi.fn((settings) => Promise.resolve(settings)),
      installDualBallModels: vi.fn().mockResolvedValue('dual-setup-task'),
    } as unknown as TTcutApi;
    Object.defineProperty(window, 'ttcut', { configurable: true, value: api });
  });

  afterEach(() => {
    bootstrap.settings.language = 'zh-CN';
    bootstrap.settings.ball_model_profile = 'tracknet_v1';
    bootstrap.components.dual_ball_models = {
      available: false, version: null, path: 'C:\\models\\dual-ball-models\\1.0.0', detail: 'DUAL_BALL_MODELS_MISSING',
    };
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

    expect(screen.getByRole('button', { name: '默认模型速度快，精准度一般。' })).toBeVisible();
    expect(screen.getByRole('button', { name: '新模型速度慢，准确度很高。' })).toBeVisible();
    expect(screen.queryByText('单视频和多任务统一使用所选档位。板数仍表示落台反弹数。')).toBeNull();
  });

  it('persists the dual profile only after both downloaded models are installed', async () => {
    bootstrap.settings.language = 'en';
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: /New model/ }));
    expect(window.ttcut.installDualBallModels).toHaveBeenCalledWith(true);
    expect(window.ttcut.saveSettings).not.toHaveBeenCalled();

    act(() => taskListener?.({
      type: 'component-result', taskId: 'dual-setup-task', imported: ['dual_ball_models'], pendingImports: [],
      data: {
        ...bootstrap.components,
        dual_ball_models: { available: true, version: '1.0.0', path: 'C:\\models\\dual-ball-models\\1.0.0', detail: null },
      },
    }));

    await waitFor(() => expect(window.ttcut.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      ball_model_profile: 'uplifting_dual_v1',
    })));
  });

  it('keeps TrackNet selected when first-use dual model setup is cancelled', async () => {
    bootstrap.settings.language = 'en';
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: /New model/ }));
    act(() => taskListener?.({
      type: 'error', taskId: 'dual-setup-task', code: 'SETUP_CANCELLED', message: 'SETUP_CANCELLED',
    }));
    expect(window.ttcut.saveSettings).not.toHaveBeenCalled();
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
      },
    }));

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
});

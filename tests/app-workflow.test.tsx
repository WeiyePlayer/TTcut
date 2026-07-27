import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import type { AppEvent, BootstrapData, SelectedVideo, TTcutApi } from '../src/shared/api';
import type { VideoMetadata } from '../src/shared/contracts';

const bootstrap: BootstrapData = {
  version: '1.1.0-beta',
  settings: {
    language: 'zh-CN',
    calibration_method: 'automatic',
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

describe('App workflow notices and multi-task entry', () => {
  let taskListener: ((event: AppEvent) => void) | null;
  let selectVideos: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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
      selectVideos,
      probeVideo: vi.fn((path: string) => Promise.resolve(metadata(path))),
    } as unknown as TTcutApi;
    Object.defineProperty(window, 'ttcut', { configurable: true, value: api });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

    fireEvent.click(screen.getByRole('button', { name: /选择 MP4 视频/ }));

    await screen.findByRole('heading', { name: '多任务剪辑' });
    await waitFor(() => expect(screen.getByText('first.mp4')).toBeVisible());
    expect(confirm).not.toHaveBeenCalled();
  });
});

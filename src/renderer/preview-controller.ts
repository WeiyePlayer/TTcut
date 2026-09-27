export type PreviewController = {
  native?: boolean;
  status: 'ready' | 'preparing' | 'failed';
  error: string | null;
  url: string;
  seekTo(time: number, playing?: boolean, exact?: boolean): void;
  togglePlayback(): void;
  getPlaybackIntent(): { time: number; playing: boolean; pending: boolean; seeking?: boolean };
  retry(): void;
};

export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'mov'] as const;

export type SupportedVideoContainer = (typeof SUPPORTED_VIDEO_EXTENSIONS)[number];

export type Rectangle = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FittedVideoRectangle = Rectangle & {
  scale: number;
};

export function videoContainerFromFileName(fileName: string): SupportedVideoContainer | null {
  const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase();
  return SUPPORTED_VIDEO_EXTENSIONS.find((candidate) => candidate === extension) ?? null;
}

export function isSupportedVideoFileName(fileName: string): boolean {
  return videoContainerFromFileName(fileName) !== null;
}

export function normalizedVideoRotation(rotation: number | null | undefined): number {
  if (!Number.isFinite(rotation)) return 0;
  const normalized = ((rotation! % 360) + 360) % 360;
  return Math.abs(normalized) < 0.001 || Math.abs(normalized - 360) < 0.001 ? 0 : normalized;
}

export function displayVideoDimensions(
  width: number,
  height: number,
  rotation: number | null | undefined,
): { width: number; height: number } {
  const normalized = normalizedVideoRotation(rotation);
  const quarterTurn = Math.abs(normalized - 90) < 0.001 || Math.abs(normalized - 270) < 0.001;
  return quarterTurn ? { width: height, height: width } : { width, height };
}

export function fittedVideoRectangle(
  container: Rectangle,
  videoWidth: number,
  videoHeight: number,
): FittedVideoRectangle {
  const scale = Math.min(container.width / videoWidth, container.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: container.left + (container.width - width) / 2,
    top: container.top + (container.height - height) / 2,
    width,
    height,
    scale,
  };
}

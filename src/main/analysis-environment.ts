export const OPENCV_FFMPEG_READ_ATTEMPTS = '65536';

export function analysisProcessEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    // GoPro MP4 files can place tens of thousands of telemetry/timecode
    // packets between video packets. OpenCV's default budget is only 4,096.
    OPENCV_FFMPEG_READ_ATTEMPTS,
  };
}

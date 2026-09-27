import { scoreboardDimensions, scoreboardName } from '../domain/scoreboard';
import type { ScoreboardPosition, ScoreboardScore } from '../shared/contracts';

export function renderScoreboardImage(
  videoWidth: number,
  videoHeight: number,
  scoreboard: ScoreboardPosition,
  score: ScoreboardScore,
): string {
  const { width, height } = scoreboardDimensions(videoWidth, videoHeight, scoreboard.scale ?? 1);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('INVALID_SCOREBOARD');

  context.fillStyle = 'rgba(10, 17, 29, 0.82)';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  context.lineWidth = Math.max(1, height * 0.015);
  context.strokeRect(context.lineWidth / 2, context.lineWidth / 2, width - context.lineWidth, height - context.lineWidth);
  context.fillStyle = '#fff';
  context.textBaseline = 'middle';
  const padding = width * 0.055;
  for (const [index, name, value] of [
    [0, scoreboardName(scoreboard.left_name, 'A'), score.left],
    [1, scoreboardName(scoreboard.right_name, 'B'), score.right],
  ] as const) {
    const y = height * (index === 0 ? 0.25 : 0.75);
    let fontSize = height * 0.36;
    context.font = `800 ${fontSize}px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif`;
    const digits = String(value);
    const scoreWidth = context.measureText(digits).width;
    const labelWidth = Math.max(1, width - 3 * padding - scoreWidth);
    while (fontSize > 6 && context.measureText(name).width > labelWidth) {
      fontSize -= 1;
      context.font = `800 ${fontSize}px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif`;
    }
    context.fillText(name, padding, y, labelWidth);
    context.font = `800 ${height * 0.36}px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif`;
    context.textAlign = 'right';
    context.fillText(digits, width - padding, y);
    context.textAlign = 'left';
  }
  return canvas.toDataURL('image/png');
}

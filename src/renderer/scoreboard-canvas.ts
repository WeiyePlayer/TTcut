import { SCOREBOARD_NAME_FRACTION, SCOREBOARD_COLUMN_FRACTION, scoreboardDimensions, scoreboardName } from '../domain/scoreboard';
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

  context.fillStyle = '#292929';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#3a83f7';
  context.fillRect(width * SCOREBOARD_NAME_FRACTION, 0, width * SCOREBOARD_COLUMN_FRACTION, height);
  context.fillStyle = '#333333';
  context.fillRect(width * .88, 0, width * SCOREBOARD_COLUMN_FRACTION, height);
  context.fillStyle = '#777777';
  context.fillRect(0, height / 2, width, 1);
  context.fillStyle = '#fff';
  context.textBaseline = 'middle';
  const padding = width * 0.03;
  for (const [index, name, games, value] of [
    [0, scoreboardName(scoreboard.left_name, 'A'), score.left_games ?? 0, score.left],
    [1, scoreboardName(scoreboard.right_name, 'B'), score.right_games ?? 0, score.right],
  ] as const) {
    const y = height * (index === 0 ? 0.25 : 0.75);
    let fontSize = height * 0.32;
    context.font = `800 ${fontSize}px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif`;
    const labelWidth = width * SCOREBOARD_NAME_FRACTION - 2 * padding;
    while (fontSize > 6 && context.measureText(name).width > labelWidth) {
      fontSize -= 1;
      context.font = `800 ${fontSize}px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif`;
    }
    context.fillText(name, padding, y, labelWidth);
    context.font = `800 ${height * 0.32}px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif`;
    context.textAlign = 'center';
    context.fillText(String(games), width * .82, y, width * .11);
    context.fillText(String(value), width * .94, y, width * .11);
    context.textAlign = 'left';
  }
  return canvas.toDataURL('image/png');
}

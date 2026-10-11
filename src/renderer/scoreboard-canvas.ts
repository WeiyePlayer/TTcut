import { SCOREBOARD_NAME_FRACTION, SCOREBOARD_COLUMN_FRACTION, SCOREBOARD_RED_BLUE_CARD_FRACTION, SCOREBOARD_RED_BLUE_HEADER_FRACTION, SCOREBOARD_RED_BLUE_DIVIDER_FRACTION, scoreboardDimensions, scoreboardGamesColor, scoreboardName } from '../domain/scoreboard';
import type { ScoreboardPosition, ScoreboardScore } from '../shared/contracts';

export function renderScoreboardImage(
  videoWidth: number,
  videoHeight: number,
  scoreboard: ScoreboardPosition,
  score: ScoreboardScore,
): string {
  const { width, height } = scoreboardDimensions(videoWidth, videoHeight, scoreboard.scale ?? 1, scoreboard.style);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('INVALID_SCOREBOARD');

  if (scoreboard.style === 'red-blue') {
    renderRedBlue(context, width, height, scoreboard, score);
    return canvas.toDataURL('image/png');
  }

  context.fillStyle = '#292929';
  context.fillRect(0, 0, width, height);
  context.fillStyle = scoreboardGamesColor(scoreboard.style);
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

function renderRedBlue(context: CanvasRenderingContext2D, width: number, height: number, scoreboard: ScoreboardPosition, score: ScoreboardScore): void {
  const cardWidth = width * SCOREBOARD_RED_BLUE_CARD_FRACTION;
  const headerHeight = height * SCOREBOARD_RED_BLUE_HEADER_FRACTION;
  const dividerHeight = height * SCOREBOARD_RED_BLUE_DIVIDER_FRACTION;
  context.textBaseline = 'middle';
  const text = (value: string, x: number, y: number, size: number, maximumWidth: number, align: CanvasTextAlign = 'center') => {
    context.textAlign = align;
    context.fillStyle = '#fff';
    context.font = `800 ${size}px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif`;
    while (size > 1 && context.measureText(value).width > maximumWidth) {
      size -= 1;
      context.font = `800 ${size}px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif`;
    }
    context.fillText(value, x, y, maximumWidth);
  };
  for (const [index, name, games, points, topColor, bottomColor] of [
    [0, scoreboardName(scoreboard.left_name, 'A'), score.left_games ?? 0, score.left, '#f00000', '#a90000'],
    [1, scoreboardName(scoreboard.right_name, 'B'), score.right_games ?? 0, score.right, '#007df7', '#0057b3'],
  ] as const) {
    const x = index === 0 ? 0 : width - cardWidth;
    context.save();
    context.beginPath();
    context.roundRect(x, 0, cardWidth, height, height * .06);
    context.clip();
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0.25, topColor);
    gradient.addColorStop(1, bottomColor);
    context.fillStyle = gradient;
    context.fillRect(x, 0, cardWidth, height);
    context.fillStyle = 'rgba(0,0,0,.28)';
    context.fillRect(x, 0, cardWidth, headerHeight);
    context.fillStyle = '#292929';
    context.fillRect(x, headerHeight, cardWidth, dividerHeight);
    text(String(games), x + cardWidth / 2, headerHeight / 2, height * .165, cardWidth * .88);
    text(String(points), x + cardWidth / 2, height * .5235, height * .528, cardWidth * .88);
    text(name, x + cardWidth * .07, height * .915, height * .10018, cardWidth * .86, 'left');
    context.restore();
  }
  const dotSize = height * .054;
  context.fillStyle = '#9a9a9a';
  for (const centerY of [.485, .61]) context.fillRect((width - dotSize) / 2, height * centerY - dotSize / 2, dotSize, dotSize);
}

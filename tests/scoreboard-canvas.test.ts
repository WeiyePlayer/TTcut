import { afterEach, expect, it, vi } from 'vitest';
import { renderScoreboardImage } from '../src/renderer/scoreboard-canvas';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['classic', '#3a83f7'], ['classic-orange', '#f59e0b'], ['classic-green', '#22c55e'],
] as const)('renders %s with the same names, scores and geometry, changing only the games background', (style, gamesColor) => {
  const fillText = vi.fn();
  const fills: unknown[][] = [];
  let fillStyle = '';
  const fonts: string[] = [];
  let font = '';
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: (...args: unknown[]) => fills.push([fillStyle, ...args]), strokeRect: vi.fn(), fillText: (...args: unknown[]) => {
      fonts.push(font);
      fillText(...args);
    },
    measureText: (value: string) => ({ width: Array.from(value).length * 10 }),
    set font(value: string) { font = value; }, set fillStyle(value: string) { fillStyle = value; }, set strokeStyle(_value: string) {},
    set lineWidth(_value: number) {}, set textBaseline(_value: string) {}, set textAlign(_value: string) {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) {
    expect(this.width).toBe(538);
    expect(this.height).toBe(103);
    return 'data:image/png;base64,AA==';
  });
  const result = renderScoreboardImage(1280, 720, {
    x: 0.6, y: 0.08, scale: 1.5, style, left_name: '林昀儒', right_name: '张本智和',
  }, { left: 11, right: 9, left_games: 2, right_games: 1 });
  expect(result).toBe('data:image/png;base64,AA==');
  expect(fillText.mock.calls.map(([text]) => text)).toEqual(['林昀儒', '2', '11', '张本智和', '1', '9']);
  expect(fonts).toHaveLength(6);
  expect(fonts.every((value) => value.includes('"Noto Sans SC Variable"'))).toBe(true);
  expect(fills).toEqual([
    ['#292929', 0, 0, 538, 103],
    [gamesColor, 538 * .76, 0, 538 * .12, 103],
    ['#333333', 538 * .88, 0, 538 * .12, 103],
    ['#777777', 0, 103 / 2, 538, 1],
  ]);
  expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledOnce();
});

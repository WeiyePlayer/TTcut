import { afterEach, expect, it, vi } from 'vitest';
import { renderScoreboardImage } from '../src/renderer/scoreboard-canvas';

afterEach(() => vi.restoreAllMocks());

it('renders custom Unicode names and scores at the scaled export size', () => {
  const fillText = vi.fn();
  const fonts: string[] = [];
  let font = '';
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(), strokeRect: vi.fn(), fillText: (...args: unknown[]) => {
      fonts.push(font);
      fillText(...args);
    },
    measureText: (value: string) => ({ width: Array.from(value).length * 10 }),
    set font(value: string) { font = value; }, set fillStyle(_value: string) {}, set strokeStyle(_value: string) {},
    set lineWidth(_value: number) {}, set textBaseline(_value: string) {}, set textAlign(_value: string) {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) {
    expect(this.width).toBe(365);
    expect(this.height).toBe(140);
    return 'data:image/png;base64,AA==';
  });
  const result = renderScoreboardImage(1280, 720, {
    x: 0.6, y: 0.08, scale: 1.5, left_name: '林昀儒', right_name: '张本智和',
  }, { left: 11, right: 9 });
  expect(result).toBe('data:image/png;base64,AA==');
  expect(fillText.mock.calls.map(([text]) => text)).toEqual(['林昀儒', '11', '张本智和', '9']);
  expect(fonts).toHaveLength(4);
  expect(fonts.every((value) => value.includes('"Noto Sans SC Variable"'))).toBe(true);
  expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledOnce();
});

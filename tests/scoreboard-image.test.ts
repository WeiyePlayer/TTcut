import { inflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { createScoreboardPng } from '../src/main/scoreboard-image';

function pixels(png: Buffer, width: number, height: number): Buffer {
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const result = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 4 + 1);
    expect(raw[offset]).toBe(0);
    raw.copy(result, y * width * 4, offset + 1, offset + 1 + width * 4);
  }
  return result;
}

it.each([
  ['classic-orange', [245, 158, 11, 255]], ['classic-green', [34, 197, 94, 255]],
] as const)('changes only the colored column of the %s fallback image', (style, color) => {
  const width = 538, height = 103;
  const score = { left: 11, right: 9, left_games: 2, right_games: 1 };
  const classic = pixels(createScoreboardPng(width, height, score), width, height);
  const variant = pixels(createScoreboardPng(width, height, score, style), width, height);
  let changed = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const before = classic.subarray(offset, offset + 4);
      const after = variant.subarray(offset, offset + 4);
      if (!before.equals(after)) {
        expect(x).toBeGreaterThanOrEqual(Math.round(width * .76));
        expect(x).toBeLessThan(Math.round(width * .88));
        expect(Array.from(before)).toEqual([58, 131, 247, 255]);
        expect(Array.from(after)).toEqual(color);
        changed += 1;
      }
    }
  }
  expect(changed).toBeGreaterThan(width * height * .1);
});

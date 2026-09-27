import { deflateSync } from 'node:zlib';
import type { ScoreboardScore } from '../shared/contracts';
export { scoreboardDimensions, scoreboardDisplayDimensions } from '../domain/scoreboard';

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function chunk(name: string, data: Buffer): Buffer {
  const kind = Buffer.from(name, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  kind.copy(result, 4);
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (const value of result.subarray(4, 8 + data.length)) crc = CRC_TABLE[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return result;
}

export function createScoreboardPng(width: number, height: number, score: ScoreboardScore): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || !Number.isInteger(score.left) || !Number.isInteger(score.right)
    || score.left < 0 || score.left > 999 || score.right < 0 || score.right > 999) {
    throw new Error('INVALID_SCOREBOARD');
  }
  const pixels = Buffer.alloc(width * height * 4);
  const fill = (x: number, y: number, rectWidth: number, rectHeight: number, color: readonly [number, number, number, number]) => {
    for (let row = Math.max(0, y); row < Math.min(height, y + rectHeight); row += 1) {
      for (let column = Math.max(0, x); column < Math.min(width, x + rectWidth); column += 1) {
        const offset = (row * width + column) * 4;
        pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = color[3];
      }
    }
  };
  fill(0, 0, width, height, [10, 17, 29, 210]);
  const border = Math.max(1, Math.round(height * 0.02));
  fill(0, 0, width, border, [210, 219, 229, 230]);
  fill(0, height - border, width, border, [210, 219, 229, 230]);
  fill(0, 0, border, height, [210, 219, 229, 230]);
  fill(width - border, 0, border, height, [210, 219, 229, 230]);
  fill(border, Math.floor(height / 2), width - 2 * border, Math.max(1, Math.round(height * 0.01)), [70, 83, 101, 225]);
  const unit = Math.max(1, Math.floor(height / 18));
  const glyph = (letter: string, x: number, y: number) => {
    GLYPHS[letter]?.forEach((line, row) => {
      for (let column = 0; column < line.length; column += 1) {
        if (line[column] === '1') fill(x + column * unit, y + row * unit, unit, unit, [255, 255, 255, 255]);
      }
    });
  };
  for (const [row, label, value] of [[0, 'A', score.left], [1, 'B', score.right]] as const) {
    const rowHeight = height / 2;
    const y = Math.round(row * rowHeight + (rowHeight - 7 * unit) / 2);
    glyph(label, Math.round(width * 0.09), y);
    const digits = String(value);
    const digitWidth = (digits.length * 6 - 1) * unit;
    const startX = width - Math.round(width * 0.09) - digitWidth;
    for (let index = 0; index < digits.length; index += 1) glyph(digits[index]!, startX + index * 6 * unit, y);
  }
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) pixels.copy(raw, row * (width * 4 + 1) + 1, row * width * 4, (row + 1) * width * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

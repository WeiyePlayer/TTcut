import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readmePaths = ['README.md', 'README.en.md'];
const internalImplementationNames = [
  /BlurBall/iu,
  /TrackNet/iu,
  /UpliftingTableTennis/iu,
  /OpenH264/iu,
  /\bx264\b/iu,
  /\blibx264\b/iu,
  /FFmpeg/iu,
  /ffprobe/iu,
  /PyTorch/iu,
  /NumPy/iu,
  /OpenCV/iu,
  /Electron/iu,
  /\bForge\b/iu,
  /\bVite\b/iu,
  /\bFuses?\b/iu,
  /\bNSIS\b/iu,
  /BtbN/iu,
  /SegFormer/iu,
  /\bWASB\b/iu,
];

describe('public README content', () => {
  it.each(readmePaths)('%s does not expose internal component names', async (readmePath) => {
    const content = await readFile(path.resolve(process.cwd(), readmePath), 'utf8');

    for (const componentName of internalImplementationNames) {
      expect(content).not.toMatch(componentName);
    }
  });
});

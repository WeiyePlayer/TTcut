// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ dialog: {} }));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn().mockResolvedValue(undefined) }));
import { runFfmpeg } from '../src/main/export';
import { beginTrackedTask, endTrackedTask } from '../src/main/processes';

afterEach(() => endTrackedTask('tone-map-capability'));
it('reports a missing tone-map filter as an actionable capability failure', async () => {
  beginTrackedTask('tone-map-capability');
  const args = ['-e', 'console.error("No such filter: \'tonemap\'"); process.exit(1)', '--', '-filter_complex', 'tonemap=tonemap=hable'];
  await expect(runFfmpeg({ isDestroyed: () => true } as never, 'tone-map-capability', process.execPath, args, 1, 'cutting'))
    .rejects.toMatchObject({ exportCode: 'HDR_TONEMAP_UNAVAILABLE' });
});

it.each(['PPS id out of range', 'SPS 2 does not exist', 'VPS 3 does not exist', 'non-existing PPS 0 referenced'])(
  'classifies a sought HDR decoder missing-parameter diagnostic: %s', async (message) => {
    beginTrackedTask('tone-map-capability');
    const script = `process.stderr.write(${JSON.stringify(message)}); process.exit(1)`;
    const args = ['-e', script, '--', '-filter_complex', 'tonemap=tonemap=hable'];
    await expect(runFfmpeg({ isDestroyed: () => true } as never, 'tone-map-capability', process.execPath, args, 1, 'cutting', { seekStart: 12 }))
      .rejects.toMatchObject({ exportCode: 'EXPORT_SEEK_DECODE_FAILED' });
  });

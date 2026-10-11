import { describe, expect, it, vi } from 'vitest';
import { createCustomGuidePreference, CUSTOM_GUIDE_STORAGE_KEY } from '../src/renderer/custom-guide-preference';

describe('custom guide preference', () => {
  it('records dismissal for subsequent editing sessions in the same profile', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = createCustomGuidePreference(() => storage);
    expect(first.hasSeen()).toBe(false);
    first.markSeen();
    expect(values.get(CUSTOM_GUIDE_STORAGE_KEY)).toBe('1');
    expect(createCustomGuidePreference(() => storage).hasSeen()).toBe(true);
    expect(createCustomGuidePreference(() => ({ ...storage, getItem: () => null })).hasSeen()).toBe(false);
  });

  it('allows reading and closing without persistent storage and suppresses repeats in this run', () => {
    const preference = createCustomGuidePreference(() => { throw new Error('storage blocked'); });
    expect(preference.hasSeen()).toBe(false);
    expect(() => preference.markSeen()).not.toThrow();
    expect(preference.hasSeen()).toBe(true);
  });

  it('keeps session dismissal when a write fails but reads still work', () => {
    const preference = createCustomGuidePreference(() => ({ getItem: () => null, setItem: vi.fn(() => { throw new Error('disk full'); }) }));
    preference.markSeen();
    expect(preference.hasSeen()).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  isSupportPromptSuppressed,
  SUPPORT_PROMPT_SNOOZE_MS,
  SUPPORT_PROMPT_SNOOZE_STORAGE_KEY,
  suppressSupportPromptForThirtyDays,
} from '../src/domain/support-prompt';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('support prompt suppression', () => {
  it('suppresses the prompt for exactly thirty days', () => {
    const storage = memoryStorage();
    const now = 1_800_000_000_000;

    expect(suppressSupportPromptForThirtyDays(now, storage)).toBe(now + SUPPORT_PROMPT_SNOOZE_MS);
    expect(storage.values.get(SUPPORT_PROMPT_SNOOZE_STORAGE_KEY)).toBe(String(now + SUPPORT_PROMPT_SNOOZE_MS));
    expect(isSupportPromptSuppressed(now + SUPPORT_PROMPT_SNOOZE_MS - 1, storage)).toBe(true);
    expect(isSupportPromptSuppressed(now + SUPPORT_PROMPT_SNOOZE_MS, storage)).toBe(false);
    expect(storage.values.has(SUPPORT_PROMPT_SNOOZE_STORAGE_KEY)).toBe(false);
  });

  it('falls back to showing the prompt when persistent storage is unavailable', () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error('storage unavailable'); }),
      setItem: vi.fn(() => { throw new Error('storage unavailable'); }),
      removeItem: vi.fn(),
    };

    expect(isSupportPromptSuppressed(0, storage)).toBe(false);
    expect(() => suppressSupportPromptForThirtyDays(0, storage)).not.toThrow();
  });
});

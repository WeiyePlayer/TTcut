export const SUPPORT_PROMPT_SNOOZE_STORAGE_KEY = 'ttcut.supportPrompt.snoozedUntil';
export const SUPPORT_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1_000;

type SupportPromptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): SupportPromptStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isSupportPromptSuppressed(
  nowMs = Date.now(),
  storage: SupportPromptStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    const rawValue = storage.getItem(SUPPORT_PROMPT_SNOOZE_STORAGE_KEY);
    if (!rawValue) return false;
    const snoozedUntil = Number(rawValue);
    if (Number.isFinite(snoozedUntil) && snoozedUntil > nowMs) return true;
    storage.removeItem(SUPPORT_PROMPT_SNOOZE_STORAGE_KEY);
  } catch {
    return false;
  }
  return false;
}

export function suppressSupportPromptForThirtyDays(
  nowMs = Date.now(),
  storage: SupportPromptStorage | null = browserStorage(),
): number {
  const snoozedUntil = nowMs + SUPPORT_PROMPT_SNOOZE_MS;
  try {
    storage?.setItem(SUPPORT_PROMPT_SNOOZE_STORAGE_KEY, String(snoozedUntil));
  } catch {
    // Storage failures should not prevent dismissing the current prompt.
  }
  return snoozedUntil;
}

export const CUSTOM_GUIDE_STORAGE_KEY = 'ttcut.customEditingGuide.seen.v1';

type GuideStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function createCustomGuidePreference(storage: () => GuideStorage = () => window.localStorage) {
  let dismissedInSession = false;
  return {
    hasSeen(): boolean {
      if (dismissedInSession) return true;
      try { return storage().getItem(CUSTOM_GUIDE_STORAGE_KEY) === '1'; }
      catch { return false; }
    },
    markSeen(): void {
      dismissedInSession = true;
      try { storage().setItem(CUSTOM_GUIDE_STORAGE_KEY, '1'); }
      catch { /* Reading the guide must remain possible without storage. */ }
    },
  };
}

export const customGuidePreference = createCustomGuidePreference();

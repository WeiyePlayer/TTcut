import { describe, expect, it } from 'vitest';
import { distributionIdentity } from '../src/main/distribution';

describe('distribution identity', () => {
  it('keeps an independent Beta away from stable data and updates', () => {
    expect(distributionIdentity(true)).toEqual({
      independentBeta: true,
      productName: 'TTcut Beta',
      appId: 'com.weiye.ttcut.beta',
      userDataDirectoryName: 'TTcut-Beta',
      automaticUpdates: false,
    });
  });

  it('does not change the stable distribution defaults', () => {
    expect(distributionIdentity(false)).toEqual({
      independentBeta: false,
      productName: 'TTcut',
      appId: 'com.weiye.ttcut',
      userDataDirectoryName: 'TTcut',
      automaticUpdates: true,
    });
  });
});

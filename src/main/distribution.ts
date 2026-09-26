export const INDEPENDENT_BETA = typeof __TTCUT_INDEPENDENT_BETA__ !== 'undefined'
  && __TTCUT_INDEPENDENT_BETA__;

export type DistributionIdentity = {
  independentBeta: boolean;
  productName: string;
  appId: string;
  userDataDirectoryName: string;
  automaticUpdates: boolean;
};

export function distributionIdentity(independentBeta = INDEPENDENT_BETA): DistributionIdentity {
  return independentBeta
    ? {
        independentBeta: true,
        productName: 'TTcut Beta',
        appId: 'com.weiye.ttcut.beta',
        userDataDirectoryName: 'TTcut-Beta',
        automaticUpdates: false,
      }
    : {
        independentBeta: false,
        productName: 'TTcut',
        appId: 'com.weiye.ttcut',
        userDataDirectoryName: 'TTcut',
        automaticUpdates: true,
      };
}

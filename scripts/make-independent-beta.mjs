process.env.TTCUT_INDEPENDENT_BETA = '1';
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

await import('./make-nsis.mjs');

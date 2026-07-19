import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 8 * 60 * 1_000,
  expect: { timeout: 15_000 },
  outputDir: 'output/playwright/results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'output/playwright/report', open: 'never' }],
  ],
});

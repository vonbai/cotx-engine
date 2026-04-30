import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  use: {
    headless: true,
    viewport: { width: 1440, height: 960 },
  },
});

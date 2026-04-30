import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['example/**', 'node_modules/**', 'test/acceptance/**', 'packages/**', 'apps/**'],
    testTimeout: 30000,
    hookTimeout: 120000,
    pool: 'forks',
    maxWorkers: 2,
    teardownTimeout: 3000,
    // LadybugDB is native/mmap-backed; keep DB-heavy files from saturating
    // worker forks while preserving useful test parallelism.
  },
});

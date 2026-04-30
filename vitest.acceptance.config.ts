import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/acceptance/**/*.test.ts'],
    exclude: ['example/**', 'node_modules/**'],
  },
});

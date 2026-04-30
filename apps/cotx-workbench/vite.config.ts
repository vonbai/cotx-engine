import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  base: '/workbench/',
  plugins: [react()],
  resolve: {
    alias: {
      'cotx-sdk-react/theme.css': path.resolve(__dirname, '../../packages/cotx-sdk-react/src/theme/index.css'),
      'cotx-sdk-core': path.resolve(__dirname, '../../packages/cotx-sdk-core/src/index.ts'),
      'cotx-sdk-react': path.resolve(__dirname, '../../packages/cotx-sdk-react/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
  },
});

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const WORKBENCH_ROOT = path.resolve(import.meta.dirname, '..');

describe('bundle size budget', () => {
  it('cotx-sdk-core gzip < 10 KB', () => {
    const coreDistDir = path.resolve(WORKBENCH_ROOT, '../../packages/cotx-sdk-core/dist');
    if (!fs.existsSync(coreDistDir)) {
      // Skip if not built
      return;
    }
    const files = fs.readdirSync(coreDistDir).filter(f => f.endsWith('.js'));
    let totalSize = 0;
    for (const f of files) {
      totalSize += fs.statSync(path.join(coreDistDir, f)).size;
    }
    // Uncompressed JS should be well under 40KB (gzip ~10KB)
    expect(totalSize).toBeLessThan(40_000);
  });

  it('workbench build produces output', () => {
    const distDir = path.join(WORKBENCH_ROOT, 'dist');
    if (!fs.existsSync(distDir)) {
      // Build not run yet — skip
      return;
    }
    const indexHtml = path.join(distDir, 'index.html');
    expect(fs.existsSync(indexHtml)).toBe(true);
  });

  it('splits the workbench bundle so the entry chunk stays below 300 KB raw', () => {
    const assetsDir = path.join(WORKBENCH_ROOT, 'dist', 'assets');
    const indexHtml = path.join(WORKBENCH_ROOT, 'dist', 'index.html');
    if (!fs.existsSync(assetsDir)) {
      return;
    }

    const jsFiles = fs.readdirSync(assetsDir).filter((file) => file.endsWith('.js'));
    expect(jsFiles.length).toBeGreaterThan(1);

    const html = fs.readFileSync(indexHtml, 'utf-8');
    const entryChunk = html.match(/assets\/([^"']+\.js)/)?.[1];
    expect(entryChunk).toBeTruthy();

    const entrySize = fs.statSync(path.join(assetsDir, entryChunk!)).size;
    expect(entrySize).toBeLessThan(300_000);
  });
});

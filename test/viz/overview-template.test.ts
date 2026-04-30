// test/viz/overview-template.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateOverviewHtml } from '../../src/viz/overview-template.js';
import { CotxStore } from '../../src/store/store.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';

describe('Overview Template', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-overview-'));
    const store = new CotxStore(tmpDir);
    store.init('test-project');
    store.updateMeta({ compiled_at: '2026-04-09T00:00:00Z' });

    const archStore = new ArchitectureStore(tmpDir);
    archStore.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    archStore.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [
        {
          id: 'store',
          label: 'Store',
          kind: 'leaf',
          directory: 'src/store',
          files: ['store.ts'],
          stats: { file_count: 1, function_count: 5, total_cyclomatic: 10, max_cyclomatic: 3, max_nesting_depth: 1, risk_score: 10 },
        },
        {
          id: 'compiler',
          label: 'Compiler',
          kind: 'leaf',
          directory: 'src/compiler',
          files: ['compile.ts'],
          stats: { file_count: 2, function_count: 8, total_cyclomatic: 20, max_cyclomatic: 6, max_nesting_depth: 2, risk_score: 35 },
        },
      ],
      edges: [
        { from: 'compiler', to: 'store', label: 'writeModule', type: 'dependency', weight: 4 },
      ],
    });
    archStore.writeDescription('overall-architecture', 'This perspective summarizes the major architectural components and their relationships.');
    archStore.writeDescription('data-flow', 'This perspective highlights primary execution and data pathways.');
    archStore.writeMeta({
      perspectives: ['overall-architecture', 'data-flow'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    archStore.writePerspective({
      id: 'data-flow',
      label: 'Data Flow',
      components: [],
      edges: [
        { from: 'compiler', to: 'store', label: 'writeModule', type: 'data_flow', weight: 3 },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates valid HTML', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('test-project');
    expect(html).toContain('Overall Architecture');
  });

  it('includes component risk grid', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('Store');
    expect(html).toContain('risk');
  });

  it('includes perspective card with link', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('overall-architecture');
  });

  it('includes compiled_at timestamp', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('2026-04-09T00:00:00Z');
  });

  it('includes stats line', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('modules');
    expect(html).toContain('concepts');
  });

  it('includes dark theme CSS variables', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('--bg: #0d1117');
    expect(html).toContain('--accent: #58a6ff');
  });

  it('shows fallback message when no arch data', () => {
    // Create a store-only project (no architecture data)
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-noarch-'));
    try {
      const store = new CotxStore(emptyDir);
      store.init('empty-project');
      const html = generateOverviewHtml(emptyDir);
      expect(html).toContain('cotx compile');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('perspective card links to project/perspectiveId', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('test-project/overall-architecture');
  });

  it('risk grid shows component stats columns', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('Max CC');
    expect(html).toContain('Functions');
  });

  it('includes architecture analysis summary and method notes', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('Architecture Analysis');
    expect(html).toContain('How It Was Generated');
    expect(html).toContain('Confidence & Limits');
    expect(html).toContain('directory grouping');
  });

  it('includes top risks and top dependency insights', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('Top Risks');
    expect(html).toContain('Top Dependencies');
    expect(html).toContain('Top Flows');
    expect(html).toContain('Why These Components');
    expect(html).toContain('Compiler');
    expect(html).toContain('writeModule');
  });

  it('deep-links overview insights back into explorer routes', () => {
    const html = generateOverviewHtml(tmpDir);
    expect(html).toContain('href="/map/test-project/overall-architecture/compiler"');
    expect(html).toContain('href="/map/test-project/overall-architecture/store"');
    expect(html).toContain('href="/map/test-project/data-flow/compiler"');
  });
});

// test/viz/explorer-template.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateExplorerHtml } from '../../src/viz/explorer-template.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';

describe('Explorer Template', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-explorer-'));
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
          files: ['store.ts', 'schema.ts'],
          exported_functions: ['writeModule', 'readModule'],
          stats: { file_count: 2, function_count: 10, total_cyclomatic: 20, max_cyclomatic: 5, max_nesting_depth: 2, risk_score: 15 },
        },
        {
          id: 'compiler',
          label: 'Compiler',
          kind: 'leaf',
          directory: 'src/compiler',
          files: ['module-compiler.ts'],
          stats: { file_count: 1, function_count: 8, total_cyclomatic: 25, max_cyclomatic: 6, max_nesting_depth: 3, risk_score: 30 },
        },
      ],
      edges: [
        { from: 'compiler', to: 'store', label: 'writeModule', type: 'dependency', weight: 3 },
      ],
    });
    archStore.writeElement('overall-architecture', 'compiler', {
      id: 'compiler',
      label: 'Compiler',
      kind: 'group',
      directory: 'src/compiler',
      children: ['module-compiler'],
      stats: { file_count: 2, function_count: 8, total_cyclomatic: 25, max_cyclomatic: 6, max_nesting_depth: 3, risk_score: 30 },
    });
    archStore.writeElement('overall-architecture', 'compiler/module-compiler', {
      id: 'module-compiler',
      label: 'Module Compiler',
      kind: 'leaf',
      directory: 'src/compiler/module-compiler.ts',
      files: ['src/compiler/module-compiler.ts'],
      exported_functions: ['compileModules'],
      stats: { file_count: 1, function_count: 4, total_cyclomatic: 12, max_cyclomatic: 4, max_nesting_depth: 2, risk_score: 18 },
    });
    archStore.writeDiagram('overall-architecture/compiler', 'graph TD\n  parser --> store');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates valid HTML with SVG', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<svg');
    expect(html).toContain('Store');
    expect(html).toContain('Compiler');
  });

  it('includes left nav with component list', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('id="left-nav"');
    expect(html).toContain('id="nav-search"');
    expect(html).toContain('scrollbar-width:none');
    expect(html).toContain('#left-nav::-webkit-scrollbar { display:none; }');
    expect(html).toContain('Store');
    expect(html).toContain('Compiler');
  });

  it('includes sidebar with component details structure', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('sidebar');
    expect(html).toContain('sb-title');
    expect(html).toContain('sb-content');
  });

  it('includes pan/zoom JS', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('/assets/explorer.js');
  });

  it('uses external explorer client script instead of embedding interaction code', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('<script type="application/json" id="explorer-data">');
    expect(html).toContain('<script src="/assets/explorer.js"></script>');
    expect(html).not.toContain('function selectComponent');
  });

  it('includes perspective data as inline JSON', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('"overall-architecture"');
    expect(html).toContain('"compiler/module-compiler"');
  });

  it('nav items have data-id attributes', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('data-id="store"');
    expect(html).toContain('data-id="compiler"');
  });

  it('includes nested element nav items from architecture tree', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('data-id="compiler/module-compiler"');
    expect(html).toContain('Module Compiler');
  });

  it('nav items have risk-dot indicators', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('risk-dot');
    expect(html).toContain('risk-dot low');  // store: risk_score=15
    expect(html).toContain('risk-dot med');  // compiler: risk_score=30
  });

  it('focusElement marks nav item as active', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture', 'store');
    expect(html).toContain('nav-item active');
  });

  it('focusElement supports nested element paths', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture', 'compiler/module-compiler');
    expect(html).toContain('data-id="compiler/module-compiler"');
    expect(html).toContain('nav-item active');
  });

  it('includes dark theme CSS variables', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('--bg:#0d1117');
    expect(html).toContain('--accent:#58a6ff');
  });

  it('includes dot-grid background', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('radial-gradient');
    expect(html).toContain('background-size');
  });

  it('SVG is embedded inside graph-canvas div', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('id="graph-canvas"');
    expect(html).toContain('id="graph-area"');
  });

  it('perspective label appears in title and nav', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('Overall Architecture');
  });

  it('includes group diagram data and sidebar rendering branch', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('diagram-preview');
    expect(html).toContain('"diagram":"graph TD\\n  parser --> store"');
  });

  it('marks rendered edges with relationship metadata for client-side highlighting', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('class="edge"');
    expect(html).toContain('data-from="compiler"');
    expect(html).toContain('data-to="store"');
  });

  it('keeps selected edge polylines unfilled so highlights do not cover the graph', async () => {
    const html = await generateExplorerHtml(tmpDir, 'overall-architecture');
    expect(html).toContain('#graph-canvas .edge.selected polyline { stroke:#58a6ff;');
    expect(html).toContain('fill:none;');
    expect(html).toContain('#graph-canvas .edge.related polyline { stroke:#9cd1ff;');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzeComplexity } from '../../src/compiler/complexity-analyzer.js';
import type { GraphNode } from '../../src/core/export/json-exporter.js';
import type { ModuleNode } from '../../src/store/schema.js';

describe('complexity analyzer: graph/complexity.json output', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-cplx-json-'));
    // Create .cotx/graph/ directory
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'graph'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes per-function complexity to graph/complexity.json', async () => {
    const code = `
export function simple(x: number): string {
  if (x > 0) {
    return 'positive';
  }
  return 'zero';
}

export function complex(items: string[]): void {
  for (const item of items) {
    if (item.length > 0) {
      for (let i = 0; i < item.length; i++) {
        if (item[i] === 'x') {
          console.log('found');
        }
      }
    }
  }
}
`;
    fs.writeFileSync(path.join(tmpDir, 'funcs.ts'), code);

    const nodes: GraphNode[] = [
      {
        id: 'fn-simple',
        label: 'Function',
        properties: { name: 'simple', filePath: 'funcs.ts', startLine: 2, endLine: 7, isExported: true },
      },
      {
        id: 'fn-complex',
        label: 'Function',
        properties: { name: 'complex', filePath: 'funcs.ts', startLine: 9, endLine: 19, isExported: true },
      },
    ];

    const modules: ModuleNode[] = [
      {
        id: 'test-mod',
        canonical_entry: 'funcs.ts:simple',
        files: ['funcs.ts'],
        depends_on: [],
        depended_by: [],
        struct_hash: 'h1',
      },
    ];

    await analyzeComplexity(tmpDir, nodes, modules);

    const complexityFile = path.join(tmpDir, '.cotx', 'graph', 'complexity.json');
    expect(fs.existsSync(complexityFile)).toBe(true);

    const data = JSON.parse(fs.readFileSync(complexityFile, 'utf-8')) as Record<string, unknown>;
    // Should have entries keyed by filePath:functionName
    expect(Object.keys(data).length).toBeGreaterThanOrEqual(1);

    // Check structure of an entry
    const entries = Object.values(data) as Array<{ cyclomatic: number; nestingDepth: number; loc: number; filePath: string }>;
    for (const entry of entries) {
      expect(entry).toHaveProperty('cyclomatic');
      expect(entry).toHaveProperty('nestingDepth');
      expect(entry).toHaveProperty('loc');
      expect(entry).toHaveProperty('filePath');
    }
  });

  it('does not write complexity.json when graph/ directory does not exist', async () => {
    // Use a tmpDir without .cotx/graph/
    const noGraphDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-cplx-nograph-'));
    try {
      const nodes: GraphNode[] = [];
      const modules: ModuleNode[] = [];

      // Should not throw even when graph dir is missing
      await expect(analyzeComplexity(noGraphDir, nodes, modules)).resolves.toBeUndefined();

      const complexityFile = path.join(noGraphDir, '.cotx', 'graph', 'complexity.json');
      expect(fs.existsSync(complexityFile)).toBe(false);
    } finally {
      fs.rmSync(noGraphDir, { recursive: true, force: true });
    }
  });
});

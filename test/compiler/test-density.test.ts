import { describe, it, expect } from 'vitest';
import { analyzeTestDensity } from '../../src/compiler/test-density.js';
import type { GraphNode, GraphEdge } from '../../src/core/export/json-exporter.js';
import type { ModuleNode } from '../../src/store/schema.js';

describe('analyzeTestDensity', () => {
  it('computes density based on test file imports', () => {
    const nodes: GraphNode[] = [
      { id: 'fn-handle', label: 'Function', properties: { filePath: 'api/handler.ts', name: 'handle', isExported: true } },
      { id: 'fn-query', label: 'Function', properties: { filePath: 'db/store.ts', name: 'query', isExported: true } },
      { id: 'fn-test-handle', label: 'Function', properties: { filePath: 'test/api/handler.test.ts', name: 'testHandle' } },
    ];

    const edges: GraphEdge[] = [
      { sourceId: 'fn-test-handle', targetId: 'fn-handle', type: 'IMPORTS', confidence: 1 },
    ];

    const modules: ModuleNode[] = [
      { id: 'api', canonical_entry: 'handle', files: ['api/handler.ts'], depends_on: [], depended_by: [], struct_hash: 'h1' },
      { id: 'db', canonical_entry: 'query', files: ['db/store.ts'], depends_on: [], depended_by: [], struct_hash: 'h2' },
    ];

    const densities = analyzeTestDensity(nodes, edges, modules);

    expect(densities.get('api')).toBe(1.0);  // handler.ts is imported by test
    expect(densities.get('db')).toBe(0);     // store.ts has no test imports
  });

  it('returns 0 for modules with no source files', () => {
    const densities = analyzeTestDensity([], [], [
      { id: 'empty', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1' },
    ]);
    expect(densities.get('empty')).toBe(0);
  });

  it('excludes test files from module file count', () => {
    const nodes: GraphNode[] = [
      { id: 'fn-a', label: 'Function', properties: { filePath: 'lib/a.ts', name: 'a' } },
      { id: 'fn-b', label: 'Function', properties: { filePath: 'lib/b.ts', name: 'b' } },
      { id: 'fn-t', label: 'Function', properties: { filePath: 'lib/a.test.ts', name: 'testA' } },
    ];

    const edges: GraphEdge[] = [
      { sourceId: 'fn-t', targetId: 'fn-a', type: 'IMPORTS', confidence: 1 },
    ];

    const modules: ModuleNode[] = [
      { id: 'lib', canonical_entry: 'a', files: ['lib/a.ts', 'lib/b.ts', 'lib/a.test.ts'], depends_on: [], depended_by: [], struct_hash: 'h1' },
    ];

    const densities = analyzeTestDensity(nodes, edges, modules);
    // 1 of 2 non-test files tested
    expect(densities.get('lib')).toBe(0.5);
  });
});

import { describe, it, expect } from 'vitest';
import { buildChangeSummary, summarizeGraphSymbols } from '../../src/compiler/change-summary.js';
import type { GraphNode } from '../../src/core/export/json-exporter.js';

describe('change-summary', () => {
  it('detects added, removed, and changed graph symbols', () => {
    const previous: GraphNode[] = [
      { id: 'Function:a.ts:run', label: 'Function', properties: { filePath: 'a.ts', name: 'run', exported: true } },
      { id: 'Function:a.ts:old', label: 'Function', properties: { filePath: 'a.ts', name: 'old' } },
    ];
    const current: GraphNode[] = [
      { id: 'Function:a.ts:run', label: 'Function', properties: { filePath: 'a.ts', name: 'run', exported: false } },
      { id: 'Function:a.ts:new', label: 'Function', properties: { filePath: 'a.ts', name: 'new' } },
    ];

    const summary = summarizeGraphSymbols(previous, current);

    expect(summary.added).toContainEqual({
      id: 'Function:a.ts:new',
      label: 'Function',
      file: 'a.ts',
    });
    expect(summary.removed).toContainEqual({
      id: 'Function:a.ts:old',
      label: 'Function',
      file: 'a.ts',
    });
    expect(summary.changed).toContainEqual({
      id: 'Function:a.ts:run',
      label: 'Function',
      file: 'a.ts',
      reason: 'properties changed',
    });
  });

  it('builds a deterministic summary with layer and stale sections', () => {
    const summary = buildChangeSummary({
      trigger: 'update',
      changedFiles: ['src/a.ts'],
      previousGraphNodes: [],
      currentGraphNodes: [
        { id: 'Function:a.ts:new', label: 'Function', properties: { filePath: 'a.ts', name: 'new' } },
      ],
      previousModules: [],
      currentModules: [{ id: 'api', canonical_entry: 'run', files: ['a.ts'], depends_on: [], depended_by: [], struct_hash: '1' }],
      previousConcepts: [],
      currentConcepts: [],
      previousContracts: [],
      currentContracts: [],
      previousFlows: [],
      currentFlows: [],
      affectedModules: ['api'],
      staleEnrichments: [{ nodeId: 'api', layer: 'module', reason: 'struct changed' }],
      staleAnnotations: [{ nodeId: 'api', layer: 'module', annotationIndex: 0, reason: 'code changed' }],
    });

    expect(summary.changed_files).toEqual(['src/a.ts']);
    expect(summary.affected_modules).toEqual(['api']);
    expect(summary.layers.added).toContainEqual({ id: 'api', layer: 'module' });
    expect(summary.stale.enrichments[0].reason).toBe('struct changed');
    expect(summary.stale.annotations[0].reason).toBe('code changed');
  });
});

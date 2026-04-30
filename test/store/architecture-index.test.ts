// test/store/architecture-index.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ArchitectureIndex } from '../../src/store/architecture-index.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import type { PerspectiveData } from '../../src/store/schema.js';

describe('ArchitectureIndex', () => {
  let tmpDir: string;
  let archStore: ArchitectureStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-arch-idx-'));
    archStore = new ArchitectureStore(tmpDir);
    archStore.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });

    const perspective: PerspectiveData = {
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [
        {
          id: 'store',
          label: 'Store Layer',
          kind: 'leaf',
          directory: 'src/store',
          files: ['src/store/store.ts', 'src/store/schema.ts'],
          exported_functions: ['writeModule', 'readModule', 'listModules'],
          contracts_provided: ['store-contract'],
          related_flows: ['compile-flow'],
          stats: { file_count: 2, function_count: 10, total_cyclomatic: 20, max_cyclomatic: 5, max_nesting_depth: 2, risk_score: 15 },
        },
        {
          id: 'compiler',
          label: 'Compiler Pipeline',
          kind: 'group',
          directory: 'src/compiler',
          children: ['module-compiler'],
          stats: { file_count: 5, function_count: 20, total_cyclomatic: 50, max_cyclomatic: 8, max_nesting_depth: 3, risk_score: 25 },
        },
      ],
      edges: [],
    };
    archStore.writePerspective(perspective);
    archStore.writeDescription('overall-architecture', 'The main architecture of cotx-engine.');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds element by label', () => {
    const index = ArchitectureIndex.fromStore(archStore);
    const results = index.search('store layer');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toContain('store');
  });

  it('finds element by exported function name', () => {
    const index = ArchitectureIndex.fromStore(archStore);
    const results = index.search('writeModule');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toContain('store');
  });

  it('finds element by file name', () => {
    const index = ArchitectureIndex.fromStore(archStore);
    const results = index.search('schema');
    expect(results.length).toBeGreaterThan(0);
  });

  it('finds perspective by description', () => {
    const index = ArchitectureIndex.fromStore(archStore);
    const results = index.search('main architecture');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].kind).toBe('perspective');
  });

  it('returns empty for unrelated query', () => {
    const index = ArchitectureIndex.fromStore(archStore);
    const results = index.search('kubernetes deployment');
    expect(results).toHaveLength(0);
  });
});

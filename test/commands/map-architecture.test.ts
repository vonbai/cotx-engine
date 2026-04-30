import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import { generateMapSummary } from '../../src/commands/map.js';

describe('generateMapSummary architecture scope', () => {
  let tmpDir: string;
  let store: CotxStore;
  let archStore: ArchitectureStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-map-arch-'));
    store = new CotxStore(tmpDir);
    store.init('arch-test');
    archStore = new ArchitectureStore(tmpDir);
    archStore.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-10T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc123',
    });
    archStore.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [
        {
          id: 'api',
          label: 'API',
          kind: 'leaf',
          directory: 'src/api',
          files: ['src/api/index.ts'],
          stats: {
            file_count: 1,
            function_count: 3,
            total_cyclomatic: 5,
            max_cyclomatic: 3,
            max_nesting_depth: 1,
            risk_score: 12,
          },
        },
      ],
      edges: [{ from: 'api', to: 'store', label: 'read', type: 'dependency', weight: 1 }],
    });
    archStore.writeDescription('overall-architecture', 'Readable architecture overview.');
    archStore.writeDescription('overall-architecture/api', 'Handles inbound API responsibilities.');
    store.writeWorkspaceLayout({
      project_root: tmpDir,
      generated_at: '2026-04-10T00:00:00Z',
      directories: [
        { path: '.', kind: 'repo-root', depth: 0 },
        { path: 'packages/core', kind: 'package', depth: 2 },
        { path: 'pkg/octicons/icons', kind: 'asset', depth: 3 },
        { path: 'docs', kind: 'docs', depth: 1 },
      ],
      candidates: [
        { path: 'README.md', kind: 'readme', reason: 'README-like file', boundary: '.' },
        { path: 'packages/core/package.json', kind: 'manifest', reason: 'project/package manifest', boundary: '.' },
      ],
      summary: {
        directories: 3,
        candidates: 2,
        repo_boundaries: 1,
        packages: 1,
        asset_dirs: 1,
        docs_dirs: 1,
        example_dirs: 0,
        cotx_present: true,
        architecture_store_present: true,
      },
    });
    store.writeLatestChangeSummary({
      generated_at: '2026-04-10T00:00:00Z',
      trigger: 'update',
      changed_files: ['src/api/index.ts'],
      affected_modules: ['api'],
      affected_contracts: [],
      affected_flows: [],
      symbols: {
        added: [{ id: 'Function:src/api/index.ts:newThing', label: 'Function' }],
        removed: [],
        changed: [],
      },
      layers: { added: [], removed: [], changed: [] },
      stale: { enrichments: [], annotations: [] },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders architecture descriptions and recent changes', () => {
    const output = generateMapSummary(store, 'architecture', 2);
    expect(output).toContain('## Architecture: arch-test');
    expect(output).toContain('### Workspace Layout');
    expect(output).toContain('1 repo boundary/boundaries, 1 package boundary/boundaries, 1 docs directory, 1 asset directory, 2 candidate input(s).');
    expect(output).toContain('Packages: packages/core');
    expect(output).toContain('Assets: pkg/octicons/icons');
    expect(output).toContain('Readable architecture overview.');
    expect(output).toContain('API: Handles inbound API responsibilities.');
    expect(output).toContain('### Recent Changes');
    expect(output).toContain('Added symbol: [Function] Function:src/api/index.ts:newThing');
  });
});

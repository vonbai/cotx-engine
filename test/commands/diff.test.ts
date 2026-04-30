import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandSnapshot } from '../../src/commands/snapshot.js';
import { commandDiff } from '../../src/commands/diff.js';

describe('commandDiff', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-diff-test-'));
    store = new CotxStore(tmpDir);
    store.init('diff-test');
    store.writeModule({
      id: 'cli/transport',
      canonical_entry: 'Deliver',
      files: ['cli/transport.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'aaaa1111',
    });
    store.writeIndex({
      version: '1',
      compiled_at: '2026-04-08T00:00:00Z',
      project: 'diff-test',
      stats: { modules: 1, concepts: 0, contracts: 0, flows: 0, concerns: 0 },
      graph: {
        nodes: [{ id: 'cli/transport', layer: 'module', file: `v2/truth.lbug#semantic/module/${encodeURIComponent('cli/transport')}` }],
        edges: [],
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns decoded ids from storage v2 semantic artifacts', async () => {
    await commandSnapshot(tmpDir, { tag: 'baseline' });
    store.writeModule({
      id: 'cli/resolve',
      canonical_entry: 'Resolve',
      files: ['cli/resolve.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'bbbb2222',
    });

    const result = await commandDiff(tmpDir, { snapshot: 'baseline', silent: true });

    expect(result.added).toContainEqual({ id: 'cli/resolve', layer: 'module' });
  });

  it('returns a structured change summary', async () => {
    await commandSnapshot(tmpDir, { tag: 'baseline' });
    store.writeModule({
      id: 'cli/resolve',
      canonical_entry: 'Resolve',
      files: ['cli/resolve.ts'],
      depends_on: ['cli/transport'],
      depended_by: [],
      struct_hash: 'bbbb2222',
    });

    const result = await commandDiff(tmpDir, { snapshot: 'baseline', silent: true });

    expect(result.summary).toBeDefined();
    expect(result.summary?.layers.added).toContainEqual({ id: 'cli/resolve', layer: 'module' });
  });
});

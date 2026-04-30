import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CotxStore } from '../../src/store/store.js';
import { CotxGraph } from '../../src/query/graph-index.js';

describe('CotxGraph cache isolation', () => {
  let tmpDirA: string;
  let tmpDirB: string;
  let storeA: CotxStore;
  let storeB: CotxStore;

  beforeEach(() => {
    CotxGraph.invalidateCache();
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-cache-a-'));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-cache-b-'));
    storeA = new CotxStore(tmpDirA);
    storeA.init('project-a');
    storeB = new CotxStore(tmpDirB);
    storeB.init('project-b');
  });

  afterEach(() => {
    CotxGraph.invalidateCache();
    fs.rmSync(tmpDirA, { recursive: true, force: true });
    fs.rmSync(tmpDirB, { recursive: true, force: true });
  });

  it('different projectRoots with same compiled_at get separate graphs', () => {
    const ts = '2026-04-09T12:00:00Z';
    storeA.updateMeta({ compiled_at: ts });
    storeB.updateMeta({ compiled_at: ts });

    storeA.writeModule({
      id: 'mod-a',
      canonical_entry: 'a.ts:main',
      files: ['a.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'h1',
    });
    storeB.writeModule({
      id: 'mod-b',
      canonical_entry: 'b.ts:main',
      files: ['b.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'h2',
    });

    const graphA = CotxGraph.fromStoreCached(storeA);
    const graphB = CotxGraph.fromStoreCached(storeB);

    expect(graphA.findNode('mod-a')).toBeDefined();
    expect(graphA.findNode('mod-b')).toBeUndefined();
    expect(graphB.findNode('mod-b')).toBeDefined();
    expect(graphB.findNode('mod-a')).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { analyzeChurn } from '../../src/compiler/churn-analyzer.js';
import type { ModuleNode } from '../../src/store/schema.js';
import { CotxStore } from '../../src/store/store.js';
import { writeSemanticArtifactSync } from '../../src/store-v2/graph-truth-store.js';

function writeSnapshotModule(
  snapshotDir: string,
  tag: string,
  moduleId: string,
  structHash: string,
): void {
  const dbPath = path.join(snapshotDir, tag, 'v2', 'truth.lbug');
  const data = { id: moduleId, struct_hash: structHash, files: [], depends_on: [], depended_by: [], canonical_entry: '' };
  writeSemanticArtifactSync(dbPath, { layer: 'module', id: moduleId, structHash, payload: data });
}

function writeSnapshotMeta(snapshotDir: string, tag: string, compiledAt: string): void {
  const dir = path.join(snapshotDir, tag);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.yaml'), yaml.dump({ compiled_at: compiledAt, version: '0.1', project: 'test', stats: {} }));
}

describe('analyzeChurn', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-churn-test-'));
    const store = new CotxStore(tmpDir);
    store.init('test');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when no snapshots exist', () => {
    const modules: ModuleNode[] = [
      { id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1' },
    ];
    const edges = analyzeChurn(tmpDir, modules);
    expect(edges).toHaveLength(0);
    expect(modules[0].churn).toBeUndefined();
  });

  it('computes change count from snapshot diffs', () => {
    const snapDir = path.join(tmpDir, '.cotx', 'snapshots');

    // Snapshot v1: api=h1, db=h2
    writeSnapshotMeta(snapDir, 'v1', '2026-01-01T00:00:00Z');
    writeSnapshotModule(snapDir, 'v1', 'api', 'h1');
    writeSnapshotModule(snapDir, 'v1', 'db', 'h2');

    // Snapshot v2: api changed, db same
    writeSnapshotMeta(snapDir, 'v2', '2026-02-01T00:00:00Z');
    writeSnapshotModule(snapDir, 'v2', 'api', 'h1-changed');
    writeSnapshotModule(snapDir, 'v2', 'db', 'h2');

    // Current state: api changed again, db same
    const modules: ModuleNode[] = [
      { id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1-changed-again' },
      { id: 'db', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h2' },
    ];

    analyzeChurn(tmpDir, modules);

    // api changed in v1→v2 and v2→current = 2 changes out of 2 transitions
    expect(modules[0].churn).toBeDefined();
    expect(modules[0].churn!.change_count).toBe(2);
    expect(modules[0].churn!.stability).toBe('volatile');

    // db never changed
    expect(modules[1].churn).toBeUndefined();
  });

  it('detects temporal coupling between co-changing modules', () => {
    const snapDir = path.join(tmpDir, '.cotx', 'snapshots');

    // Three snapshots where api and auth always change together
    writeSnapshotMeta(snapDir, 'v1', '2026-01-01T00:00:00Z');
    writeSnapshotModule(snapDir, 'v1', 'api', 'a1');
    writeSnapshotModule(snapDir, 'v1', 'auth', 'b1');
    writeSnapshotModule(snapDir, 'v1', 'db', 'c1');

    writeSnapshotMeta(snapDir, 'v2', '2026-02-01T00:00:00Z');
    writeSnapshotModule(snapDir, 'v2', 'api', 'a2');
    writeSnapshotModule(snapDir, 'v2', 'auth', 'b2');
    writeSnapshotModule(snapDir, 'v2', 'db', 'c1');  // db unchanged

    writeSnapshotMeta(snapDir, 'v3', '2026-03-01T00:00:00Z');
    writeSnapshotModule(snapDir, 'v3', 'api', 'a3');
    writeSnapshotModule(snapDir, 'v3', 'auth', 'b3');
    writeSnapshotModule(snapDir, 'v3', 'db', 'c1');

    const modules: ModuleNode[] = [
      { id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'a4' },
      { id: 'auth', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'b4' },
      { id: 'db', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'c1' },
    ];

    const couplingEdges = analyzeChurn(tmpDir, modules);

    // api and auth co-change in every transition → ratio = 1.0
    const apiAuth = couplingEdges.find(
      (e) => (e.from === 'api' && e.to === 'auth') || (e.from === 'auth' && e.to === 'api'),
    );
    expect(apiAuth).toBeDefined();
    expect(apiAuth!.cochangeRatio).toBeGreaterThanOrEqual(0.4);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectDelta } from '../../src/compiler/delta-detector.js';
import { CotxStore } from '../../src/store/store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('detectDelta', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-delta-'));
    store = new CotxStore(tmpDir);
    store.init('test');

    // Setup test data
    store.writeModule({ id: 'api', canonical_entry: 'api/handler.go:Handle', files: ['api/handler.go', 'api/router.go'], depends_on: ['db'], depended_by: [], struct_hash: 'aaa' });
    store.writeModule({ id: 'db', canonical_entry: 'db/query.go:Query', files: ['db/query.go'], depends_on: [], depended_by: ['api'], struct_hash: 'bbb' });
    store.writeModule({ id: 'util', canonical_entry: 'util/log.go:Log', files: ['util/log.go'], depends_on: [], depended_by: [], struct_hash: 'ccc' });
    store.writeContract({ id: 'api/db', provider: 'db', consumer: 'api', interface: ['Query'], struct_hash: 'ddd' });
    store.writeFlow({ id: 'flow_1', type: 'flow', trigger: 'Handle', steps: [{ module: 'api', function: 'Handle' }, { module: 'db', function: 'Query' }], struct_hash: 'eee' });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('finds affected module when its file changes', () => {
    const result = detectDelta(store, ['api/handler.go']);
    expect(result.affectedModules).toEqual(['api']);
  });

  it('finds affected contract when provider module changes', () => {
    const result = detectDelta(store, ['db/query.go']);
    expect(result.affectedModules).toEqual(['db']);
    expect(result.affectedContracts).toEqual(['api/db']);
  });

  it('finds affected flow when step module changes', () => {
    const result = detectDelta(store, ['api/handler.go']);
    expect(result.affectedFlows).toEqual(['flow_1']);
  });

  it('returns empty when no files match', () => {
    const result = detectDelta(store, ['unknown/file.go']);
    expect(result.affectedModules).toEqual([]);
    expect(result.affectedContracts).toEqual([]);
    expect(result.affectedFlows).toEqual([]);
  });

  it('handles multiple changed files across modules', () => {
    const result = detectDelta(store, ['api/handler.go', 'db/query.go']);
    expect(result.affectedModules).toEqual(['api', 'db']);
    expect(result.affectedContracts).toEqual(['api/db']);
    expect(result.affectedFlows).toEqual(['flow_1']);
  });

  it('does not affect unrelated modules', () => {
    const result = detectDelta(store, ['util/log.go']);
    expect(result.affectedModules).toEqual(['util']);
    expect(result.affectedContracts).toEqual([]);
    expect(result.affectedFlows).toEqual([]);
  });
});

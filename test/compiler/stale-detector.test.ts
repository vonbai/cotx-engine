import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectStale, markStaleAnnotations } from '../../src/compiler/stale-detector.js';
import { CotxStore } from '../../src/store/store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('detectStale', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-stale-'));
    store = new CotxStore(tmpDir);
    store.init('test');
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('detects stale enrichment when source_hash differs', () => {
    store.writeModule({
      id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [],
      struct_hash: 'new_hash',
      enriched: { responsibility: 'old desc', source_hash: 'old_hash', enriched_at: '2026-01-01' },
    });
    const result = detectStale(store);
    expect(result.staleEnrichments).toHaveLength(1);
    expect(result.staleEnrichments[0].nodeId).toBe('api');
    expect(result.summary.enrichments).toBe(1);
  });

  it('no stale when source_hash matches struct_hash', () => {
    store.writeModule({
      id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [],
      struct_hash: 'same',
      enriched: { responsibility: 'desc', source_hash: 'same', enriched_at: '2026-01-01' },
    });
    const result = detectStale(store);
    expect(result.staleEnrichments).toHaveLength(0);
  });

  it('detects stale annotations', () => {
    store.writeModule({
      id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [],
      struct_hash: 'aaa',
      annotations: [{ author: 'human', type: 'constraint', content: 'test', date: '2026-01-01', stale: true, stale_reason: 'code changed' }],
    });
    const result = detectStale(store);
    expect(result.staleAnnotations).toHaveLength(1);
  });

  it('detects unenriched nodes as needing enrichment', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'aaa' });
    const result = detectStale(store);
    expect(result.staleEnrichments).toHaveLength(1);
    expect(result.staleEnrichments[0].source_hash).toBe('');
  });
});

describe('markStaleAnnotations', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-mark-'));
    store = new CotxStore(tmpDir);
    store.init('test');
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('marks annotations stale on changed nodes', () => {
    store.writeModule({
      id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [],
      struct_hash: 'aaa',
      annotations: [{ author: 'human', type: 'constraint', content: 'test', date: '2026-01-01' }],
    });
    const count = markStaleAnnotations(store, new Set(['api']), 'struct_hash changed');
    expect(count).toBe(1);
    const mod = store.readModule('api');
    expect(mod.annotations![0].stale).toBe(true);
    expect(mod.annotations![0].stale_reason).toBe('struct_hash changed');
  });

  it('skips already stale annotations', () => {
    store.writeModule({
      id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [],
      struct_hash: 'aaa',
      annotations: [{ author: 'human', type: 'constraint', content: 'test', date: '2026-01-01', stale: true, stale_reason: 'old reason' }],
    });
    const count = markStaleAnnotations(store, new Set(['api']), 'new reason');
    expect(count).toBe(0);  // already stale, not re-marked
  });

  it('does not touch unchanged nodes', () => {
    store.writeModule({
      id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [],
      struct_hash: 'aaa',
      annotations: [{ author: 'human', type: 'constraint', content: 'test', date: '2026-01-01' }],
    });
    const count = markStaleAnnotations(store, new Set(['other']), 'reason');
    expect(count).toBe(0);
    const mod = store.readModule('api');
    expect(mod.annotations![0].stale).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CotxStore } from '../../src/store/store.js';
import { CotxDataProvider } from '../../src/viz/data-provider.js';

function seedStore(tmpDir: string): CotxStore {
  const store = new CotxStore(tmpDir);
  store.init('test-viz');

  store.writeModule({
    id: 'api',
    canonical_entry: 'api/handler.ts:handle',
    files: ['api/handler.ts', 'api/router.ts'],
    depends_on: ['db'],
    depended_by: [],
    struct_hash: 'h1',
  });
  store.writeModule({
    id: 'db',
    canonical_entry: 'db/store.ts:query',
    files: ['db/store.ts'],
    depends_on: [],
    depended_by: ['api'],
    struct_hash: 'h2',
  });
  store.writeConcept({
    id: 'session',
    aliases: ['user-session'],
    appears_in: ['api/handler.ts'],
    layer: 'api',
    struct_hash: 'c1',
  });
  store.writeContract({
    id: 'api-db',
    provider: 'db',
    consumer: 'api',
    interface: ['query()', 'exec()'],
    struct_hash: 'ct1',
  });
  store.writeFlow({
    id: 'handle-request',
    type: 'flow',
    trigger: 'HTTP POST /api',
    steps: [
      { module: 'api', function: 'handle' },
      { module: 'db', function: 'query' },
    ],
    struct_hash: 'f1',
  });
  store.writeConcern({
    id: 'perf-risk',
    type: 'risk',
    severity: 'high',
    description: 'N+1 queries in api',
    affected_modules: ['api'],
    affected_flows: ['handle-request'],
    author: 'human',
    created: '2026-04-09',
  });

  return store;
}

describe('CotxDataProvider', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-viz-test-'));
    seedStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('fromDirectory', () => {
    it('loads meta from store', () => {
      const data = CotxDataProvider.fromDirectory(tmpDir);
      expect(data.meta.project).toBe('test-viz');
      expect(data.meta.compiled_at).toBeTruthy();
      expect(data.meta.version).toBeTruthy();
    });

    it('loads all modules', () => {
      const data = CotxDataProvider.fromDirectory(tmpDir);
      expect(data.modules).toHaveLength(2);
      const ids = data.modules.map((m) => m.id).sort();
      expect(ids).toEqual(['api', 'db']);
    });

    it('loads concepts, contracts, flows, concerns', () => {
      const data = CotxDataProvider.fromDirectory(tmpDir);
      expect(data.concepts).toHaveLength(1);
      expect(data.contracts).toHaveLength(1);
      expect(data.flows).toHaveLength(1);
      expect(data.concerns).toHaveLength(1);
    });

    it('builds edges from module dependencies', () => {
      const data = CotxDataProvider.fromDirectory(tmpDir);
      const depEdges = data.edges.filter((e) => e.type === 'depends_on');
      expect(depEdges).toHaveLength(1);
      expect(depEdges[0]).toMatchObject({ source: 'api', target: 'db' });
    });

    it('builds edges from concept ownership', () => {
      const data = CotxDataProvider.fromDirectory(tmpDir);
      const ownEdges = data.edges.filter((e) => e.type === 'owns_concept');
      expect(ownEdges).toHaveLength(1);
      expect(ownEdges[0]).toMatchObject({ source: 'api', target: 'session' });
    });

    it('builds edges from contracts with label', () => {
      const data = CotxDataProvider.fromDirectory(tmpDir);
      const cEdges = data.edges.filter((e) => e.type === 'contract');
      expect(cEdges).toHaveLength(1);
      expect(cEdges[0]).toMatchObject({ source: 'api', target: 'db' });
      expect(cEdges[0].label).toContain('query()');
    });

    it('builds edges from flow steps', () => {
      const data = CotxDataProvider.fromDirectory(tmpDir);
      const fEdges = data.edges.filter((e) => e.type === 'step_in_flow');
      expect(fEdges).toHaveLength(2);
    });

    it('builds edges from concern affects', () => {
      const data = CotxDataProvider.fromDirectory(tmpDir);
      const aEdges = data.edges.filter((e) => e.type === 'affects');
      expect(aEdges).toHaveLength(1);
      expect(aEdges[0]).toMatchObject({ source: 'perf-risk', target: 'api' });
    });

    it('deduplicates edges', () => {
      const data = CotxDataProvider.fromDirectory(tmpDir);
      const keys = data.edges.map((e) => `${e.source}→${e.target}:${e.type}`);
      const unique = new Set(keys);
      expect(keys.length).toBe(unique.size);
    });

    it('loads temporal coupling edges from graph directory', () => {
      const graphDir = path.join(tmpDir, '.cotx', 'graph');
      fs.mkdirSync(graphDir, { recursive: true });
      fs.writeFileSync(
        path.join(graphDir, 'temporal-coupling.json'),
        JSON.stringify({ from: 'api', to: 'db', cochangeRatio: 0.6, cochangeCount: 3 }) + '\n',
      );

      const data = CotxDataProvider.fromDirectory(tmpDir);
      const tcEdges = data.edges.filter((e) => e.type === 'temporal_coupling');
      expect(tcEdges).toHaveLength(1);
      expect(tcEdges[0]).toMatchObject({ source: 'api', target: 'db' });
    });

    it('gracefully skips missing temporal coupling file', () => {
      // No temporal-coupling.json written — should not throw
      const data = CotxDataProvider.fromDirectory(tmpDir);
      const tcEdges = data.edges.filter((e) => e.type === 'temporal_coupling');
      expect(tcEdges).toHaveLength(0);
    });
  });

  describe('fromJSON', () => {
    it('parses valid CotxGraphData', () => {
      const raw = CotxDataProvider.fromDirectory(tmpDir);
      const json = JSON.parse(JSON.stringify(raw));
      const data = CotxDataProvider.fromJSON(json);
      expect(data.meta.project).toBe('test-viz');
      expect(data.modules).toHaveLength(2);
    });

    it('throws on missing required fields', () => {
      expect(() => CotxDataProvider.fromJSON({})).toThrow('missing required fields');
      expect(() => CotxDataProvider.fromJSON({ meta: {} })).toThrow('missing required fields');
    });
  });
});

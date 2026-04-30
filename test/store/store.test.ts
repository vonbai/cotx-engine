import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CotxStore } from '../../src/store/store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('CotxStore', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-test-'));
    store = new CotxStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes .cotx/ directory structure', () => {
    store.init('test-project');
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'meta.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'v2'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'modules'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'concepts'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'contracts'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'flows'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'concerns'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'graph'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'concern-families'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'canonical-paths'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'symmetry'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'closures'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'abstractions'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'decision-overrides'))).toBe(false);
  });

  it('writes and reads a module semantic artifact', () => {
    store.init('test-project');
    const mod = {
      id: 'api',
      canonical_entry: 'api/handler.go:HandleRequest',
      files: ['api/handler.go', 'api/router.go'],
      depends_on: ['db'],
      depended_by: [],
      struct_hash: 'abc12345',
    };
    store.writeModule(mod);
    const loaded = store.readModule('api');
    expect(loaded.id).toBe('api');
    expect(loaded.files).toEqual(['api/handler.go', 'api/router.go']);
    expect(loaded.struct_hash).toBe('abc12345');
  });

  it('preserves annotations when rewriting module', () => {
    store.init('test-project');
    const mod = {
      id: 'api',
      canonical_entry: 'api/handler.go:HandleRequest',
      files: ['api/handler.go'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'abc12345',
      annotations: [
        { author: 'human' as const, type: 'constraint' as const, content: 'must be crash-safe', date: '2026-04-05' },
      ],
    };
    store.writeModule(mod);

    // Rewrite with new struct (simulating cotx update)
    const updated = { ...mod, files: ['api/handler.go', 'api/new.go'], struct_hash: 'def45678', annotations: undefined };
    store.writeModule(updated);

    const loaded = store.readModule('api');
    expect(loaded.struct_hash).toBe('def45678');
    expect(loaded.annotations).toHaveLength(1);
    expect(loaded.annotations![0].content).toBe('must be crash-safe');
  });

  it('listModules returns module IDs', () => {
    store.init('test-project');
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'a' });
    store.writeModule({ id: 'db', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'b' });
    const modules = store.listModules();
    expect(modules).toContain('api');
    expect(modules).toContain('db');
    expect(modules).toHaveLength(2);
  });

  it('writeGraphFile writes JSON lines', () => {
    store.init('test-project');
    store.writeGraphFile('nodes.json', ['{"id":"a"}', '{"id":"b"}']);
    const content = fs.readFileSync(path.join(tmpDir, '.cotx', 'graph', 'nodes.json'), 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(2);
  });

  it('updateMeta merges updates', () => {
    store.init('test-project');
    store.updateMeta({ stats: { concepts: 5, modules: 3, contracts: 2, flows: 1, concerns: 0 } });
    const meta = store.readMeta();
    expect(meta.stats.modules).toBe(3);
    expect(meta.project).toBe('test-project'); // preserved from init
  });

  it('exists() returns false before init', () => {
    expect(store.exists()).toBe(false);
  });

  it('exists() returns true after init', () => {
    store.init('test-project');
    expect(store.exists()).toBe(true);
  });

  it('writeConcept and readConcept round-trip', () => {
    store.init('test-project');
    const concept = {
      id: 'run',
      aliases: ['run-session'],
      appears_in: ['cli/run.go'],
      layer: 'M2',
      struct_hash: 'aabbccdd',
    };
    store.writeConcept(concept);
    const loaded = store.readConcept('run');
    expect(loaded.id).toBe('run');
    expect(loaded.aliases).toEqual(['run-session']);
    expect(loaded.struct_hash).toBe('aabbccdd');
  });

  it('writeContract and readContract round-trip', () => {
    store.init('test-project');
    const contract = {
      id: 'api-db',
      provider: 'db',
      consumer: 'api',
      interface: ['Query()', 'Exec()'],
      struct_hash: '11223344',
    };
    store.writeContract(contract);
    const loaded = store.readContract('api-db');
    expect(loaded.provider).toBe('db');
    expect(loaded.interface).toEqual(['Query()', 'Exec()']);
  });

  it('writeFlow and readFlow round-trip', () => {
    store.init('test-project');
    const flow = {
      id: 'handle-request',
      trigger: 'HTTP GET /api',
      steps: [{ module: 'api', function: 'HandleRequest' }],
      struct_hash: 'deadbeef',
    };
    store.writeFlow(flow);
    const loaded = store.readFlow('handle-request');
    expect(loaded.trigger).toBe('HTTP GET /api');
    expect(loaded.steps).toHaveLength(1);
    expect(loaded.steps[0].module).toBe('api');
  });

  it('roundtrips module IDs with / correctly via URL encoding', () => {
    store.init('test-project');
    const mod: Parameters<typeof store.writeModule>[0] = {
      id: 'cli/transport',
      canonical_entry: 'Deliver',
      files: ['cli/transport.go'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'bbbbbbbb',
    };
    store.writeModule(mod);
    const loaded = store.readModule('cli/transport');
    expect(loaded.id).toBe('cli/transport');
    expect(loaded.canonical_entry).toBe('Deliver');
  });

  it('handles IDs containing -- without corruption', () => {
    store.init('test-project');
    const mod: Parameters<typeof store.writeModule>[0] = {
      id: 'my--util',
      canonical_entry: '',
      files: ['my--util/a.go'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'cccccccc',
    };
    store.writeModule(mod);
    const loaded = store.readModule('my--util');
    expect(loaded.id).toBe('my--util');
  });

  it('writeIndex and readIndex round-trip', () => {
    store.init('test-project');
    const index = {
      version: '0.1',
      compiled_at: '2026-04-05T00:00:00Z',
      project: 'test-project',
      stats: { concepts: 1, modules: 2, contracts: 0, flows: 1, concerns: 0 },
      graph: {
        nodes: [{ id: 'api', layer: 'module', file: 'v2/truth.lbug#semantic/module/api' }],
        edges: [{ from: 'api', to: 'db', relation: 'depends_on' }],
      },
    };
    store.writeIndex(index);
    const loaded = store.readIndex();
    expect(loaded.project).toBe('test-project');
    expect(loaded.graph.nodes).toHaveLength(1);
    expect(loaded.graph.edges[0].relation).toBe('depends_on');
  });

  it('writeConcern and listConcerns round-trip ids with slashes', () => {
    store.init('test-project');
    store.writeConcern({
      id: 'risk/runtime',
      type: 'risk',
      severity: 'high',
      description: 'runtime risk',
      affected_modules: ['api'],
      affected_flows: [],
      author: 'human',
      created: '2026-04-08',
    });

    expect(store.readConcern('risk/runtime').id).toBe('risk/runtime');
    expect(store.listConcerns()).toContain('risk/runtime');
  });

  it('writes and reads the latest change summary', () => {
    store.init('test-project');
    store.writeLatestChangeSummary({
      generated_at: '2026-04-10T00:00:00Z',
      trigger: 'update',
      changed_files: ['src/main.ts'],
      affected_modules: ['api'],
      affected_contracts: [],
      affected_flows: [],
      symbols: { added: [], removed: [], changed: [] },
      layers: { added: [{ id: 'api', layer: 'module' }], removed: [], changed: [] },
      stale: { enrichments: [], annotations: [] },
    });

    const summary = store.readLatestChangeSummary();
    expect(summary?.trigger).toBe('update');
    expect(summary?.layers.added).toContainEqual({ id: 'api', layer: 'module' });
  });
});

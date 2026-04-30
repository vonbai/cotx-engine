import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CotxStore } from '../../src/store/store.js';
import { CotxGraph } from '../../src/query/graph-index.js';

// ── Test fixture helpers ───────────────────────────────────────────────────

function makeStore(tmpDir: string): CotxStore {
  const store = new CotxStore(tmpDir);
  store.init('test-project');
  return store;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CotxGraph', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-graph-test-'));
    store = makeStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. fromStore loads all node types correctly
  it('fromStore loads all node types', () => {
    store.writeModule({
      id: 'api',
      canonical_entry: 'api/handler.go:HandleRequest',
      files: ['api/handler.go'],
      depends_on: ['db'],
      depended_by: [],
      struct_hash: 'abc1',
    });
    store.writeModule({
      id: 'db',
      canonical_entry: 'db/store.go:Query',
      files: ['db/store.go'],
      depends_on: [],
      depended_by: ['api'],
      struct_hash: 'abc2',
    });
    store.writeConcept({
      id: 'session',
      aliases: ['run-session'],
      appears_in: ['api/handler.go'],
      layer: 'api',
      struct_hash: 'con1',
    });
    store.writeContract({
      id: 'api-db',
      provider: 'db',
      consumer: 'api',
      interface: ['Query()', 'Exec()'],
      struct_hash: 'ctr1',
    });
    store.writeFlow({
      id: 'handle-request',
      type: 'flow',
      trigger: 'HTTP GET /api',
      steps: [{ module: 'api', function: 'HandleRequest' }],
      struct_hash: 'fl1',
    });
    store.writeConcern({
      id: 'perf-risk',
      type: 'risk',
      severity: 'high',
      description: 'N+1 query risk in api module',
      affected_modules: ['api'],
      affected_flows: ['handle-request'],
      author: 'human',
      created: '2026-04-05',
    });

    const graph = CotxGraph.fromStore(store);

    expect(graph.findNode('api')).toBeDefined();
    expect(graph.findNode('db')).toBeDefined();
    expect(graph.findNode('session')).toBeDefined();
    expect(graph.findNode('api-db')).toBeDefined();
    expect(graph.findNode('handle-request')).toBeDefined();
    expect(graph.findNode('perf-risk')).toBeDefined();

    expect(graph.findNode('api')?.layer).toBe('module');
    expect(graph.findNode('session')?.layer).toBe('concept');
    expect(graph.findNode('api-db')?.layer).toBe('contract');
    expect(graph.findNode('handle-request')?.layer).toBe('flow');
    expect(graph.findNode('perf-risk')?.layer).toBe('concern');
  });

  // 2. findNode returns correct node by ID
  it('findNode returns the correct node', () => {
    store.writeModule({
      id: 'auth',
      canonical_entry: 'auth/auth.go:Authenticate',
      files: ['auth/auth.go'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'h1',
    });
    const graph = CotxGraph.fromStore(store);
    const node = graph.findNode('auth');
    expect(node).toBeDefined();
    expect(node!.id).toBe('auth');
    expect(node!.layer).toBe('module');
    expect((node!.data as { id: string }).id).toBe('auth');
  });

  it('findNode returns undefined for missing IDs', () => {
    const graph = CotxGraph.fromStore(store);
    expect(graph.findNode('nonexistent')).toBeUndefined();
  });

  // 3. allNodes returns all nodes, filter by layer works
  it('allNodes returns all nodes without filter', () => {
    store.writeModule({
      id: 'm1', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1',
    });
    store.writeConcept({
      id: 'c1', aliases: [], appears_in: [], layer: 'm1', struct_hash: 'h2',
    });
    const graph = CotxGraph.fromStore(store);
    expect(graph.allNodes()).toHaveLength(2);
  });

  it('allNodes filters by layer', () => {
    store.writeModule({ id: 'm1', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'm2', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h2' });
    store.writeConcept({ id: 'c1', aliases: [], appears_in: [], layer: 'm1', struct_hash: 'h3' });
    const graph = CotxGraph.fromStore(store);
    const modules = graph.allNodes('module');
    expect(modules).toHaveLength(2);
    expect(modules.every((n) => n.layer === 'module')).toBe(true);
    const concepts = graph.allNodes('concept');
    expect(concepts).toHaveLength(1);
    expect(concepts[0].id).toBe('c1');
  });

  // 4. neighbors returns correct out/in/both edges
  it('neighbors returns correct outgoing edges', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: ['db', 'cache'], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'db', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h2' });
    store.writeModule({ id: 'cache', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h3' });
    const graph = CotxGraph.fromStore(store);
    const out = graph.neighbors('api', 'out');
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.from === 'api')).toBe(true);
    expect(out.map((e) => e.to).sort()).toEqual(['cache', 'db']);
    expect(out.every((e) => e.relation === 'depends_on')).toBe(true);
  });

  it('neighbors returns correct incoming edges', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: ['db'], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'db', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h2' });
    const graph = CotxGraph.fromStore(store);
    const inEdges = graph.neighbors('db', 'in');
    expect(inEdges).toHaveLength(1);
    expect(inEdges[0].from).toBe('api');
    expect(inEdges[0].to).toBe('db');
  });

  it('neighbors returns both directions', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: ['db'], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'db', canonical_entry: '', files: [], depends_on: ['cache'], depended_by: [], struct_hash: 'h2' });
    store.writeModule({ id: 'cache', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h3' });
    const graph = CotxGraph.fromStore(store);
    const both = graph.neighbors('db', 'both');
    // db→cache (out) and api→db (in)
    expect(both).toHaveLength(2);
  });

  // 5. bfs with depth 1 returns direct neighbors
  it('bfs depth 1 returns direct neighbors only', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: ['db'], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'db', canonical_entry: '', files: [], depends_on: ['cache'], depended_by: [], struct_hash: 'h2' });
    store.writeModule({ id: 'cache', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h3' });
    const graph = CotxGraph.fromStore(store);

    const result = graph.bfs('api', 'out', 1);
    expect(result.get(1)).toEqual(['db']);
    expect(result.has(2)).toBe(false);
  });

  // 6. bfs with depth 2 returns transitive neighbors
  it('bfs depth 2 returns transitive neighbors', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: ['db'], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'db', canonical_entry: '', files: [], depends_on: ['cache'], depended_by: [], struct_hash: 'h2' });
    store.writeModule({ id: 'cache', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h3' });
    const graph = CotxGraph.fromStore(store);

    const result = graph.bfs('api', 'out', 2);
    expect(result.get(1)).toEqual(['db']);
    expect(result.get(2)).toEqual(['cache']);
  });

  it('bfs direction in traverses upstream', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: ['db'], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'db', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h2' });
    const graph = CotxGraph.fromStore(store);

    // from db going "in" should reach api
    const result = graph.bfs('db', 'in', 2);
    expect(result.get(1)).toEqual(['api']);
  });

  it('bfs does not revisit nodes (handles cycles)', () => {
    // api → db → api would be a cycle (unlikely in practice but robust)
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: ['db'], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'db', canonical_entry: '', files: [], depends_on: ['api'], depended_by: [], struct_hash: 'h2' });
    const graph = CotxGraph.fromStore(store);

    const result = graph.bfs('api', 'out', 5);
    // depth 1 = db, no revisit of api
    expect(result.get(1)).toEqual(['db']);
    expect(result.has(2)).toBe(false); // api already visited
  });

  // 7. search finds nodes by keyword (case-insensitive)
  it('search finds nodes by keyword case-insensitively', () => {
    store.writeModule({
      id: 'auth',
      canonical_entry: 'auth/auth.go:Authenticate',
      files: ['auth/auth.go'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'h1',
    });
    store.writeModule({
      id: 'api',
      canonical_entry: 'api/handler.go:HandleRequest',
      files: ['api/handler.go'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'h2',
    });
    const graph = CotxGraph.fromStore(store);

    const results = graph.search('AUTH');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((n) => n.id === 'auth')).toBe(true);
    // 'api' shouldn't match 'AUTH'
    expect(results.some((n) => n.id === 'api')).toBe(false);
  });

  it('search matches against all string fields in data', () => {
    store.writeConcern({
      id: 'c1',
      type: 'risk',
      severity: 'critical',
      description: 'Memory leak in session cache',
      affected_modules: ['cache'],
      affected_flows: [],
      author: 'human',
      created: '2026-04-05',
    });
    const graph = CotxGraph.fromStore(store);
    const results = graph.search('memory leak');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('c1');
  });

  // 8. search with layer filter only returns that layer
  it('search with layer filter restricts results', () => {
    store.writeModule({
      id: 'auth',
      canonical_entry: 'auth/auth.go',
      files: [],
      depends_on: [],
      depended_by: [],
      struct_hash: 'h1',
    });
    store.writeConcept({
      id: 'auth-token',
      aliases: ['auth'],
      appears_in: [],
      layer: 'auth',
      struct_hash: 'h2',
    });
    const graph = CotxGraph.fromStore(store);

    const all = graph.search('auth');
    expect(all.length).toBeGreaterThanOrEqual(2);

    const conceptsOnly = graph.search('auth', 'concept');
    expect(conceptsOnly.every((n) => n.layer === 'concept')).toBe(true);
    expect(conceptsOnly.some((n) => n.id === 'auth-token')).toBe(true);
    expect(conceptsOnly.some((n) => n.layer === 'module')).toBe(false);
  });

  // 9. Empty store → empty graph
  it('empty store produces empty graph', () => {
    const graph = CotxGraph.fromStore(store);
    expect(graph.allNodes()).toHaveLength(0);
    expect(graph.findNode('anything')).toBeUndefined();
    expect(graph.neighbors('x', 'out')).toHaveLength(0);
    expect(graph.bfs('x', 'out', 3).size).toBe(0);
    expect(graph.search('anything')).toHaveLength(0);
  });

  // Additional: cross-layer edges (contract, owns_concept, step_in_flow, affects)
  it('contract edge links consumer to provider', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'db', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h2' });
    store.writeContract({ id: 'api-db', provider: 'db', consumer: 'api', interface: [], struct_hash: 'c1' });
    const graph = CotxGraph.fromStore(store);
    const out = graph.neighbors('api', 'out');
    expect(out.some((e) => e.to === 'db' && e.relation === 'contract')).toBe(true);
  });

  it('owns_concept edge links module to concept', () => {
    store.writeModule({ id: 'auth', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1' });
    store.writeConcept({ id: 'token', aliases: [], appears_in: [], layer: 'auth', struct_hash: 'h2' });
    const graph = CotxGraph.fromStore(store);
    const out = graph.neighbors('auth', 'out');
    expect(out.some((e) => e.to === 'token' && e.relation === 'owns_concept')).toBe(true);
  });

  it('step_in_flow edge links flow to its modules', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1' });
    store.writeFlow({
      id: 'req-flow',
      type: 'flow',
      trigger: 'HTTP GET',
      steps: [{ module: 'api', function: 'Handle' }],
      struct_hash: 'fl1',
    });
    const graph = CotxGraph.fromStore(store);
    const out = graph.neighbors('req-flow', 'out');
    expect(out.some((e) => e.to === 'api' && e.relation === 'step_in_flow')).toBe(true);
  });

  it('affects edge links concern to its modules', () => {
    store.writeModule({ id: 'cache', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1' });
    store.writeConcern({
      id: 'leak',
      type: 'risk',
      severity: 'high',
      description: 'Memory leak',
      affected_modules: ['cache'],
      affected_flows: [],
      author: 'human',
      created: '2026-04-05',
    });
    const graph = CotxGraph.fromStore(store);
    const out = graph.neighbors('leak', 'out');
    expect(out.some((e) => e.to === 'cache' && e.relation === 'affects')).toBe(true);
  });

  it('pageRank returns scores for all nodes', () => {
    store.writeModule({ id: 'a', canonical_entry: '', files: [], depends_on: ['b'], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'b', canonical_entry: '', files: [], depends_on: ['c'], depended_by: [], struct_hash: 'h2' });
    store.writeModule({ id: 'c', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h3' });
    const graph = CotxGraph.fromStore(store);
    const scores = graph.pageRank();
    expect(scores.size).toBe(3);
    // c should have highest score (most incoming)
    expect(scores.get('c')!).toBeGreaterThan(scores.get('a')!);
  });

  it('temporalCoupling returns coupling edges', () => {
    store.writeModule({ id: 'api', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h1' });
    store.writeModule({ id: 'auth', canonical_entry: '', files: [], depends_on: [], depended_by: [], struct_hash: 'h2' });
    // Write temporal coupling file
    const graphDir = path.join(tmpDir, '.cotx', 'graph');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(
      path.join(graphDir, 'temporal-coupling.json'),
      JSON.stringify({ from: 'api', to: 'auth', cochangeRatio: 0.8, cochangeCount: 5 }) + '\n',
    );

    const graph = CotxGraph.fromStore(store);
    const coupling = graph.temporalCoupling('api');
    expect(coupling.length).toBeGreaterThanOrEqual(1);
    expect(coupling[0].relation).toBe('temporal_coupling');
  });
});

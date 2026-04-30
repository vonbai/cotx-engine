import { describe, it, expect } from 'vitest';
import { compileContracts } from '../../src/compiler/contract-compiler.js';
import type { GraphNode, GraphEdge } from '../../src/core/export/json-exporter.js';
import type { ModuleNode } from '../../src/store/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, name: string, filePath: string): GraphNode {
  return { id, label: 'Function', properties: { name, filePath, isExported: true } };
}

function makeEdge(sourceId: string, targetId: string, type = 'CALLS'): GraphEdge {
  return { sourceId, targetId, type, confidence: 0.9 };
}

function makeModule(id: string, files: string[]): ModuleNode {
  return {
    id,
    canonical_entry: '',
    files,
    depends_on: [],
    depended_by: [],
    struct_hash: 'deadbeef',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compileContracts', () => {
  it('returns empty array for empty input', () => {
    expect(compileContracts([], [], [])).toEqual([]);
  });

  it('produces one contract for two modules with cross-calls', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'HandleRequest', 'api/handler.go'),
      makeNode('n2', 'QueryDB', 'db/query.go'),
    ];
    const edges: GraphEdge[] = [makeEdge('n1', 'n2')];
    const modules: ModuleNode[] = [
      makeModule('api', ['api/handler.go']),
      makeModule('db', ['db/query.go']),
    ];

    const contracts = compileContracts(nodes, edges, modules);

    expect(contracts).toHaveLength(1);
    expect(contracts[0].consumer).toBe('api');
    expect(contracts[0].provider).toBe('db');
  });

  it('contract ID uses format consumer--provider', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'HandleRequest', 'api/handler.go'),
      makeNode('n2', 'QueryDB', 'db/query.go'),
    ];
    const edges: GraphEdge[] = [makeEdge('n1', 'n2')];
    const modules: ModuleNode[] = [
      makeModule('api', ['api/handler.go']),
      makeModule('db', ['db/query.go']),
    ];

    const contracts = compileContracts(nodes, edges, modules);

    expect(contracts[0].id).toBe('api--db');
  });

  it('interface list is deduplicated and sorted', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'Caller1', 'api/a.go'),
      makeNode('n2', 'Caller2', 'api/b.go'),
      makeNode('n3', 'Zebra', 'db/z.go'),
      makeNode('n4', 'Alpha', 'db/a.go'),
      makeNode('n5', 'Zebra', 'db/z2.go'), // duplicate name
    ];
    const edges: GraphEdge[] = [
      makeEdge('n1', 'n3'),
      makeEdge('n2', 'n4'),
      makeEdge('n1', 'n5'), // same name "Zebra" again — should deduplicate
    ];
    const modules: ModuleNode[] = [
      makeModule('api', ['api/a.go', 'api/b.go']),
      makeModule('db', ['db/z.go', 'db/a.go', 'db/z2.go']),
    ];

    const contracts = compileContracts(nodes, edges, modules);

    expect(contracts).toHaveLength(1);
    expect(contracts[0].interface).toEqual(['Alpha', 'Zebra']); // sorted, no duplicates
  });

  it('does not produce a contract for intra-module calls', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'A', 'api/a.go'),
      makeNode('n2', 'B', 'api/b.go'),
    ];
    const edges: GraphEdge[] = [makeEdge('n1', 'n2')];
    const modules: ModuleNode[] = [
      makeModule('api', ['api/a.go', 'api/b.go']),
    ];

    const contracts = compileContracts(nodes, edges, modules);

    expect(contracts).toHaveLength(0);
  });

  it('produces multiple contracts for different module pairs', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'APIFn', 'api/api.go'),
      makeNode('n2', 'DBFn', 'db/db.go'),
      makeNode('n3', 'CacheFn', 'cache/cache.go'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('n1', 'n2'), // api → db
      makeEdge('n1', 'n3'), // api → cache
    ];
    const modules: ModuleNode[] = [
      makeModule('api', ['api/api.go']),
      makeModule('db', ['db/db.go']),
      makeModule('cache', ['cache/cache.go']),
    ];

    const contracts = compileContracts(nodes, edges, modules);

    expect(contracts).toHaveLength(2);
    const ids = contracts.map((c) => c.id);
    expect(ids).toContain('api--cache');
    expect(ids).toContain('api--db');
  });

  it('contracts are sorted alphabetically by id', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'APIFn', 'api/api.go'),
      makeNode('n2', 'DBFn', 'db/db.go'),
      makeNode('n3', 'CacheFn', 'cache/cache.go'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('n1', 'n2'),
      makeEdge('n1', 'n3'),
    ];
    const modules: ModuleNode[] = [
      makeModule('api', ['api/api.go']),
      makeModule('db', ['db/db.go']),
      makeModule('cache', ['cache/cache.go']),
    ];

    const contracts = compileContracts(nodes, edges, modules);

    expect(contracts[0].id).toBe('api--cache');
    expect(contracts[1].id).toBe('api--db');
  });

  it('struct_hash is exactly 8 characters', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'HandleRequest', 'api/handler.go'),
      makeNode('n2', 'QueryDB', 'db/query.go'),
    ];
    const edges: GraphEdge[] = [makeEdge('n1', 'n2')];
    const modules: ModuleNode[] = [
      makeModule('api', ['api/handler.go']),
      makeModule('db', ['db/query.go']),
    ];

    const contracts = compileContracts(nodes, edges, modules);

    expect(contracts[0].struct_hash).toHaveLength(8);
  });

  it('only counts CALLS edges, not IMPORTS edges', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'HandleRequest', 'api/handler.go'),
      makeNode('n2', 'QueryDB', 'db/query.go'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('n1', 'n2', 'IMPORTS'),
    ];
    const modules: ModuleNode[] = [
      makeModule('api', ['api/handler.go']),
      makeModule('db', ['db/query.go']),
    ];

    const contracts = compileContracts(nodes, edges, modules);

    expect(contracts).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { compileModules } from '../../src/compiler/module-compiler.js';
import type { GraphNode, GraphEdge, CommunityData } from '../../src/core/export/json-exporter.js';

describe('compileModules', () => {
  it('groups files by top-level directory', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'HandleRequest', filePath: 'api/handler.go', isExported: true } },
      { id: 'f2', label: 'Function', properties: { name: 'QueryDB', filePath: 'db/query.go', isExported: true } },
      { id: 'f3', label: 'Function', properties: { name: 'ValidateInput', filePath: 'api/validate.go', isExported: true } },
    ];
    const edges: GraphEdge[] = [
      { sourceId: 'f1', targetId: 'f2', type: 'CALLS', confidence: 0.95 },
      { sourceId: 'f1', targetId: 'f3', type: 'CALLS', confidence: 0.95 },
    ];

    const modules = compileModules(nodes, edges, []);

    expect(modules).toHaveLength(2);
    const apiMod = modules.find((m) => m.id === 'api');
    const dbMod = modules.find((m) => m.id === 'db');
    expect(apiMod).toBeDefined();
    expect(apiMod!.files).toContain('api/handler.go');
    expect(apiMod!.files).toContain('api/validate.go');
    expect(dbMod).toBeDefined();
    expect(dbMod!.files).toContain('db/query.go');
  });

  it('sets canonical_entry to most externally called function', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'HandleRequest', filePath: 'api/handler.go', isExported: true } },
      { id: 'f2', label: 'Function', properties: { name: 'helperFunc', filePath: 'api/helper.go', isExported: false } },
      { id: 'ext1', label: 'Function', properties: { name: 'Main', filePath: 'main.go', isExported: true } },
    ];
    const edges: GraphEdge[] = [
      { sourceId: 'ext1', targetId: 'f1', type: 'CALLS', confidence: 0.9 },
    ];

    const modules = compileModules(nodes, edges, []);
    const apiMod = modules.find((m) => m.id === 'api');
    expect(apiMod!.canonical_entry).toContain('HandleRequest');
  });

  it('does not select an exported test helper as canonical_entry', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'RunApi', filePath: 'api/main.go', isExported: true } },
      { id: 'f2', label: 'Function', properties: { name: 'TestMain', filePath: 'api/main_test.go', isExported: true } },
    ];

    const modules = compileModules(nodes, [], []);
    const apiMod = modules.find((m) => m.id === 'api');
    expect(apiMod!.canonical_entry).toBe('RunApi');
  });

  it('computes depends_on and depended_by from cross-module calls', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'A', filePath: 'api/a.go', isExported: true } },
      { id: 'f2', label: 'Function', properties: { name: 'B', filePath: 'db/b.go', isExported: true } },
    ];
    const edges: GraphEdge[] = [
      { sourceId: 'f1', targetId: 'f2', type: 'CALLS', confidence: 0.95 },
    ];

    const modules = compileModules(nodes, edges, []);
    const apiMod = modules.find((m) => m.id === 'api')!;
    const dbMod = modules.find((m) => m.id === 'db')!;

    expect(apiMod.depends_on).toContain('db');
    expect(dbMod.depended_by).toContain('api');
  });

  it('includes struct_hash on each module', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'A', filePath: 'api/a.go', isExported: true } },
    ];

    const modules = compileModules(nodes, [], []);
    expect(modules[0].struct_hash).toBeDefined();
    expect(modules[0].struct_hash.length).toBe(8);
  });

  it('handles root-level files (no subdirectory)', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'Main', filePath: 'main.go', isExported: true } },
    ];

    const modules = compileModules(nodes, [], []);
    expect(modules).toHaveLength(1);
    expect(modules[0].id).toBe('_root');
  });

  it('deduplicates files in module', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'A', filePath: 'api/handler.go', isExported: true } },
      { id: 'f2', label: 'Method', properties: { name: 'B', filePath: 'api/handler.go', isExported: true } },
    ];

    const modules = compileModules(nodes, [], []);
    expect(modules[0].files).toEqual(['api/handler.go']); // deduplicated
  });

  it('sorts modules alphabetically', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'A', filePath: 'zzz/a.go', isExported: true } },
      { id: 'f2', label: 'Function', properties: { name: 'B', filePath: 'aaa/b.go', isExported: true } },
    ];

    const modules = compileModules(nodes, [], []);
    expect(modules[0].id).toBe('aaa');
    expect(modules[1].id).toBe('zzz');
  });

  it('splits large modules using community data', () => {
    // Generate 60 nodes in cli/ — above the 50-file threshold
    const nodes: GraphNode[] = [];
    const commAMembers: string[] = [];
    const commBMembers: string[] = [];

    for (let i = 0; i < 30; i++) {
      const id = `transport_${i}`;
      nodes.push({
        id,
        label: 'Function',
        properties: { name: `DeliverMessage${i}`, filePath: `cli/transport_${i}.go`, isExported: true },
      });
      commAMembers.push(id);
    }
    for (let i = 0; i < 30; i++) {
      const id = `control_${i}`;
      nodes.push({
        id,
        label: 'Function',
        properties: { name: `ControlState${i}`, filePath: `cli/control_${i}.go`, isExported: true },
      });
      commBMembers.push(id);
    }

    const communities: CommunityData[] = [
      { id: 'comm_0', label: 'Transport', symbolCount: 30, cohesion: 0.8, members: commAMembers },
      { id: 'comm_1', label: 'Control', symbolCount: 30, cohesion: 0.7, members: commBMembers },
    ];

    const modules = compileModules(nodes, [], communities);

    // Should NOT have a single "cli" module — should be split
    expect(modules.find((m) => m.id === 'cli')).toBeUndefined();
    // Should have sub-modules under cli/
    expect(modules.length).toBe(2);
    expect(modules.every((m) => m.id.startsWith('cli/'))).toBe(true);
    // Each sub-module should have 30 files
    expect(modules[0].files).toHaveLength(30);
    expect(modules[1].files).toHaveLength(30);
  });

  it('does not split small modules even with communities', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'A', filePath: 'api/a.go', isExported: true } },
      { id: 'f2', label: 'Function', properties: { name: 'B', filePath: 'api/b.go', isExported: true } },
    ];
    const communities: CommunityData[] = [
      { id: 'comm_0', label: 'Test', symbolCount: 2, cohesion: 1.0, members: ['f1', 'f2'] },
    ];

    const modules = compileModules(nodes, [], communities);
    expect(modules).toHaveLength(1);
    expect(modules[0].id).toBe('api');
  });

  it('assigns uncovered nodes by word root instead of misc bucket', () => {
    const nodes: GraphNode[] = [];
    const commMembers: string[] = [];

    // 40 nodes in community → label "lease"
    for (let i = 0; i < 40; i++) {
      const id = `comm_node_${i}`;
      nodes.push({
        id,
        label: 'Function',
        properties: { name: `LeaseFunc${i}`, filePath: `cli/lease_${i}.go`, isExported: true },
      });
      commMembers.push(id);
    }
    // 15 nodes NOT in any community → should use own word root
    for (let i = 0; i < 15; i++) {
      nodes.push({
        id: `orphan_${i}`,
        label: 'Function',
        properties: { name: `TransportMsg${i}`, filePath: `cli/transport_${i}.go`, isExported: true },
      });
    }

    const communities: CommunityData[] = [
      { id: 'comm_0', label: 'Lease', symbolCount: 40, cohesion: 0.8, members: commMembers },
    ];

    const modules = compileModules(nodes, [], communities);
    // Uncovered nodes should be assigned to cli/transport (from word root), not cli/misc
    const transport = modules.find((m) => m.id === 'cli/transport');
    expect(transport).toBeDefined();
    expect(transport!.files).toHaveLength(15);
    // No misc bucket
    expect(modules.find((m) => m.id === 'cli/misc')).toBeUndefined();
  });

  it('merges small sub-modules into best-connected large neighbor', () => {
    const nodes: GraphNode[] = [];
    const commAMembers: string[] = [];
    const commBMembers: string[] = [];
    const smallMembers: string[] = [];

    for (let i = 0; i < 30; i++) {
      const id = `a_${i}`;
      nodes.push({ id, label: 'Function', properties: { name: `SessionFunc${i}`, filePath: `cli/session_${i}.go`, isExported: true } });
      commAMembers.push(id);
    }
    for (let i = 0; i < 30; i++) {
      const id = `b_${i}`;
      nodes.push({ id, label: 'Function', properties: { name: `ControlFunc${i}`, filePath: `cli/control_${i}.go`, isExported: true } });
      commBMembers.push(id);
    }
    for (let i = 0; i < 3; i++) {
      const id = `s_${i}`;
      nodes.push({ id, label: 'Function', properties: { name: `TinyHelper${i}`, filePath: `cli/tiny_${i}.go`, isExported: true } });
      smallMembers.push(id);
    }

    const edges: GraphEdge[] = [];
    // 5 edges small→A, 1 edge small→B
    for (let i = 0; i < 5; i++) edges.push({ sourceId: smallMembers[i % 3], targetId: commAMembers[i], type: 'CALLS', confidence: 0.9 });
    edges.push({ sourceId: smallMembers[0], targetId: commBMembers[0], type: 'CALLS', confidence: 0.9 });

    const communities: CommunityData[] = [
      { id: 'comm_0', label: 'Session', symbolCount: 30, cohesion: 0.8, members: commAMembers },
      { id: 'comm_1', label: 'Control', symbolCount: 30, cohesion: 0.7, members: commBMembers },
      { id: 'comm_2', label: 'Tiny', symbolCount: 3, cohesion: 0.5, members: smallMembers },
    ];

    const modules = compileModules(nodes, edges, communities);
    // Small should merge into session (more edges to A)
    expect(modules.find((m) => m.id === 'cli/tiny')).toBeUndefined();
    const session = modules.find((m) => m.id === 'cli/session');
    expect(session).toBeDefined();
    expect(session!.files).toContain('cli/tiny_0.go');
  });

  it('generates sub-module labels from member function names', () => {
    const nodes: GraphNode[] = [];
    const commMembers: string[] = [];

    for (let i = 0; i < 55; i++) {
      const id = `node_${i}`;
      nodes.push({
        id,
        label: 'Function',
        properties: { name: `DeliverInbox${i}`, filePath: `cli/file_${i}.go`, isExported: true },
      });
      commMembers.push(id);
    }

    const communities: CommunityData[] = [
      { id: 'comm_0', label: 'Cli', symbolCount: 55, cohesion: 0.8, members: commMembers },
    ];

    const modules = compileModules(nodes, [], communities);
    // Label should be derived from function names, not the generic community label
    // "deliver" and "inbox" are common words; the most frequent should win
    expect(modules.some((m) => m.id.startsWith('cli/'))).toBe(true);
    // Should not contain generic "cli/cli" or "cli/cluster"
    expect(modules.find((m) => m.id === 'cli/cli')).toBeUndefined();
  });
});

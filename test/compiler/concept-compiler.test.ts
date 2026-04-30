import { describe, it, expect } from 'vitest';
import { compileConcepts } from '../../src/compiler/concept-compiler.js';
import type { GraphNode } from '../../src/core/export/json-exporter.js';
import type { ModuleNode } from '../../src/store/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTypeNode(
  id: string,
  name: string,
  filePath: string,
  label: 'Class' | 'Interface' | 'Struct' | 'Enum' | 'Type' = 'Struct',
  isExported = true,
): GraphNode {
  return { id, label, properties: { name, filePath, isExported } };
}

function makeModule(id: string, files: string[]): ModuleNode {
  return {
    id,
    canonical_entry: '',
    files,
    depends_on: [],
    depended_by: [],
    struct_hash: 'aaaaaaaa',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compileConcepts', () => {
  it('extracts a concept that appears in ≥ 3 distinct symbols', () => {
    // "inbox" appears in 3 distinct symbol names
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'InboxMessage', 'control/inbox.go'),
      makeTypeNode('n2', 'MasterInbox', 'control/master.go'),
      makeTypeNode('n3', 'InboxCursor', 'control/cursor.go'),
    ];

    const concepts = compileConcepts(nodes, []);

    const inbox = concepts.find((c) => c.id === 'inbox');
    expect(inbox).toBeDefined();
    expect(inbox!.appears_in).toContain('control/inbox.go');
    expect(inbox!.appears_in).toContain('control/master.go');
    expect(inbox!.appears_in).toContain('control/cursor.go');
  });

  it('does not extract a word appearing in fewer than 3 symbols', () => {
    // "session" appears in only 2 symbols
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'SessionId', 'sessions/id.go'),
      makeTypeNode('n2', 'SessionState', 'sessions/state.go'),
      makeTypeNode('n3', 'RunConfig', 'run/config.go'), // unrelated
    ];

    const concepts = compileConcepts(nodes, []);
    expect(concepts.find((c) => c.id === 'session')).toBeUndefined();
  });

  it('filters out noise words even when they exceed threshold', () => {
    // "handler" is in the noise list — should not become a concept
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'RequestHandler', 'api/req.go'),
      makeTypeNode('n2', 'ErrorHandler', 'api/err.go'),
      makeTypeNode('n3', 'MessageHandler', 'api/msg.go'),
    ];

    const concepts = compileConcepts(nodes, []);
    expect(concepts.find((c) => c.id === 'handler')).toBeUndefined();
  });

  it('filters out "error" as a noise word', () => {
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'ParseError', 'parse/err.go'),
      makeTypeNode('n2', 'NetworkError', 'net/err.go'),
      makeTypeNode('n3', 'ValidationError', 'validate/err.go'),
    ];

    const concepts = compileConcepts(nodes, []);
    expect(concepts.find((c) => c.id === 'error')).toBeUndefined();
  });

  it('assigns concept to the module where it appears most frequently', () => {
    // "message" appears 2× in "transport", 1× in "control" → layer = "transport"
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'InboxMessage', 'transport/inbox.go'),
      makeTypeNode('n2', 'OutboxMessage', 'transport/outbox.go'),
      makeTypeNode('n3', 'NudgeMessage', 'control/nudge.go'),
    ];
    const modules: ModuleNode[] = [
      makeModule('transport', ['transport/inbox.go', 'transport/outbox.go']),
      makeModule('control', ['control/nudge.go']),
    ];

    const concepts = compileConcepts(nodes, modules);
    const msg = concepts.find((c) => c.id === 'message');
    expect(msg).toBeDefined();
    expect(msg!.layer).toBe('transport');
  });

  it('generates camelCase, snake_case, and kebab-case aliases', () => {
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'LeaseRecord', 'lease/record.go'),
      makeTypeNode('n2', 'LeaseToken', 'lease/token.go'),
      makeTypeNode('n3', 'ActiveLease', 'lease/active.go'),
    ];

    const concepts = compileConcepts(nodes, []);
    const lease = concepts.find((c) => c.id === 'lease');
    expect(lease).toBeDefined();
    expect(lease!.aliases).toContain('Lease'); // CamelCase
    expect(lease!.aliases).toContain('lease'); // snake/kebab (same for single word)
  });

  it('computes struct_hash as 8 hex characters', () => {
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'RunContext', 'run/ctx.go'),
      makeTypeNode('n2', 'RunState', 'run/state.go'),
      makeTypeNode('n3', 'RunSpec', 'run/spec.go'),
    ];

    const concepts = compileConcepts(nodes, []);
    for (const c of concepts) {
      expect(c.struct_hash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('returns empty array for empty input', () => {
    expect(compileConcepts([], [])).toEqual([]);
  });

  it('sorts concepts alphabetically by id', () => {
    // Seed: "state" and "run" each appear ≥ 3 times
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'RunState', 'run/state.go'),
      makeTypeNode('n2', 'RunSpec', 'run/spec.go'),
      makeTypeNode('n3', 'RunConfig', 'run/cfg.go'),
      makeTypeNode('n4', 'StateStore', 'state/store.go'),
      makeTypeNode('n5', 'StateMachine', 'state/machine.go'),
      makeTypeNode('n6', 'StateTransition', 'state/transition.go'),
    ];

    const concepts = compileConcepts(nodes, []);
    const ids = concepts.map((c) => c.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('ignores unexported type nodes', () => {
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'InboxMessage', 'control/inbox.go', 'Struct', false),
      makeTypeNode('n2', 'MasterInbox', 'control/master.go', 'Struct', false),
      makeTypeNode('n3', 'InboxCursor', 'control/cursor.go', 'Struct', false),
    ];

    expect(compileConcepts(nodes, [])).toEqual([]);
  });

  it('extracts concepts from exported Function names', () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Function', properties: { name: 'HandleInbox', filePath: 'control/handle.go', isExported: true } },
      { id: 'f2', label: 'Function', properties: { name: 'FlushInbox', filePath: 'control/flush.go', isExported: true } },
      { id: 'f3', label: 'Function', properties: { name: 'ReadInbox', filePath: 'control/read.go', isExported: true } },
    ];

    const concepts = compileConcepts(nodes, []);
    const inbox = concepts.find((c) => c.id === 'inbox');
    expect(inbox).toBeDefined();
    expect(inbox!.appears_in).toHaveLength(3);
  });

  it('extracts concepts at threshold 2 when configured', () => {
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'SessionId', 'sessions/id.go'),
      makeTypeNode('n2', 'SessionState', 'sessions/state.go'),
    ];

    const defaultResult = compileConcepts(nodes, []);
    expect(defaultResult.find((c) => c.id === 'session')).toBeUndefined();

    const lowThresholdResult = compileConcepts(nodes, [], { minSymbolCount: 2 });
    expect(lowThresholdResult.find((c) => c.id === 'session')).toBeDefined();
  });

  it('deduplicates file paths per concept', () => {
    // Two symbols in the same file: appears_in should list it once
    const nodes: GraphNode[] = [
      makeTypeNode('n1', 'InboxMessage', 'control/inbox.go'),
      makeTypeNode('n2', 'InboxCursor', 'control/inbox.go'),
      makeTypeNode('n3', 'MasterInbox', 'control/master.go'),
    ];

    const concepts = compileConcepts(nodes, []);
    const inbox = concepts.find((c) => c.id === 'inbox');
    expect(inbox).toBeDefined();
    const inboxGoCount = inbox!.appears_in.filter((f) => f === 'control/inbox.go').length;
    expect(inboxGoCount).toBe(1);
  });
});

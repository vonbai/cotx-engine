import { describe, it, expect } from 'vitest';
import { compileFlows } from '../../src/compiler/flow-compiler.js';
import type { GraphNode, ProcessData } from '../../src/core/export/json-exporter.js';
import type { ModuleNode } from '../../src/store/schema.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeNode(id: string, name: string, filePath: string): GraphNode {
  return { id, label: 'Function', properties: { name, filePath } };
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

function makeProcess(
  id: string,
  entryPointId: string,
  steps: Array<{ nodeId: string; step: number }>,
): ProcessData {
  return {
    id,
    label: id,
    processType: 'execution',
    stepCount: steps.length,
    communities: [],
    entryPointId,
    terminalId: steps[steps.length - 1]?.nodeId ?? '',
    steps,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('compileFlows', () => {
  it('maps a process with 3 steps across 2 modules to a flow with correct step.module assignments', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'handleLogin', 'auth/login.go'),
      makeNode('n2', 'validateCreds', 'auth/validate.go'),
      makeNode('n3', 'createSession', 'session/create.go'),
    ];
    const modules: ModuleNode[] = [
      makeModule('auth', ['auth/login.go', 'auth/validate.go']),
      makeModule('session', ['session/create.go']),
    ];
    const processes: ProcessData[] = [
      makeProcess('proc_handleLogin_createSession', 'n1', [
        { nodeId: 'n1', step: 1 },
        { nodeId: 'n2', step: 2 },
        { nodeId: 'n3', step: 3 },
      ]),
    ];

    const flows = compileFlows(processes, nodes, modules);

    expect(flows).toHaveLength(1);
    const flow = flows[0];
    expect(flow.steps).toHaveLength(3);
    expect(flow.steps![0]).toMatchObject({ module: 'auth', function: 'handleLogin' });
    expect(flow.steps![1]).toMatchObject({ module: 'auth', function: 'validateCreds' });
    expect(flow.steps![2]).toMatchObject({ module: 'session', function: 'createSession' });
  });

  it('resolves trigger to function name, not raw nodeId', () => {
    const nodes: GraphNode[] = [
      makeNode('node_abc', 'startFlow', 'api/entry.go'),
    ];
    const modules: ModuleNode[] = [makeModule('api', ['api/entry.go'])];
    const processes: ProcessData[] = [
      makeProcess('proc_startFlow', 'node_abc', [{ nodeId: 'node_abc', step: 1 }]),
    ];

    const flows = compileFlows(processes, nodes, modules);

    expect(flows[0].trigger).toBe('startFlow');
    expect(flows[0].trigger).not.toBe('node_abc');
  });

  it('orders steps by step number regardless of input order', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'first', 'mod/a.go'),
      makeNode('n2', 'second', 'mod/b.go'),
      makeNode('n3', 'third', 'mod/c.go'),
    ];
    const modules: ModuleNode[] = [makeModule('mod', ['mod/a.go', 'mod/b.go', 'mod/c.go'])];
    const processes: ProcessData[] = [
      makeProcess('proc_ordered', 'n1', [
        { nodeId: 'n3', step: 3 },
        { nodeId: 'n1', step: 1 },
        { nodeId: 'n2', step: 2 },
      ]),
    ];

    const flows = compileFlows(processes, nodes, modules);

    const funcs = flows[0].steps!.map((s) => s.function);
    expect(funcs).toEqual(['first', 'second', 'third']);
  });

  it('produces an 8-character struct_hash', () => {
    const nodes: GraphNode[] = [makeNode('n1', 'doSomething', 'lib/do.go')];
    const modules: ModuleNode[] = [makeModule('lib', ['lib/do.go'])];
    const processes: ProcessData[] = [
      makeProcess('proc_doSomething', 'n1', [{ nodeId: 'n1', step: 1 }]),
    ];

    const flows = compileFlows(processes, nodes, modules);

    expect(flows[0].struct_hash).toHaveLength(8);
  });

  it('always sets type to "flow"', () => {
    const nodes: GraphNode[] = [makeNode('n1', 'entry', 'core/entry.go')];
    const modules: ModuleNode[] = [makeModule('core', ['core/entry.go'])];
    const processes: ProcessData[] = [
      makeProcess('proc_entry', 'n1', [{ nodeId: 'n1', step: 1 }]),
    ];

    const flows = compileFlows(processes, nodes, modules);

    expect(flows[0].type).toBe('flow');
  });

  it('leaves action field undefined on each step (reserved for LLM enrichment)', () => {
    const nodes: GraphNode[] = [
      makeNode('n1', 'alpha', 'svc/alpha.go'),
      makeNode('n2', 'beta', 'svc/beta.go'),
    ];
    const modules: ModuleNode[] = [makeModule('svc', ['svc/alpha.go', 'svc/beta.go'])];
    const processes: ProcessData[] = [
      makeProcess('proc_ab', 'n1', [
        { nodeId: 'n1', step: 1 },
        { nodeId: 'n2', step: 2 },
      ]),
    ];

    const flows = compileFlows(processes, nodes, modules);

    for (const step of flows[0].steps!) {
      expect(step.action).toBeUndefined();
    }
  });

  it('returns an empty array when given no processes', () => {
    const nodes: GraphNode[] = [makeNode('n1', 'unused', 'x/y.go')];
    const modules: ModuleNode[] = [makeModule('x', ['x/y.go'])];

    const flows = compileFlows([], nodes, modules);

    expect(flows).toEqual([]);
  });

  it('uses "unknown" for module and function when nodeId is not in the graph', () => {
    const nodes: GraphNode[] = [makeNode('n1', 'knownEntry', 'pkg/entry.go')];
    const modules: ModuleNode[] = [makeModule('pkg', ['pkg/entry.go'])];
    const processes: ProcessData[] = [
      makeProcess('proc_ghost', 'n1', [
        { nodeId: 'n1', step: 1 },
        { nodeId: 'ghost_node', step: 2 }, // not in nodes or modules
      ]),
    ];

    const flows = compileFlows(processes, nodes, modules);

    const ghostStep = flows[0].steps![1];
    expect(ghostStep.module).toBe('unknown');
    expect(ghostStep.function).toBe('unknown');
  });
});

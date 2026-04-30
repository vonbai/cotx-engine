import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { buildDecisionInputs } from '../../src/compiler/decision-inputs.js';
import type { GraphNode, GraphEdge, ProcessData } from '../../src/core/export/json-exporter.js';
import type { ModuleNode, ContractNode, FlowNode } from '../../src/store/schema.js';

describe('buildDecisionInputs', () => {
  it('builds stable function-level mappings from graph, process, flow, and contract data', () => {
    const nodes: GraphNode[] = [
      {
        id: 'fn:api.runApi',
        label: 'Function',
        properties: {
          name: 'runApi',
          filePath: 'src/api/main.ts',
          isExported: true,
          language: 'typescript',
        },
      },
      {
        id: 'fn:api.handleSave',
        label: 'Function',
        properties: {
          name: 'handleSave',
          filePath: 'src/api/handler.ts',
          isExported: false,
          language: 'typescript',
        },
      },
      {
        id: 'fn:db.saveState',
        label: 'Function',
        properties: {
          name: 'saveState',
          filePath: 'src/db/store.ts',
          isExported: true,
          language: 'typescript',
        },
      },
    ];

    const edges: GraphEdge[] = [
      { sourceId: 'fn:api.runApi', targetId: 'fn:api.handleSave', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:api.handleSave', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
    ];

    const processes: ProcessData[] = [
      {
        id: 'proc_run_api',
        label: 'run api',
        processType: 'cross_community',
        stepCount: 3,
        communities: [],
        entryPointId: 'fn:api.runApi',
        terminalId: 'fn:db.saveState',
        steps: [
          { nodeId: 'fn:api.runApi', step: 1 },
          { nodeId: 'fn:api.handleSave', step: 2 },
          { nodeId: 'fn:db.saveState', step: 3 },
        ],
      },
    ];

    const modules: ModuleNode[] = [
      {
        id: 'api',
        canonical_entry: 'src/api/main.ts:runApi',
        files: ['src/api/main.ts', 'src/api/handler.ts'],
        depends_on: ['db'],
        depended_by: [],
        struct_hash: 'mod-api',
      },
      {
        id: 'db',
        canonical_entry: 'src/db/store.ts:saveState',
        files: ['src/db/store.ts'],
        depends_on: [],
        depended_by: ['api'],
        struct_hash: 'mod-db',
      },
    ];

    const contracts: ContractNode[] = [
      {
        id: 'api--db',
        provider: 'db',
        consumer: 'api',
        interface: ['saveState'],
        struct_hash: 'contract',
      },
    ];

    const flows: FlowNode[] = [
      {
        id: 'proc_run_api',
        type: 'flow',
        trigger: 'runApi',
        steps: [
          { module: 'api', function: 'runApi' },
          { module: 'api', function: 'handleSave' },
          { module: 'db', function: 'saveState' },
        ],
        struct_hash: 'flow',
      },
    ];

    const inputs = buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });

    expect(inputs.functions).toHaveLength(3);
    expect(inputs.entry_points).toContain('fn:api.runApi');
    expect(inputs.function_calls).toContainEqual({ from: 'fn:api.handleSave', to: 'fn:db.saveState' });

    const saveState = inputs.functions.find((fn) => fn.id === 'fn:db.saveState');
    expect(saveState?.module_id).toBe('db');
    expect(saveState?.caller_ids).toEqual(['fn:api.handleSave']);
    expect(saveState?.contract_ids).toContain('api--db');

    const handleSave = inputs.functions.find((fn) => fn.id === 'fn:api.handleSave');
    expect(handleSave?.contract_ids).toContain('api--db');
    expect(handleSave?.process_ids).toContain('proc_run_api');
    expect(inputs.functions_by_module.api).toEqual(['fn:api.handleSave', 'fn:api.runApi']);
  });

  it('filters test-only functions out of decision inputs and entry points', () => {
    const nodes: GraphNode[] = [
      {
        id: 'fn:prod.runApi',
        label: 'Function',
        properties: {
          name: 'runApi',
          filePath: 'src/api/main.ts',
          isExported: true,
          language: 'typescript',
        },
      },
      {
        id: 'fn:test.shouldRunApi',
        label: 'Function',
        properties: {
          name: 'shouldRunApi',
          filePath: 'src/api/main.test.ts',
          isExported: true,
          language: 'typescript',
        },
      },
      {
        id: 'fn:rootTest.testAgent',
        label: 'Function',
        properties: {
          name: 'testAgent',
          filePath: 'tests/api/test_agent.py',
          isExported: true,
          language: 'python',
        },
      },
    ];
    const edges: GraphEdge[] = [];
    const processes: ProcessData[] = [];
    const modules: ModuleNode[] = [
      {
        id: 'api',
        canonical_entry: 'src/api/main.ts:runApi',
        files: ['src/api/main.ts', 'src/api/main.test.ts'],
        depends_on: [],
        depended_by: [],
        struct_hash: 'api',
      },
    ];
    const contracts: ContractNode[] = [];
    const flows: FlowNode[] = [];

    const inputs = buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });

    expect(inputs.functions.map((fn) => fn.id)).toEqual(['fn:prod.runApi']);
    expect(inputs.entry_points).not.toContain('fn:test.shouldRunApi');
    expect(inputs.entry_points).not.toContain('fn:rootTest.testAgent');
  });

  it('indexes contract lookups for large decision input sets', () => {
    const count = 4_000;
    const nodes: GraphNode[] = [
      {
        id: 'fn:api.dispatch',
        label: 'Function',
        properties: {
          name: 'dispatch',
          filePath: 'src/api/main.ts',
          isExported: true,
          language: 'typescript',
        },
      },
      {
        id: 'fn:db.saveState',
        label: 'Function',
        properties: {
          name: 'saveState',
          filePath: 'src/db/store.ts',
          isExported: true,
          language: 'typescript',
        },
      },
      ...Array.from({ length: count }, (_, index) => ({
        id: `fn:api.helper${index}`,
        label: 'Function' as const,
        properties: {
          name: `helper${index}`,
          filePath: 'src/api/main.ts',
          isExported: false,
          language: 'typescript',
        },
      })),
    ];
    const edges: GraphEdge[] = [
      { sourceId: 'fn:api.dispatch', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
    ];
    const processes: ProcessData[] = [];
    const modules: ModuleNode[] = [
      {
        id: 'api',
        canonical_entry: 'src/api/main.ts:dispatch',
        files: ['src/api/main.ts'],
        depends_on: ['db'],
        depended_by: [],
        struct_hash: 'api',
      },
      {
        id: 'db',
        canonical_entry: 'src/db/store.ts:saveState',
        files: ['src/db/store.ts'],
        depends_on: [],
        depended_by: ['api'],
        struct_hash: 'db',
      },
    ];
    const contracts: ContractNode[] = [
      {
        id: 'api--db',
        provider: 'db',
        consumer: 'api',
        interface: ['saveState'],
        struct_hash: 'contract',
      },
      ...Array.from({ length: count }, (_, index) => ({
        id: `irrelevant-${index}`,
        provider: 'db',
        consumer: 'api',
        interface: [`unused${index}`],
        struct_hash: `irrelevant-${index}`,
      })),
    ];
    const flows: FlowNode[] = [];

    const started = performance.now();
    const inputs = buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });
    const elapsed = performance.now() - started;

    expect(inputs.functions).toHaveLength(count + 2);
    expect(inputs.functions.find((fn) => fn.id === 'fn:api.dispatch')?.contract_ids).toEqual(['api--db']);
    expect(inputs.functions.find((fn) => fn.id === 'fn:db.saveState')?.contract_ids).toEqual(['api--db']);
    expect(elapsed).toBeLessThan(750);
  });
});

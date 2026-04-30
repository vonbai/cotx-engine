import { describe, it, expect } from 'vitest';
import { buildDecisionInputs } from '../../src/compiler/decision-inputs.js';
import { buildConcernFamilies } from '../../src/compiler/concern-family-builder.js';
import type { GraphNode, GraphEdge, ProcessData } from '../../src/core/export/json-exporter.js';
import type { ModuleNode, ContractNode, FlowNode } from '../../src/store/schema.js';

function makeFixture() {
  const nodes: GraphNode[] = [
    { id: 'fn:api.runSaveUser', label: 'Function', properties: { name: 'runSaveUser', filePath: 'src/api/user.ts', isExported: true, language: 'typescript' } },
    { id: 'fn:svc.prepareUser', label: 'Function', properties: { name: 'prepareUser', filePath: 'src/service/user.ts', isExported: false, language: 'typescript' } },
    { id: 'fn:db.saveUser', label: 'Function', properties: { name: 'saveUser', filePath: 'src/db/user-store.ts', isExported: true, language: 'typescript' } },
    { id: 'fn:api.runSaveAdmin', label: 'Function', properties: { name: 'runSaveAdmin', filePath: 'src/api/admin.ts', isExported: true, language: 'typescript' } },
    { id: 'fn:svc.prepareAdmin', label: 'Function', properties: { name: 'prepareAdmin', filePath: 'src/service/admin.ts', isExported: false, language: 'typescript' } },
    { id: 'fn:db.saveAdmin', label: 'Function', properties: { name: 'saveAdmin', filePath: 'src/db/admin-store.ts', isExported: true, language: 'typescript' } },
  ];

  const edges: GraphEdge[] = [
    { sourceId: 'fn:api.runSaveUser', targetId: 'fn:svc.prepareUser', type: 'CALLS', confidence: 1 },
    { sourceId: 'fn:svc.prepareUser', targetId: 'fn:db.saveUser', type: 'CALLS', confidence: 1 },
    { sourceId: 'fn:api.runSaveAdmin', targetId: 'fn:svc.prepareAdmin', type: 'CALLS', confidence: 1 },
    { sourceId: 'fn:svc.prepareAdmin', targetId: 'fn:db.saveAdmin', type: 'CALLS', confidence: 1 },
  ];

  const processes: ProcessData[] = [
    {
      id: 'proc_save_user',
      label: 'save user',
      processType: 'cross_community',
      stepCount: 3,
      communities: [],
      entryPointId: 'fn:api.runSaveUser',
      terminalId: 'fn:db.saveUser',
      steps: [
        { nodeId: 'fn:api.runSaveUser', step: 1 },
        { nodeId: 'fn:svc.prepareUser', step: 2 },
        { nodeId: 'fn:db.saveUser', step: 3 },
      ],
    },
    {
      id: 'proc_save_admin',
      label: 'save admin',
      processType: 'cross_community',
      stepCount: 3,
      communities: [],
      entryPointId: 'fn:api.runSaveAdmin',
      terminalId: 'fn:db.saveAdmin',
      steps: [
        { nodeId: 'fn:api.runSaveAdmin', step: 1 },
        { nodeId: 'fn:svc.prepareAdmin', step: 2 },
        { nodeId: 'fn:db.saveAdmin', step: 3 },
      ],
    },
  ];

  const modules: ModuleNode[] = [
    { id: 'api', canonical_entry: 'src/api/user.ts:runSaveUser', files: ['src/api/user.ts', 'src/api/admin.ts'], depends_on: ['service'], depended_by: [], struct_hash: 'api' },
    { id: 'service', canonical_entry: '', files: ['src/service/user.ts', 'src/service/admin.ts'], depends_on: ['db'], depended_by: ['api'], struct_hash: 'service' },
    { id: 'db', canonical_entry: 'src/db/user-store.ts:saveUser', files: ['src/db/user-store.ts', 'src/db/admin-store.ts'], depends_on: [], depended_by: ['service'], struct_hash: 'db' },
  ];

  const contracts: ContractNode[] = [
    { id: 'service--db', provider: 'db', consumer: 'service', interface: ['saveUser', 'saveAdmin'], struct_hash: 'service-db' },
  ];

  const flows: FlowNode[] = [
    { id: 'proc_save_user', type: 'flow', trigger: 'runSaveUser', steps: [{ module: 'api', function: 'runSaveUser' }, { module: 'service', function: 'prepareUser' }, { module: 'db', function: 'saveUser' }], struct_hash: 'flow-user' },
    { id: 'proc_save_admin', type: 'flow', trigger: 'runSaveAdmin', steps: [{ module: 'api', function: 'runSaveAdmin' }, { module: 'service', function: 'prepareAdmin' }, { module: 'db', function: 'saveAdmin' }], struct_hash: 'flow-admin' },
  ];

  return buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });
}

describe('buildConcernFamilies', () => {
  it('groups same-kind flow paths into a concern family and emits operation units', () => {
    const result = buildConcernFamilies(makeFixture());

    expect(result.families).toHaveLength(1);
    expect(result.families[0].verb_roots).toContain('save');
    expect(result.families[0].member_paths).toHaveLength(2);
    expect(result.path_instances).toHaveLength(2);
    expect(result.operation_units.some((unit) => unit.symbol === 'saveUser')).toBe(true);
    expect(result.operation_units.some((unit) => unit.symbol === 'saveAdmin')).toBe(true);
  });

  it('falls back to function call paths when no compiled flows are present', () => {
    const nodes: GraphNode[] = [
      { id: 'fn:api.saveUser', label: 'Function', properties: { name: 'saveUser', filePath: 'api/user.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:service.prepareUser', label: 'Function', properties: { name: 'prepareUser', filePath: 'service/user.ts', isExported: false, language: 'typescript' } },
      { id: 'fn:db.saveState', label: 'Function', properties: { name: 'saveState', filePath: 'db/store.ts', isExported: true, language: 'typescript' } },
    ];
    const edges: GraphEdge[] = [
      { sourceId: 'fn:api.saveUser', targetId: 'fn:service.prepareUser', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:service.prepareUser', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
    ];
    const processes: ProcessData[] = [];
    const modules: ModuleNode[] = [
      { id: 'api', canonical_entry: 'api/user.ts:saveUser', files: ['api/user.ts'], depends_on: ['service'], depended_by: [], struct_hash: 'api' },
      { id: 'service', canonical_entry: '', files: ['service/user.ts'], depends_on: ['db'], depended_by: ['api'], struct_hash: 'service' },
      { id: 'db', canonical_entry: 'db/store.ts:saveState', files: ['db/store.ts'], depends_on: [], depended_by: ['service'], struct_hash: 'db' },
    ];
    const contracts: ContractNode[] = [{ id: 'service--db', provider: 'db', consumer: 'service', interface: ['saveState'], struct_hash: 'service-db' }];
    const flows: FlowNode[] = [];

    const inputs = buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });
    const result = buildConcernFamilies(inputs);

    expect(result.families.length).toBeGreaterThan(0);
    expect(result.path_instances.some((path) => path.entry_symbol === 'saveUser')).toBe(true);
  });
});

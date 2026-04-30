import { describe, it, expect } from 'vitest';
import { buildDecisionInputs } from '../../src/compiler/decision-inputs.js';
import { buildConcernFamilies } from '../../src/compiler/concern-family-builder.js';
import { buildSymmetryEdges } from '../../src/compiler/symmetry-engine.js';
import type { GraphNode, GraphEdge, ProcessData } from '../../src/core/export/json-exporter.js';
import type { ModuleNode, ContractNode, FlowNode } from '../../src/store/schema.js';

describe('buildSymmetryEdges', () => {
  it('emits a hard symmetry edge for sibling handlers in the same concern family', () => {
    const nodes: GraphNode[] = [
      { id: 'fn:api.handleCreateUser', label: 'Function', properties: { name: 'handleCreateUser', filePath: 'src/api/user.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:svc.validateUser', label: 'Function', properties: { name: 'validateUser', filePath: 'src/service/user.ts', isExported: false, language: 'typescript' } },
      { id: 'fn:db.saveState', label: 'Function', properties: { name: 'saveState', filePath: 'src/db/state.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:api.handleCreateAdmin', label: 'Function', properties: { name: 'handleCreateAdmin', filePath: 'src/api/admin.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:svc.validateAdmin', label: 'Function', properties: { name: 'validateAdmin', filePath: 'src/service/admin.ts', isExported: false, language: 'typescript' } },
    ];
    const edges: GraphEdge[] = [
      { sourceId: 'fn:api.handleCreateUser', targetId: 'fn:svc.validateUser', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:svc.validateUser', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:api.handleCreateAdmin', targetId: 'fn:svc.validateAdmin', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:svc.validateAdmin', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
    ];
    const processes: ProcessData[] = [
      { id: 'proc_create_user', label: 'create user', processType: 'cross_community', stepCount: 3, communities: [], entryPointId: 'fn:api.handleCreateUser', terminalId: 'fn:db.saveState', steps: [{ nodeId: 'fn:api.handleCreateUser', step: 1 }, { nodeId: 'fn:svc.validateUser', step: 2 }, { nodeId: 'fn:db.saveState', step: 3 }] },
      { id: 'proc_create_admin', label: 'create admin', processType: 'cross_community', stepCount: 3, communities: [], entryPointId: 'fn:api.handleCreateAdmin', terminalId: 'fn:db.saveState', steps: [{ nodeId: 'fn:api.handleCreateAdmin', step: 1 }, { nodeId: 'fn:svc.validateAdmin', step: 2 }, { nodeId: 'fn:db.saveState', step: 3 }] },
    ];
    const modules: ModuleNode[] = [
      { id: 'api', canonical_entry: 'src/api/user.ts:handleCreateUser', files: ['src/api/user.ts', 'src/api/admin.ts'], depends_on: ['service'], depended_by: [], struct_hash: 'api' },
      { id: 'service', canonical_entry: '', files: ['src/service/user.ts', 'src/service/admin.ts'], depends_on: ['db'], depended_by: ['api'], struct_hash: 'service' },
      { id: 'db', canonical_entry: 'src/db/state.ts:saveState', files: ['src/db/state.ts'], depends_on: [], depended_by: ['service'], struct_hash: 'db' },
    ];
    const contracts: ContractNode[] = [{ id: 'service--db', provider: 'db', consumer: 'service', interface: ['saveState'], struct_hash: 'service-db' }];
    const flows: FlowNode[] = [
      { id: 'proc_create_user', type: 'flow', trigger: 'handleCreateUser', steps: [{ module: 'api', function: 'handleCreateUser' }, { module: 'service', function: 'validateUser' }, { module: 'db', function: 'saveState' }], struct_hash: 'flow-user' },
      { id: 'proc_create_admin', type: 'flow', trigger: 'handleCreateAdmin', steps: [{ module: 'api', function: 'handleCreateAdmin' }, { module: 'service', function: 'validateAdmin' }, { module: 'db', function: 'saveState' }], struct_hash: 'flow-admin' },
    ];

    const inputs = buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });
    const familyResult = buildConcernFamilies(inputs);
    const edgesResult = buildSymmetryEdges(familyResult);

    expect(edgesResult.some((edge) => edge.from_unit === 'api:handleCreateAdmin' && edge.to_unit === 'api:handleCreateUser' && edge.strength === 'hard')).toBe(true);
  });
});

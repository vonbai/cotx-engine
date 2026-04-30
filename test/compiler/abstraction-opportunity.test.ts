import { describe, it, expect } from 'vitest';
import { buildDecisionInputs } from '../../src/compiler/decision-inputs.js';
import { buildConcernFamilies } from '../../src/compiler/concern-family-builder.js';
import { compileCanonicalPaths } from '../../src/compiler/canonical-path-compiler.js';
import { detectAbstractionOpportunities } from '../../src/compiler/abstraction-opportunity.js';
import type { GraphNode, GraphEdge, ProcessData } from '../../src/core/export/json-exporter.js';
import type { ModuleNode, ContractNode, FlowNode } from '../../src/store/schema.js';

describe('detectAbstractionOpportunities', () => {
  it('flags repeated same-kind paths as an abstraction candidate', () => {
    const nodes: GraphNode[] = [
      { id: 'fn:api.updateUser', label: 'Function', properties: { name: 'updateUser', filePath: 'src/api/user.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:svc.validateUser', label: 'Function', properties: { name: 'validateUser', filePath: 'src/service/user.ts', isExported: false, language: 'typescript' } },
      { id: 'fn:db.saveState', label: 'Function', properties: { name: 'saveState', filePath: 'src/db/state.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:api.updateAdmin', label: 'Function', properties: { name: 'updateAdmin', filePath: 'src/api/admin.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:svc.validateAdmin', label: 'Function', properties: { name: 'validateAdmin', filePath: 'src/service/admin.ts', isExported: false, language: 'typescript' } },
      { id: 'fn:api.updateBot', label: 'Function', properties: { name: 'updateBot', filePath: 'src/api/bot.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:svc.validateBot', label: 'Function', properties: { name: 'validateBot', filePath: 'src/service/bot.ts', isExported: false, language: 'typescript' } },
    ];
    const edges: GraphEdge[] = [
      { sourceId: 'fn:api.updateUser', targetId: 'fn:svc.validateUser', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:svc.validateUser', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:api.updateAdmin', targetId: 'fn:svc.validateAdmin', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:svc.validateAdmin', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:api.updateBot', targetId: 'fn:svc.validateBot', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:svc.validateBot', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
    ];
    const processes: ProcessData[] = [
      { id: 'proc_update_user', label: 'update user', processType: 'cross_community', stepCount: 3, communities: [], entryPointId: 'fn:api.updateUser', terminalId: 'fn:db.saveState', steps: [{ nodeId: 'fn:api.updateUser', step: 1 }, { nodeId: 'fn:svc.validateUser', step: 2 }, { nodeId: 'fn:db.saveState', step: 3 }] },
      { id: 'proc_update_admin', label: 'update admin', processType: 'cross_community', stepCount: 3, communities: [], entryPointId: 'fn:api.updateAdmin', terminalId: 'fn:db.saveState', steps: [{ nodeId: 'fn:api.updateAdmin', step: 1 }, { nodeId: 'fn:svc.validateAdmin', step: 2 }, { nodeId: 'fn:db.saveState', step: 3 }] },
      { id: 'proc_update_bot', label: 'update bot', processType: 'cross_community', stepCount: 3, communities: [], entryPointId: 'fn:api.updateBot', terminalId: 'fn:db.saveState', steps: [{ nodeId: 'fn:api.updateBot', step: 1 }, { nodeId: 'fn:svc.validateBot', step: 2 }, { nodeId: 'fn:db.saveState', step: 3 }] },
    ];
    const modules: ModuleNode[] = [
      { id: 'api', canonical_entry: 'src/api/user.ts:updateUser', files: ['src/api/user.ts', 'src/api/admin.ts', 'src/api/bot.ts'], depends_on: ['service'], depended_by: [], struct_hash: 'api' },
      { id: 'service', canonical_entry: '', files: ['src/service/user.ts', 'src/service/admin.ts', 'src/service/bot.ts'], depends_on: ['db'], depended_by: ['api'], struct_hash: 'service' },
      { id: 'db', canonical_entry: 'src/db/state.ts:saveState', files: ['src/db/state.ts'], depends_on: [], depended_by: ['service'], struct_hash: 'db' },
    ];
    const contracts: ContractNode[] = [{ id: 'service--db', provider: 'db', consumer: 'service', interface: ['saveState'], struct_hash: 'service-db' }];
    const flows: FlowNode[] = [
      { id: 'proc_update_user', type: 'flow', trigger: 'updateUser', steps: [{ module: 'api', function: 'updateUser' }, { module: 'service', function: 'validateUser' }, { module: 'db', function: 'saveState' }], struct_hash: 'flow-user' },
      { id: 'proc_update_admin', type: 'flow', trigger: 'updateAdmin', steps: [{ module: 'api', function: 'updateAdmin' }, { module: 'service', function: 'validateAdmin' }, { module: 'db', function: 'saveState' }], struct_hash: 'flow-admin' },
      { id: 'proc_update_bot', type: 'flow', trigger: 'updateBot', steps: [{ module: 'api', function: 'updateBot' }, { module: 'service', function: 'validateBot' }, { module: 'db', function: 'saveState' }], struct_hash: 'flow-bot' },
    ];

    const inputs = buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });
    const familyResult = buildConcernFamilies(inputs);
    const canonicalResult = compileCanonicalPaths(inputs, familyResult);
    const opportunities = detectAbstractionOpportunities(familyResult, canonicalResult);

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].status).toBe('candidate');
    expect(opportunities[0].candidate_owning_module).toBe('api');
  });
});

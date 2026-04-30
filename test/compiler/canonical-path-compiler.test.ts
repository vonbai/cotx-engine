import { describe, it, expect } from 'vitest';
import { buildDecisionInputs } from '../../src/compiler/decision-inputs.js';
import { buildConcernFamilies } from '../../src/compiler/concern-family-builder.js';
import { compileCanonicalPaths } from '../../src/compiler/canonical-path-compiler.js';
import type { GraphNode, GraphEdge, ProcessData } from '../../src/core/export/json-exporter.js';
import type { ModuleNode, ContractNode, FlowNode } from '../../src/store/schema.js';

describe('compileCanonicalPaths', () => {
  it('selects a dominant canonical path for a repeated persistence concern', () => {
    const nodes: GraphNode[] = [
      { id: 'fn:api.saveUser', label: 'Function', properties: { name: 'saveUser', filePath: 'src/api/save-user.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:svc.validateUser', label: 'Function', properties: { name: 'validateUser', filePath: 'src/service/user.ts', isExported: false, language: 'typescript' } },
      { id: 'fn:db.saveState', label: 'Function', properties: { name: 'saveState', filePath: 'src/db/state.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:api.saveAdmin', label: 'Function', properties: { name: 'saveAdmin', filePath: 'src/api/save-admin.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:svc.validateAdmin', label: 'Function', properties: { name: 'validateAdmin', filePath: 'src/service/admin.ts', isExported: false, language: 'typescript' } },
      { id: 'fn:api.legacySaveAdmin', label: 'Function', properties: { name: 'legacySaveAdmin', filePath: 'src/api/legacy.ts', isExported: true, language: 'typescript' } },
      { id: 'fn:db.directWrite', label: 'Function', properties: { name: 'directWrite', filePath: 'src/db/direct.ts', isExported: true, language: 'typescript' } },
    ];

    const edges: GraphEdge[] = [
      { sourceId: 'fn:api.saveUser', targetId: 'fn:svc.validateUser', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:svc.validateUser', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:api.saveAdmin', targetId: 'fn:svc.validateAdmin', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:svc.validateAdmin', targetId: 'fn:db.saveState', type: 'CALLS', confidence: 1 },
      { sourceId: 'fn:api.legacySaveAdmin', targetId: 'fn:db.directWrite', type: 'CALLS', confidence: 1 },
    ];

    const processes: ProcessData[] = [
      {
        id: 'proc_save_user',
        label: 'save user',
        processType: 'cross_community',
        stepCount: 3,
        communities: [],
        entryPointId: 'fn:api.saveUser',
        terminalId: 'fn:db.saveState',
        steps: [
          { nodeId: 'fn:api.saveUser', step: 1 },
          { nodeId: 'fn:svc.validateUser', step: 2 },
          { nodeId: 'fn:db.saveState', step: 3 },
        ],
      },
      {
        id: 'proc_save_admin',
        label: 'save admin',
        processType: 'cross_community',
        stepCount: 3,
        communities: [],
        entryPointId: 'fn:api.saveAdmin',
        terminalId: 'fn:db.saveState',
        steps: [
          { nodeId: 'fn:api.saveAdmin', step: 1 },
          { nodeId: 'fn:svc.validateAdmin', step: 2 },
          { nodeId: 'fn:db.saveState', step: 3 },
        ],
      },
      {
        id: 'proc_legacy_save_admin',
        label: 'legacy save admin',
        processType: 'cross_community',
        stepCount: 2,
        communities: [],
        entryPointId: 'fn:api.legacySaveAdmin',
        terminalId: 'fn:db.directWrite',
        steps: [
          { nodeId: 'fn:api.legacySaveAdmin', step: 1 },
          { nodeId: 'fn:db.directWrite', step: 2 },
        ],
      },
    ];

    const modules: ModuleNode[] = [
      { id: 'api', canonical_entry: 'src/api/save-user.ts:saveUser', files: ['src/api/save-user.ts', 'src/api/save-admin.ts', 'src/api/legacy.ts'], depends_on: ['service', 'db'], depended_by: [], struct_hash: 'api' },
      { id: 'service', canonical_entry: '', files: ['src/service/user.ts', 'src/service/admin.ts'], depends_on: ['db'], depended_by: ['api'], struct_hash: 'service' },
      { id: 'db', canonical_entry: 'src/db/state.ts:saveState', files: ['src/db/state.ts', 'src/db/direct.ts'], depends_on: [], depended_by: ['service', 'api'], struct_hash: 'db' },
    ];

    const contracts: ContractNode[] = [
      { id: 'service--db', provider: 'db', consumer: 'service', interface: ['saveState'], struct_hash: 'service-db' },
    ];

    const flows: FlowNode[] = [
      { id: 'proc_save_user', type: 'flow', trigger: 'saveUser', steps: [{ module: 'api', function: 'saveUser' }, { module: 'service', function: 'validateUser' }, { module: 'db', function: 'saveState' }], struct_hash: 'flow-user' },
      { id: 'proc_save_admin', type: 'flow', trigger: 'saveAdmin', steps: [{ module: 'api', function: 'saveAdmin' }, { module: 'service', function: 'validateAdmin' }, { module: 'db', function: 'saveState' }], struct_hash: 'flow-admin' },
      { id: 'proc_legacy_save_admin', type: 'flow', trigger: 'legacySaveAdmin', steps: [{ module: 'api', function: 'legacySaveAdmin' }, { module: 'db', function: 'directWrite' }], struct_hash: 'flow-legacy' },
    ];

    const inputs = buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });
    const familyResult = buildConcernFamilies(inputs);
    const result = compileCanonicalPaths(inputs, familyResult);

    expect(result.canonical_paths).toHaveLength(1);
    const canonical = result.canonical_paths[0];
    expect(canonical.status).toBe('canonical');
    expect(canonical.primary_entry_symbols).toContain('saveUser');
    expect(canonical.deviations.some((item) => item.symbol === 'directWrite')).toBe(true);
    expect(result.candidate_paths).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DecisionRuleIndex,
  GraphTruthStore,
  projectDecisionFacts,
  type DecisionRuleFacts,
  type GraphFacts,
} from '../../src/store-v2/index.js';

describe('storage v2 stores', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-storage-v2-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores code facts in LadybugDB and answers graph queries', async () => {
    const store = new GraphTruthStore({ dbPath: path.join(tmpDir, 'truth.lbug') });
    await store.open();
    try {
      await store.writeFacts(sampleGraphFacts());
      await store.writeSemanticArtifacts([
        {
          id: 'api',
          layer: 'module',
          structHash: 'module-hash',
          payload: { id: 'api', canonical_entry: 'run' },
        },
      ]);

      const typedContext = await store.codeNodeContext('sym:api.handleCreateUser');
      expect(typedContext?.label).toBe('Function');
      expect(typedContext?.outgoing[0].type).toBe('CALLS');
      expect(await store.codeImpactMany(['sym:api.handleCreateUser', 'sym:svc.validateUser'], 'downstream', 2, ['CALLS'])).toEqual([
        'sym:repo.saveUser',
      ]);
      expect(await store.codeProcessesForNodes(['sym:api.handleCreateUser', 'sym:svc.validateUser'])).toEqual([
        { nodeId: 'sym:api.handleCreateUser', id: 'process:create_user', label: 'create_user', step: 1 },
        { nodeId: 'sym:svc.validateUser', id: 'process:create_user', label: 'create_user', step: 2 },
      ]);
      expect((await store.routeMap('/users'))[0].handlers[0].id).toBe('sym:api.handleCreateUser');
      expect((await store.shapeCheck('/users'))[0].missingKeys).toEqual(['missing']);
      expect((await store.toolMap('create_user'))[0].handlers[0].id).toBe('sym:api.handleCreateUser');
      expect((await store.query('MATCH (r:Route) RETURN r.id AS id'))[0].id).toBe('route:POST /users');
      expect((await store.query('MATCH (t:Tool) RETURN t.id AS id'))[0].id).toBe('tool:create_user');
      expect((await store.query('MATCH (p:Process) RETURN p.id AS id'))[0].id).toBe('process:create_user');
      expect((await store.query("MATCH (:Function)-[r:CodeRelation {type:'STEP_IN_PROCESS'}]->(:Process) RETURN count(r) AS n"))[0].n).toBe(2);
      expect(await store.listSemanticArtifacts('module')).toEqual([
        {
          id: 'api',
          layer: 'module',
          structHash: 'module-hash',
          payload: { id: 'api', canonical_entry: 'run' },
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it('stores decision facts in CozoDB and answers rule queries', async () => {
    const index = new DecisionRuleIndex({ dbPath: path.join(tmpDir, 'rules.db') });
    await index.open();
    try {
      await index.writeFacts(sampleDecisionFacts());

      expect(await index.highConfidenceCanonical(0.7)).toEqual([
        { id: 'canonical:create:repository_write', confidence: 0.82 },
      ]);
      expect(await index.canonicalForConcern('create:repository_write')).toEqual([
        {
          id: 'canonical:create:repository_write',
          owningModule: 'api',
          confidence: 0.82,
          status: 'canonical',
        },
      ]);
      expect(await index.listCanonical()).toEqual([
        {
          id: 'canonical:create:repository_write',
          familyId: 'create:repository_write',
          targetConcern: 'create:repository_write',
          owningModule: 'api',
          confidence: 0.82,
          status: 'canonical',
        },
      ]);
      expect(await index.closureFor('closure:createUser')).toEqual([
        { unitId: 'unit:api.createAdmin', confidence: 0.92, level: 'must_review' },
        { unitId: 'unit:api.createUser', confidence: 1, level: 'must_review' },
      ]);
      expect(await index.reviewFindingsForPlan('plan:canonicalize')).toEqual([
        { severity: 'high', finding: 'Patch misses createAdmin closure member' },
      ]);
      expect(await index.abstractionTargets(10)).toEqual([
        {
          abstractionId: 'abstraction:create',
          unitId: 'unit:api.createUser',
          title: 'Extract shared create helper',
        },
      ]);
    } finally {
      index.close();
    }
  });

  it('projects current decision-plane artifacts into rule facts', () => {
    const projected = projectDecisionFacts({
      canonicalPaths: [
        {
          id: 'canonical:create',
          family_id: 'create:repository_write',
          name: 'create path',
          target_concern: 'create:repository_write',
          owning_module: 'api',
          primary_entry_symbols: ['createUser'],
          path_ids: ['path-1'],
          score_breakdown: { visibility: 0.8 },
          confidence: 0.82,
          status: 'canonical',
          evidence: [],
          deviations: [],
        },
      ],
      symmetryEdges: [
        {
          id: 'symmetry:create',
          family_id: 'create:repository_write',
          from_unit: 'unit:api.createUser',
          to_unit: 'unit:api.createAdmin',
          strength: 'hard',
          score: 0.92,
          reasons: ['same family'],
          evidence: [],
        },
      ],
      closureSets: [
        {
          id: 'closure:createUser',
          target_unit: 'unit:api.createUser',
          family_id: 'create:repository_write',
          generated_at: '2026-04-12T00:00:00Z',
          members: [
            {
              unit_id: 'unit:api.createAdmin',
              level: 'must_review',
              reasons: ['same family'],
              confidence: 0.92,
              evidence: [],
            },
          ],
          evidence: [],
        },
      ],
      abstractionOpportunities: [
        {
          id: 'abstraction:create',
          title: 'Extract shared create helper',
          family_id: 'create:repository_write',
          repeated_paths: ['path-1', 'path-2'],
          candidate_units: ['unit:api.createUser', 'unit:api.createAdmin'],
          suggested_abstraction_level: 'extract_helper',
          candidate_owning_module: 'api',
          evidence: [],
          confidence: 0.8,
          status: 'recommended',
        },
      ],
    });

    expect(projected.canonical).toContainEqual({
      id: 'canonical:create',
      familyId: 'create:repository_write',
      targetConcern: 'create:repository_write',
      owningModule: 'api',
      confidence: 0.82,
      status: 'canonical',
    });
    expect(projected.symmetry).toHaveLength(1);
    expect(projected.closureMembers).toContainEqual({
      closureId: 'closure:createUser',
      unitId: 'unit:api.createAdmin',
      level: 'must_review',
      confidence: 0.92,
      reasons: 'same family',
    });
    expect(projected.abstractionUnits).toHaveLength(2);
  });
});

function sampleGraphFacts(): GraphFacts {
  return {
    codeNodes: [
      {
        id: 'sym:api.handleCreateUser',
        label: 'Function',
        name: 'handleCreateUser',
        filePath: 'src/api/user.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
        properties: JSON.stringify({ name: 'handleCreateUser', filePath: 'src/api/user.ts' }),
      },
      {
        id: 'sym:svc.validateUser',
        label: 'Function',
        name: 'validateUser',
        filePath: 'src/service/user.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
        properties: JSON.stringify({ name: 'validateUser', filePath: 'src/service/user.ts' }),
      },
      {
        id: 'sym:repo.saveUser',
        label: 'Function',
        name: 'saveUser',
        filePath: 'src/repo/user.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
        properties: JSON.stringify({ name: 'saveUser', filePath: 'src/repo/user.ts' }),
      },
      {
        id: 'route:POST /users',
        label: 'Route',
        name: '/users',
        filePath: 'src/api/user.ts',
        startLine: 1,
        endLine: 10,
        isExported: false,
        properties: JSON.stringify({ path: '/users', method: 'POST', responseKeys: ['data', 'error'], middleware: ['auth'] }),
      },
      {
        id: 'consumer:web.createUser',
        label: 'File',
        name: 'createUserForm',
        filePath: 'src/web/user.ts',
        startLine: 1,
        endLine: 10,
        isExported: false,
        properties: JSON.stringify({ name: 'createUserForm', filePath: 'src/web/user.ts' }),
      },
      {
        id: 'tool:create_user',
        label: 'Tool',
        name: 'create_user',
        filePath: 'src/mcp/tools.ts',
        startLine: 1,
        endLine: 10,
        isExported: false,
        properties: JSON.stringify({ name: 'create_user', description: 'Create a user via the API handler' }),
      },
      {
        id: 'process:create_user',
        label: 'Process',
        name: 'create_user',
        filePath: '',
        startLine: 0,
        endLine: 0,
        isExported: false,
        properties: JSON.stringify({ name: 'create_user' }),
      },
    ],
    codeRelations: [
      { from: 'sym:api.handleCreateUser', to: 'sym:svc.validateUser', type: 'CALLS', confidence: 1, reason: '', step: 0 },
      { from: 'sym:svc.validateUser', to: 'sym:repo.saveUser', type: 'CALLS', confidence: 1, reason: '', step: 0 },
      { from: 'sym:api.handleCreateUser', to: 'route:POST /users', type: 'HANDLES_ROUTE', confidence: 1, reason: 'decorator-post', step: 0 },
      { from: 'consumer:web.createUser', to: 'route:POST /users', type: 'FETCHES', confidence: 0.9, reason: 'fetch-url-match|keys:data,missing', step: 0 },
      { from: 'sym:api.handleCreateUser', to: 'tool:create_user', type: 'HANDLES_TOOL', confidence: 1, reason: 'tool-definition', step: 0 },
      { from: 'sym:api.handleCreateUser', to: 'process:create_user', type: 'STEP_IN_PROCESS', confidence: 1, reason: 'process-trace', step: 1 },
      { from: 'sym:svc.validateUser', to: 'process:create_user', type: 'STEP_IN_PROCESS', confidence: 1, reason: 'process-trace', step: 2 },
    ],
  };
}

function sampleDecisionFacts(): DecisionRuleFacts {
  return {
    canonical: [
      {
        id: 'canonical:create:repository_write',
        familyId: 'create:repository_write',
        targetConcern: 'create:repository_write',
        owningModule: 'api',
        confidence: 0.82,
        status: 'canonical',
      },
    ],
    symmetry: [
      {
        id: 'symmetry:create',
        familyId: 'create:repository_write',
        fromUnit: 'unit:api.createUser',
        toUnit: 'unit:api.createAdmin',
        strength: 'hard',
        score: 0.92,
      },
    ],
    closures: [
      { id: 'closure:createUser', targetUnit: 'unit:api.createUser', familyId: 'create:repository_write' },
    ],
    closureMembers: [
      {
        closureId: 'closure:createUser',
        unitId: 'unit:api.createUser',
        level: 'must_review',
        confidence: 1,
        reasons: 'target',
      },
      {
        closureId: 'closure:createUser',
        unitId: 'unit:api.createAdmin',
        level: 'must_review',
        confidence: 0.92,
        reasons: 'same family sibling',
      },
    ],
    abstractions: [
      {
        id: 'abstraction:create',
        familyId: 'create:repository_write',
        title: 'Extract shared create helper',
        owningModule: 'api',
        level: 'extract_helper',
        confidence: 0.8,
        status: 'recommended',
      },
    ],
    abstractionUnits: [{ abstractionId: 'abstraction:create', unitId: 'unit:api.createUser' }],
    plans: [{ id: 'plan:canonicalize', kind: 'canonicalize_path', totalScore: 0.82 }],
    reviews: [{ id: 'review:missingClosure', severity: 'high', finding: 'Patch misses createAdmin closure member' }],
    planCoversClosure: [{ from: 'plan:canonicalize', to: 'closure:createUser' }],
    reviewFlagsPlan: [{ from: 'review:missingClosure', to: 'plan:canonicalize' }],
  };
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';

describe('decision-plane store', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-decision-plane-store-'));
    store = new CotxStore(tmpDir);
    store.init('decision-plane-store');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads concern families and canonical paths', () => {
    store.writeConcernFamily({
      id: 'persistence/save',
      name: 'persistence save family',
      verb_roots: ['save', 'persist'],
      resource_roots: ['state'],
      sink_role: 'repository_write',
      entry_kinds: ['flow_trigger'],
      member_paths: ['persist:run->save'],
      evidence: [{ kind: 'flow', ref: 'flow:persist' }],
      confidence: 0.82,
      status: 'confirmed',
    });

    store.writeCanonicalPath({
      id: 'canonical/persistence-save',
      family_id: 'persistence/save',
      name: 'standard persistence path',
      target_concern: 'state_persistence',
      owning_module: 'db',
      primary_entry_symbols: ['runPersist', 'saveState'],
      path_ids: ['persist:run->save'],
      score_breakdown: {
        fan_in: 0.7,
        authority: 0.6,
        pattern_support: 0.9,
      },
      confidence: 0.88,
      status: 'canonical',
      evidence: [{ kind: 'module', ref: 'db' }],
      deviations: [
        {
          module: 'legacy',
          symbol: 'legacySave',
          missing_symbols: ['saveState'],
          reason: 'missing canonical sink',
        },
      ],
    });

    expect(store.listConcernFamilies()).toContain('persistence/save');
    expect(store.readConcernFamily('persistence/save').sink_role).toBe('repository_write');
    expect(store.listCanonicalPaths()).toContain('canonical/persistence-save');
    expect(store.readCanonicalPath('canonical/persistence-save').status).toBe('canonical');
  });

  it('writes and reads symmetry edges, closure sets, abstractions, and overrides', () => {
    store.writeSymmetryEdge({
      id: 'symmetry:handlers:create-a~create-b',
      family_id: 'handlers/create',
      from_unit: 'api:createUser',
      to_unit: 'api:createAdmin',
      strength: 'hard',
      score: 0.91,
      reasons: ['same dispatch parent', 'same sink role'],
      evidence: [{ kind: 'change', ref: 'router:create' }],
    });

    store.writeClosureSet({
      id: 'closure:create-user',
      target_unit: 'api:createUser',
      family_id: 'handlers/create',
      generated_at: '2026-04-11T00:00:00Z',
      members: [
        {
          unit_id: 'api:createAdmin',
          level: 'must_review',
          reasons: ['hard symmetry edge'],
          confidence: 0.91,
          evidence: [{ kind: 'module', ref: 'api' }],
        },
      ],
      evidence: [{ kind: 'flow', ref: 'proc_create_user' }],
    });

    store.writeAbstractionOpportunity({
      id: 'abstraction:create-handler-helper',
      title: 'Extract shared create helper',
      family_id: 'handlers/create',
      repeated_paths: ['path:create-user', 'path:create-admin', 'path:create-bot'],
      candidate_units: ['api:createUser', 'api:createAdmin', 'api:createBot'],
      suggested_abstraction_level: 'extract_helper',
      candidate_owning_module: 'api',
      expected_closure_set: 'closure:create-user',
      evidence: [{ kind: 'change', ref: 'api/create.ts' }],
      confidence: 0.74,
      status: 'candidate',
    });

    store.writeDecisionOverride({
      id: 'override:plan-option:create-helper',
      created_at: '2026-04-11T00:00:00Z',
      target_type: 'plan_option',
      target_id: 'extract_helper',
      reason: 'Prefer a local patch while API contract is frozen.',
      evidence: [{ kind: 'doc', ref: 'ADR-17' }],
    });

    expect(store.listSymmetryEdges()).toContain('symmetry:handlers:create-a~create-b');
    expect(store.readSymmetryEdge('symmetry:handlers:create-a~create-b').strength).toBe('hard');
    expect(store.listClosureSets()).toContain('closure:create-user');
    expect(store.readClosureSet('closure:create-user').members[0].level).toBe('must_review');
    expect(store.listAbstractionOpportunities()).toContain('abstraction:create-handler-helper');
    expect(store.readAbstractionOpportunity('abstraction:create-handler-helper').suggested_abstraction_level).toBe('extract_helper');
    expect(store.listDecisionOverrides()).toContain('override:plan-option:create-helper');
    expect(store.readDecisionOverride('override:plan-option:create-helper').target_type).toBe('plan_option');
  });

  it('stores very long decision artifact IDs in storage v2', () => {
    const longId = `symmetry:family:${'very-long-source-symbol-name-'.repeat(10)}~${'very-long-target-symbol-name-'.repeat(10)}`;
    store.writeSymmetryEdge({
      id: longId,
      family_id: 'family',
      from_unit: 'source',
      to_unit: 'target',
      strength: 'soft',
      score: 0.6,
      reasons: ['long id regression'],
      evidence: [{ kind: 'module', ref: 'api' }],
    });

    expect(store.listSymmetryEdges()).toContain(longId);
    expect(store.readSymmetryEdge(longId).id).toBe(longId);
    store.pruneStale('symmetry', new Set([longId]));
    expect(store.listSymmetryEdges()).toContain(longId);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'symmetry'))).toBe(false);
  });
});

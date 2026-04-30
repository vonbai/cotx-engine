import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { buildChangePlan } from '../../src/compiler/change-planner.js';

describe('buildChangePlan', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-plan-change-'));
    store = new CotxStore(tmpDir);
    store.init('plan-test');
    store.writeModule({
      id: 'api',
      canonical_entry: 'src/api/main.ts:runApi',
      files: ['src/api/main.ts'],
      depends_on: ['db'],
      depended_by: [],
      struct_hash: 'mod1',
    });
    store.writeModule({
      id: 'db',
      canonical_entry: 'src/db/query.ts:query',
      files: ['src/db/query.ts'],
      depends_on: [],
      depended_by: ['api'],
      struct_hash: 'mod2',
    });
    store.writeContract({
      id: 'api-db',
      provider: 'db',
      consumer: 'api',
      interface: ['query'],
      struct_hash: 'contract1',
    });
    store.writeFlow({
      id: 'proc_run_api',
      type: 'flow',
      trigger: 'runApi',
      steps: [
        { module: 'api', function: 'runApi' },
        { module: 'db', function: 'query' },
      ],
      struct_hash: 'flow1',
    });
    store.writeDoctrine({
      generated_at: '2026-04-11T00:00:00Z',
      struct_hash: 'doctrine1',
      statements: [
        {
          id: 'doctrine-1',
          kind: 'principle',
          title: 'Respect existing module boundaries',
          statement: 'Prefer touching the owning module before adding wrappers.',
          strength: 'soft',
          scope: 'repo',
          inferred: true,
          evidence: [{ kind: 'module', ref: 'api' }],
        },
        {
          id: 'doctrine-2',
          kind: 'preferred_pattern',
          title: 'Use existing contract surfaces',
          statement: 'Review both sides of a contract before changing cross-module behavior.',
          strength: 'soft',
          scope: 'repo',
          inferred: true,
          evidence: [{ kind: 'contract', ref: 'api-db' }],
        },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds a deterministic change plan with related modules, entry points, and discouraged approaches', () => {
    const plan = buildChangePlan(tmpDir, store, 'api');

    expect(plan.focus_nodes).toContainEqual({ id: 'api', layer: 'module' });
    expect(plan.recommended_modules).toContain('api');
    expect(plan.recommended_modules).toContain('db');
    expect(plan.entry_points).toContain('src/api/main.ts:runApi');
    expect(plan.doctrine_refs).toContain('doctrine-1');
    expect(plan.discouraged_approaches.some((item) => item.includes('compatibility'))).toBe(true);
    expect(plan.options.length).toBeGreaterThan(0);
    expect(plan.options.some((option) => option.discouraged)).toBe(true);
  });
});

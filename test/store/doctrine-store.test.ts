import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';

describe('Doctrine / plan / review store', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-doctrine-store-'));
    store = new CotxStore(tmpDir);
    store.init('doctrine-test');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads doctrine data', () => {
    store.writeDoctrine({
      generated_at: '2026-04-11T00:00:00Z',
      struct_hash: 'abc123',
      statements: [
        {
          id: 'doctrine-1',
          kind: 'principle',
          title: 'Prefer module-local fixes',
          statement: 'Prefer changing the owning module before adding compatibility layers.',
          strength: 'soft',
          scope: 'repo',
          inferred: true,
          evidence: [{ kind: 'module', ref: 'api' }],
        },
      ],
    });

    const doctrine = store.readDoctrine();
    expect(doctrine?.statements[0].title).toBe('Prefer module-local fixes');
  });

  it('writes and reads latest plan and review', () => {
    store.writeLatestPlan({
      generated_at: '2026-04-11T00:00:00Z',
      target: 'auth',
      focus_nodes: [{ id: 'auth', layer: 'module' }],
      recommended_modules: ['auth'],
      entry_points: ['auth/main.ts:run'],
      doctrine_refs: ['doctrine-1'],
      recommended_steps: ['Update auth module first'],
      discouraged_approaches: ['Do not add compatibility wrappers first'],
      rationale: ['Auth is the owning module.'],
      options: [],
    });
    store.writeLatestReview({
      generated_at: '2026-04-11T00:00:00Z',
      changed_files: ['src/auth.ts'],
      findings: [
        {
          id: 'finding-1',
          severity: 'warning',
          kind: 'local_patch',
          title: 'Local patch on shared module',
          message: 'Shared module changed in isolation.',
          doctrine_refs: ['doctrine-1'],
          evidence: [{ kind: 'module', ref: 'auth' }],
        },
      ],
      summary: { warnings: 1, errors: 0 },
    });

    expect(store.readLatestPlan()?.target).toBe('auth');
    expect(store.readLatestReview()?.findings[0].kind).toBe('local_patch');
  });
});

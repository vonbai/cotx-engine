import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { buildChangeReview } from '../../src/compiler/change-review.js';

describe('buildChangeReview', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-review-'));
    store = new CotxStore(tmpDir);
    store.init('review-test');
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
          title: 'Prefer module-local fixes',
          statement: 'Prefer changing the owning path before wrappers.',
          strength: 'soft',
          scope: 'repo',
          inferred: true,
          evidence: [{ kind: 'module', ref: 'api' }],
        },
        {
          id: 'doctrine-2',
          kind: 'constraint',
          title: 'Use existing contract surfaces',
          statement: 'Review both sides of a contract when changing cross-module behavior.',
          strength: 'hard',
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

  it('flags compatibility-layer, local patch, and half-refactor style issues deterministically', () => {
    const review = buildChangeReview(tmpDir, store, {
      changedFiles: ['src/api/main.ts'],
      addedLines: ['export function legacyAdapter() { return query(); }'],
    });

    const kinds = review.findings.map((finding) => finding.kind);
    expect(kinds).toContain('compatibility_layer');
    expect(kinds).toContain('local_patch');
    expect(kinds).toContain('half_refactor');
    expect(review.summary.warnings).toBeGreaterThan(0);
  });

  it('normalizes in-repo absolute file paths instead of letting git/path mismatches leak through', () => {
    const review = buildChangeReview(tmpDir, store, {
      changedFiles: [path.join(tmpDir, 'src', 'api', 'main.ts')],
      addedLines: [],
    });

    expect(review.changed_files).toEqual(['src/api/main.ts']);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { recordDecisionOverride, validateDecisionOverride } from '../../src/compiler/decision-override.js';

describe('decision override', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-decision-override-'));
    store = new CotxStore(tmpDir);
    store.init('decision-override-test');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records a validated override in the store', () => {
    recordDecisionOverride(store, {
      id: 'override:test',
      created_at: '2026-04-11T00:00:00Z',
      target_type: 'plan_option',
      target_id: 'canonicalize_path',
      reason: '  API freeze requires a smaller temporary scope.  ',
      evidence: [{ kind: 'doc', ref: 'ADR-17' }],
    });

    expect(store.readDecisionOverride('override:test').reason).toBe('API freeze requires a smaller temporary scope.');
  });

  it('rejects overrides without evidence', () => {
    expect(() => validateDecisionOverride({
      id: 'override:bad',
      created_at: '2026-04-11T00:00:00Z',
      target_type: 'review_finding',
      target_id: 'local_patch',
      reason: 'skip',
      evidence: [],
    })).toThrow(/evidence/i);
  });
});

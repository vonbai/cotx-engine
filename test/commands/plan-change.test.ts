import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandPlanChange } from '../../src/commands/plan-change.js';

describe('commandPlanChange', () => {
  let tmpDir: string;
  let store: CotxStore;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-plan-command-'));
    store = new CotxStore(tmpDir);
    store.init('plan-command-test');
    store.writeModule({
      id: 'api',
      canonical_entry: 'src/api/main.ts:runApi',
      files: ['src/api/main.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'mod1',
    });
    store.writeDoctrine({
      generated_at: '2026-04-11T00:00:00Z',
      struct_hash: 'doctrine1',
      statements: [
        {
          id: 'doctrine-1',
          kind: 'principle',
          title: 'Prefer module-local fixes',
          statement: 'Change the owning module first.',
          strength: 'soft',
          scope: 'repo',
          inferred: true,
          evidence: [{ kind: 'module', ref: 'api' }],
        },
      ],
    });
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints a readable plan and writes latest plan to the store', async () => {
    await commandPlanChange(tmpDir, 'api');
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('## Change Plan: api');
    expect(output).toContain('### Recommended Modules');
    expect(output).toContain('api');
    expect(output).toContain('### Discouraged Approaches');
    expect(store.readLatestPlan()?.target).toBe('api');
  });
});

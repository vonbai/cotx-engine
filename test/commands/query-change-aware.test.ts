import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandQuery } from '../../src/commands/query.js';

describe('commandQuery recent changes', () => {
  let tmpDir: string;
  let store: CotxStore;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-query-'));
    store = new CotxStore(tmpDir);
    store.init('query-test');
    store.writeLatestChangeSummary({
      generated_at: '2026-04-10T00:00:00Z',
      trigger: 'update',
      changed_files: ['src/api.ts'],
      affected_modules: [],
      affected_contracts: [],
      affected_flows: [],
      symbols: {
        added: [{ id: 'Function:src/api.ts:UsageList', label: 'Function' }],
        removed: [],
        changed: [],
      },
      layers: { added: [], removed: [], changed: [] },
      stale: { enrichments: [], annotations: [] },
    });
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints recently changed symbols when map search has no results', async () => {
    await commandQuery(tmpDir, 'UsageList', { layer: undefined });
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('recently changed symbols match');
    expect(output).toContain('Function:src/api.ts:UsageList');
  });
});

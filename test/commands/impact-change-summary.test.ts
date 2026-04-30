import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandImpact } from '../../src/commands/impact.js';

describe('commandImpact recent changes', () => {
  let tmpDir: string;
  let store: CotxStore;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-impact-'));
    store = new CotxStore(tmpDir);
    store.init('impact-test');
    store.writeModule({
      id: 'api',
      canonical_entry: 'run',
      files: ['src/api.ts'],
      depends_on: ['db'],
      depended_by: [],
      struct_hash: 'a',
    });
    store.writeModule({
      id: 'db',
      canonical_entry: 'query',
      files: ['src/db.ts'],
      depends_on: [],
      depended_by: ['api'],
      struct_hash: 'b',
    });
    store.writeLatestChangeSummary({
      generated_at: '2026-04-10T00:00:00Z',
      trigger: 'update',
      changed_files: ['src/api.ts'],
      affected_modules: ['api'],
      affected_contracts: [],
      affected_flows: [],
      symbols: { added: [], removed: [], changed: [] },
      layers: {
        added: [],
        removed: [],
        changed: [{ id: 'api', layer: 'module', changes: ['structure changed'] }],
      },
      stale: { enrichments: [], annotations: [] },
    });
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires typed graph nodes instead of falling back to semantic module impact', async () => {
    await commandImpact(tmpDir, 'api', { direction: 'upstream' });
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('Code node "api" not found in storage-v2 typed graph.');
  });
});

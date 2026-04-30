import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandStatus } from '../../src/commands/status.js';

describe('commandStatus stale explanations', () => {
  let tmpDir: string;
  let store: CotxStore;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-status-'));
    store = new CotxStore(tmpDir);
    store.init('status-test');
    store.writeModule({
      id: 'api',
      canonical_entry: 'run',
      files: ['src/api.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'new-hash',
      enriched: {
        responsibility: 'API layer',
        source_hash: 'old-hash',
        enriched_at: '2026-04-10T00:00:00Z',
      },
      annotations: [
        {
          author: 'human',
          type: 'constraint',
          content: 'must stay idempotent',
          date: '2026-04-10',
          stale: true,
          stale_reason: 'code changed',
        },
      ],
    });
    store.writeLatestChangeSummary({
      generated_at: '2026-04-10T00:00:00Z',
      trigger: 'update',
      changed_files: ['src/api.ts'],
      affected_modules: ['api'],
      affected_contracts: [],
      affected_flows: [],
      symbols: { added: [], removed: [], changed: [] },
      layers: { added: [], removed: [], changed: [] },
      stale: {
        enrichments: [{ nodeId: 'api', layer: 'module', reason: 'source_hash old-hash != struct_hash new-hash' }],
        annotations: [{ nodeId: 'api', layer: 'module', annotationIndex: 0, reason: 'code changed' }],
      },
    });
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints stale explanation details from the latest change summary', async () => {
    await commandStatus(tmpDir);
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('Stale explanations:');
    expect(output).toContain('Changed files: src/api.ts');
    expect(output).toContain('Enrichment [module] api: source_hash old-hash != struct_hash new-hash');
    expect(output).toContain('Annotation [module] api#0: code changed');
  });
});

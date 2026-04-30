import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandRename } from '../../src/commands/rename.js';

describe('commandRename', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-rename-test-'));
    store = new CotxStore(tmpDir);
    store.init('rename-test');
    store.writeModule({
      id: 'cli/transport',
      canonical_entry: 'Deliver',
      files: ['cli/transport.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'mod12345',
    });
    store.writeFlow({
      id: 'proc_delivery',
      type: 'flow',
      trigger: 'deliver',
      steps: [{ module: 'cli/transport', function: 'Deliver' }],
      struct_hash: 'flow1234',
    });
    store.writeIndex({
      version: '1',
      compiled_at: '2026-04-08T00:00:00Z',
      project: 'rename-test',
      stats: { modules: 1, concepts: 0, contracts: 0, flows: 1, concerns: 0 },
      graph: {
        nodes: [
          { id: 'cli/transport', layer: 'module', file: `v2/truth.lbug#semantic/module/${encodeURIComponent('cli/transport')}` },
          { id: 'proc_delivery', layer: 'flow', file: 'v2/truth.lbug#semantic/flow/proc_delivery' },
        ],
        edges: [{ from: 'proc_delivery', to: 'cli/transport', relation: 'step_in_flow' }],
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renames module ids containing slashes and updates references', async () => {
    const result = await commandRename(tmpDir, 'module', 'cli/transport', 'cli/delivery');

    expect(result.success).toBe(true);
    expect(store.listModules()).toContain('cli/delivery');
    expect(store.listModules()).not.toContain('cli/transport');
    expect(store.readFlow('proc_delivery').steps?.[0].module).toBe('cli/delivery');
  });
});

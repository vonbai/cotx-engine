import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandWrite } from '../../src/commands/write.js';
import { generateMapSummary } from '../../src/commands/map.js';

describe('commandWrite', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-write-test-'));
    store = new CotxStore(tmpDir);
    store.init('write-test');
    store.writeFlow({
      id: 'proc_1',
      type: 'flow',
      trigger: 'run',
      steps: [{ module: 'api', function: 'Handle' }],
      struct_hash: 'flow1234',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses structured enriched values instead of storing them as strings', async () => {
    const result = await commandWrite(
      tmpDir,
      'proc_1',
      'enriched.error_paths',
      '[{"condition":"fail","behavior":"stop"}]',
    );

    expect(result.success).toBe(true);
    expect(store.readFlow('proc_1').enriched?.error_paths).toEqual([
      { condition: 'fail', behavior: 'stop' },
    ]);
    expect(generateMapSummary(store, 'flow:proc_1', 2)).toContain('- fail: stop');
  });

  it('rejects invalid JSON for structured enriched fields', async () => {
    const result = await commandWrite(tmpDir, 'proc_1', 'enriched.error_paths', '[not valid json]');

    expect(result.success).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandDoctrine } from '../../src/commands/doctrine.js';

describe('commandDoctrine', () => {
  let tmpDir: string;
  let store: CotxStore;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-doctrine-command-'));
    store = new CotxStore(tmpDir);
    store.init('doctrine-command-test');
    store.writeDoctrine({
      generated_at: '2026-04-11T00:00:00Z',
      struct_hash: 'abc123',
      statements: [
        {
          id: 'principle-1',
          kind: 'principle',
          title: 'Prefer module-local fixes',
          statement: 'Prefer changing the owning module before adding wrappers.',
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

  it('prints doctrine statements grouped for humans', async () => {
    await commandDoctrine(tmpDir);
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('## Doctrine: doctrine-command-test');
    expect(output).toContain('### Principles');
    expect(output).toContain('Prefer module-local fixes');
    expect(output).toContain('Evidence: module:api');
  });
});

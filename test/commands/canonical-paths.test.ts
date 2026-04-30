import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandCanonicalPaths } from '../../src/commands/canonical-paths.js';
import { DecisionRuleIndex } from '../../src/store-v2/index.js';

describe('commandCanonicalPaths', () => {
  let tmpDir: string;
  let store: CotxStore;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-canonical-paths-command-'));
    store = new CotxStore(tmpDir);
    store.init('canonical-paths-command-test');
    await writeCanonicalFacts(tmpDir, [
      {
        id: 'canonical:persistence/save',
        familyId: 'save:repository_write',
        targetConcern: 'save:repository_write',
        owningModule: 'db',
        confidence: 0.88,
        status: 'canonical',
      },
    ]);
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints compiled canonical paths', async () => {
    await commandCanonicalPaths(tmpDir);
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('## Canonical Paths');
    expect(output).toContain('canonical:persistence/save');
    expect(output).toContain('save:repository_write');
  });

  it('suppresses low-confidence unknown candidates from the default output', async () => {
    await writeCanonicalFacts(tmpDir, [
      {
        id: 'canonical:persistence/save',
        familyId: 'save:repository_write',
        targetConcern: 'save:repository_write',
        owningModule: 'db',
        confidence: 0.88,
        status: 'canonical',
      },
      {
        id: 'canonical:process:unknown',
        familyId: 'process:unknown',
        targetConcern: 'process:unknown',
        owningModule: '_root',
        confidence: 0.18,
        status: 'candidate',
      },
    ]);

    await commandCanonicalPaths(tmpDir);
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('Suppressed');
    expect(output).not.toContain('canonical:process:unknown');
  });

  it('can show target-relevant candidates that are hidden in the global view', async () => {
    await writeCanonicalFacts(tmpDir, [
      {
        id: 'canonical:persistence/save',
        familyId: 'save:repository_write',
        targetConcern: 'save:repository_write',
        owningModule: 'db',
        confidence: 0.88,
        status: 'canonical',
      },
      {
        id: 'canonical:pane:repository_write',
        familyId: 'pane:repository_write',
        targetConcern: 'pane:repository_write',
        owningModule: 'zellij-server/pane',
        confidence: 0.58,
        status: 'candidate',
      },
    ]);

    spy.mockClear();
    await commandCanonicalPaths(tmpDir, { target: 'pane' });
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('canonical:pane:repository_write');
  });
});

async function writeCanonicalFacts(
  projectRoot: string,
  canonical: Array<{ id: string; familyId: string; targetConcern: string; owningModule: string; confidence: number; status: string }>,
): Promise<void> {
  const index = new DecisionRuleIndex({ dbPath: path.join(projectRoot, '.cotx', 'v2', 'rules.db') });
  await index.open();
  try {
    await index.writeFacts({
      canonical,
      symmetry: [],
      closures: [],
      closureMembers: [],
      abstractions: [],
      abstractionUnits: [],
      plans: [],
      reviews: [],
      planCoversClosure: [],
      reviewFlagsPlan: [],
    });
  } finally {
    index.close();
  }
}

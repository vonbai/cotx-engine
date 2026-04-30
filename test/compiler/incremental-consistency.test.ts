/**
 * Phase D step 13: incremental vs --force-full output consistency.
 *
 * A compile run with the parse cache active must produce the same semantic
 * map as a --force-full run. This test compiles the same small fixture
 * twice (once force-full, once default with a warm cache) and compares the
 * resulting .cotx/ artifacts that are supposed to be deterministic.
 *
 * What we compare:
 *   - meta.stats (module/concept/contract/flow/concern counts)
 *   - module IDs (listModules)
 *   - concept IDs (listConcepts)
 *   - module struct_hash per id — this is the strongest guarantee that the
 *     structural content is identical
 *
 * What we don't compare:
 *   - compiled_at timestamp (always differs)
 *   - git fingerprint (noise)
 *   - enriched.* fields (not populated when --enrich-policy=never)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';

const FIXTURE_SRC = path.resolve('example/oh-my-mermaid');
const HAS_FIXTURE = fs.existsSync(path.join(FIXTURE_SRC, 'package.json'));

describe.skipIf(!HAS_FIXTURE)('incremental vs force-full output consistency', () => {
  let forceFullDir: string;
  let incrementalDir: string;
  const cotxBin = path.resolve('dist/index.js');

  beforeAll(() => {
    forceFullDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-ff-'));
    incrementalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-inc-'));
    // Copy the fixture (without node_modules) to both tmp dirs so the runs
    // are independent. Using fs.cpSync with filter to avoid copying .cotx
    // and node_modules.
    const ignore = new Set(['node_modules', '.cotx', '.git', 'dist']);
    const copy = (src: string, dst: string) => {
      fs.cpSync(src, dst, {
        recursive: true,
        filter: (s) => {
          const base = path.basename(s);
          return !ignore.has(base);
        },
      });
    };
    copy(FIXTURE_SRC, forceFullDir);
    copy(FIXTURE_SRC, incrementalDir);

    // Compile both. Let the retry wrapper handle intermittent native crashes
    // transparently — this is the real user-facing path.
    const run = (cwd: string, extra: string[]) => {
      execFileSync('node', [cotxBin, 'compile', '--enrich-policy=never', ...extra], {
        cwd,
        stdio: 'pipe',
        timeout: 180_000,
      });
    };

    run(forceFullDir, ['--force-full']);
    // First incremental pass (cold): populates cache
    run(incrementalDir, []);
    // Second pass (warm): uses cache for reads. This is the "incremental"
    // scenario we want to compare against force-full.
    run(incrementalDir, []);
  }, 180_000);

  afterAll(() => {
    if (forceFullDir) fs.rmSync(forceFullDir, { recursive: true, force: true });
    if (incrementalDir) fs.rmSync(incrementalDir, { recursive: true, force: true });
  });

  it('produces identical stats', () => {
    const ffMeta = new CotxStore(forceFullDir).readMeta();
    const incMeta = new CotxStore(incrementalDir).readMeta();
    expect(incMeta.stats).toEqual(ffMeta.stats);
  });

  it('produces identical module ID sets', () => {
    const ffStore = new CotxStore(forceFullDir);
    const incStore = new CotxStore(incrementalDir);
    const ffIds = [...ffStore.listModules()].sort();
    const incIds = [...incStore.listModules()].sort();
    expect(incIds).toEqual(ffIds);
  });

  it('produces identical concept ID sets', () => {
    const ffStore = new CotxStore(forceFullDir);
    const incStore = new CotxStore(incrementalDir);
    const ffIds = [...ffStore.listConcepts()].sort();
    const incIds = [...incStore.listConcepts()].sort();
    expect(incIds).toEqual(ffIds);
  });

  it('produces identical module struct_hashes', () => {
    const ffStore = new CotxStore(forceFullDir);
    const incStore = new CotxStore(incrementalDir);
    const ids = [...ffStore.listModules()].sort();
    for (const id of ids) {
      const ffHash = ffStore.readModule(id).struct_hash;
      const incHash = incStore.readModule(id).struct_hash;
      expect(incHash, `module ${id}: struct_hash drifted`).toBe(ffHash);
    }
  });
});

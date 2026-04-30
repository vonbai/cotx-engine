import { describe, it, expect } from 'vitest';
import { AUTO_REFRESH_DRIFT_LIMIT, maybeAutoRefresh } from '../../src/mcp/tools.js';
import type { FreshnessStatus } from '../../src/compiler/freshness-detector.js';

describe('maybeAutoRefresh decisions (no compile)', () => {
  it('skips when index is fresh', async () => {
    const result = await maybeAutoRefresh('/tmp/nonexistent', { fresh: true });
    expect(result.attempted).toBe(false);
    expect(result.succeeded).toBe(false);
  });

  it('skips when reason is no-meta or no-git', async () => {
    const noMeta = await maybeAutoRefresh('/tmp/nonexistent', { fresh: false, reason: 'no-meta' });
    expect(noMeta.attempted).toBe(false);
    expect(noMeta.skip_reason).toBe('no-meta');

    const noGit = await maybeAutoRefresh('/tmp/nonexistent', { fresh: false, reason: 'no-git' });
    expect(noGit.attempted).toBe(false);
    expect(noGit.skip_reason).toBe('no-git');
  });

  it('skips when drifted_files is empty', async () => {
    const status: FreshnessStatus = {
      fresh: false,
      reason: 'head-changed',
      drifted_files: [],
    };
    const result = await maybeAutoRefresh('/tmp/nonexistent', status);
    expect(result.attempted).toBe(false);
    expect(result.skip_reason).toBe('no-drifted-files');
  });

  it(`skips when drift exceeds ${AUTO_REFRESH_DRIFT_LIMIT} files`, async () => {
    const drifted = Array.from({ length: AUTO_REFRESH_DRIFT_LIMIT + 1 }, (_, i) => `f${i}.ts`);
    const status: FreshnessStatus = {
      fresh: false,
      reason: 'head-changed',
      drifted_files: drifted,
    };
    const result = await maybeAutoRefresh('/tmp/nonexistent', status);
    expect(result.attempted).toBe(false);
    expect(result.skip_reason).toMatch(/drift-exceeds-limit/);
  });

  it('exports the drift limit as a constant', () => {
    expect(AUTO_REFRESH_DRIFT_LIMIT).toBe(500);
  });
});

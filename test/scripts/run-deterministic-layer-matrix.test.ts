import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('run-deterministic-layer-matrix script', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('can fail the process after writing artifacts when gap rows are recorded', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-det-matrix-test-'));
    const outDir = path.join(tmpDir, 'out');
    const result = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'run-deterministic-layer-matrix.mjs'),
    ], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        REPOS: 'fastmcp',
        REPOS_ROOT: path.join(tmpDir, 'missing-repos-root'),
        OUT_DIR: outDir,
        MATRIX_PREFIX: 'fixture',
        FAIL_ON_GAP: '1',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL_ON_GAP=1');

    const markdown = fs.readFileSync(path.join(outDir, 'fixture.md'), 'utf-8');
    const jsonl = fs.readFileSync(path.join(outDir, 'fixture.jsonl'), 'utf-8');

    expect(markdown).toContain('## Failure And Gap Notes');
    expect(markdown).toContain('source path does not exist');
    expect(jsonl).toContain('"status":"gap"');
  });
});

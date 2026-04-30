import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { commandCompile } from '../../src/commands/compile.js';
import { commandReviewChange } from '../../src/commands/review-change.js';
import { CotxStore } from '../../src/store/store.js';

describe('commandReviewChange', () => {
  let tmpDir: string;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-review-command-'));
    fs.mkdirSync(path.join(tmpDir, 'src', 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api', 'main.ts'),
      [
        "import { query } from '../db/query.js';",
        'export function runApi() {',
        '  return query();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'db', 'query.ts'),
      [
        'export function query() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir });
    execSync('git config user.name "Test User"', { cwd: tmpDir });
    execSync('git add . && git commit -m "baseline"', { cwd: tmpDir });
    await commandCompile(tmpDir, { silent: true });

    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api', 'main.ts'),
      [
        "import { query } from '../db/query.js';",
        'export function runApi() {',
        '  return query();',
        '}',
        '',
        'export function legacyAdapter() {',
        '  return runApi();',
        '}',
        '',
      ].join('\n'),
    );
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints findings and writes latest review', async () => {
    await commandReviewChange(tmpDir);
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('## Change Review');
    expect(output).toContain('compatibility_layer');
    expect(new CotxStore(tmpDir).readLatestReview()?.findings.length).toBeGreaterThan(0);
  });
});

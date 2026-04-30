import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { CotxStore } from '../../src/store/store.js';
import { buildChangeReview } from '../../src/compiler/change-review.js';

describe('benchmark guardrail: change review regression', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bench-review-'));
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# repo\n');
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'main.ts'),
      "import { query } from '../db/query.js';\nexport function runApi() { return query(); }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'db', 'query.ts'),
      'export function query() { return 1; }\n',
    );
    await commandCompile(tmpDir, { silent: true });
    store = new CotxStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flags compatibility-layer style additions', () => {
    const review = buildChangeReview(tmpDir, store, {
      changedFiles: ['api/main.ts'],
      addedLines: ['export function compatWrapper() { return runApi(); }'],
    });
    expect(review.findings.some((finding) => finding.kind === 'compatibility_layer')).toBe(true);
  });
});

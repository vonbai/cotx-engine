import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { commandCompile } from '../../src/commands/compile.js';
import { CotxStore } from '../../src/store/store.js';
import { buildDecisionReview } from '../../src/compiler/decision-review.js';

describe('buildDecisionReview', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-decision-review-'));
    fs.mkdirSync(path.join(tmpDir, 'src', 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'service'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'db'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# repo\n');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api', 'user.ts'),
      "import { validateUser } from '../service/user.js';\nexport function handleCreateUser() { return validateUser(); }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api', 'admin.ts'),
      "import { validateAdmin } from '../service/admin.js';\nexport function handleCreateAdmin() { return validateAdmin(); }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'service', 'user.ts'),
      "import { saveState } from '../db/store.js';\nexport function validateUser() { return saveState(); }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'service', 'admin.ts'),
      "import { saveState } from '../db/store.js';\nexport function validateAdmin() { return saveState(); }\n",
    );
    fs.writeFileSync(path.join(tmpDir, 'src', 'db', 'store.ts'), 'export function saveState() { return 1; }\n');
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir });
    execSync('git config user.name "Test User"', { cwd: tmpDir });
    execSync('git add . && git commit -m "baseline"', { cwd: tmpDir });
    await commandCompile(tmpDir, { silent: true });
    store = new CotxStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flags compatibility additions and under-closed patches against the decision context', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api', 'user.ts'),
      [
        "import { validateUser } from '../service/user.js';",
        'export function handleCreateUser() {',
        '  return validateUser();',
        '}',
        '',
        'export function legacyAdapter() {',
        '  return handleCreateUser();',
        '}',
        '',
      ].join('\n'),
    );

    const review = buildDecisionReview(tmpDir, store, {
      changedFiles: ['src/api/user.ts'],
      addedLines: ['export function legacyAdapter() { return handleCreateUser(); }'],
    });

    const kinds = review.findings.map((finding) => finding.kind);
    expect(kinds).toContain('compatibility_layer');
    expect(kinds).toContain('local_patch');
  });

  it('does not flag local_patch when all hard sibling files in the closure are already changed', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api', 'user.ts'),
      [
        "import { validateUser } from '../service/user.js';",
        'export function handleCreateUser() {',
        '  return validateUser();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api', 'admin.ts'),
      [
        "import { validateAdmin } from '../service/admin.js';",
        'export function handleCreateAdmin() {',
        '  return validateAdmin();',
        '}',
        '',
      ].join('\n'),
    );

    const review = buildDecisionReview(tmpDir, store, {
      changedFiles: ['src/api/user.ts', 'src/api/admin.ts'],
      addedLines: [],
    });

    expect(review.findings.some((finding) => finding.kind === 'local_patch')).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { analyzeCochange } from '../../src/compiler/cochange-analyzer.js';

describe('analyzeCochange', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-cochange-'));
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir });
    execSync('git config user.name "Test User"', { cwd: tmpDir });
    fs.mkdirSync(path.join(tmpDir, 'src', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'api', 'user.ts'), 'export const user = 1;\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'api', 'admin.ts'), 'export const admin = 1;\n');
    execSync('git add . && git commit -m "init"', { cwd: tmpDir });

    for (let index = 0; index < 3; index++) {
      fs.writeFileSync(path.join(tmpDir, 'src', 'api', 'user.ts'), `export const user = ${index + 2};\n`);
      fs.writeFileSync(path.join(tmpDir, 'src', 'api', 'admin.ts'), `export const admin = ${index + 2};\n`);
      execSync('git add . && git commit -m "cochange"', { cwd: tmpDir });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects repeated co-change file pairs from git history', () => {
    const rules = analyzeCochange(tmpDir);
    expect(rules.some((rule) => rule.files.includes('src/api/user.ts') && rule.files.includes('src/api/admin.ts'))).toBe(true);
  });

  it('reuses cached co-change rules when git is temporarily unavailable', () => {
    const first = analyzeCochange(tmpDir);
    fs.renameSync(path.join(tmpDir, '.git'), path.join(tmpDir, '.git-hidden'));
    const second = analyzeCochange(tmpDir);
    expect(second).toEqual(first);
  });

  it('skips very large changesets while preserving smaller co-change rules', () => {
    fs.mkdirSync(path.join(tmpDir, 'bulk'), { recursive: true });
    for (let index = 0; index < 40; index++) {
      fs.writeFileSync(path.join(tmpDir, 'bulk', `${index}.ts`), `export const item${index} = ${index};\n`);
    }
    execSync('git add . && git commit -m "large generated update"', { cwd: tmpDir });

    const rules = analyzeCochange(tmpDir, { maxChangesetSize: 10 });

    expect(rules.some((rule) => rule.files.includes('src/api/user.ts') && rule.files.includes('src/api/admin.ts'))).toBe(true);
    expect(rules.some((rule) => rule.files.some((file) => file.startsWith('bulk/')))).toBe(false);
  });
});

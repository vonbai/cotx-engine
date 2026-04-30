import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { ensureCotxGitignored } from '../../src/lib/git.js';

function initGitRepo(dir: string): void {
  execSync('git init --quiet', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  execSync('git config commit.gpgsign false', { cwd: dir });
}

function gitPath(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf-8' }).trim();
}

function readLocalExclude(dir: string): string {
  const raw = gitPath(dir, 'rev-parse --git-path info/exclude');
  const excludePath = path.isAbsolute(raw) ? raw : path.join(dir, raw);
  return fs.readFileSync(excludePath, 'utf-8');
}

describe('ensureCotxGitignored', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-gitignore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-ops outside a git repo', () => {
    const changed = ensureCotxGitignored(tmpDir);
    expect(changed).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);
  });

  it('writes .cotx/ to local git exclude when .gitignore is missing', () => {
    initGitRepo(tmpDir);
    const changed = ensureCotxGitignored(tmpDir);
    expect(changed).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);
    const content = readLocalExclude(tmpDir);
    expect(content).toMatch(/^\s*\.cotx\/\s*$/m);
  });

  it('does not modify an existing .gitignore by default', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n*.log\n');
    const changed = ensureCotxGitignored(tmpDir);
    expect(changed).toBe(true);
    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toBe('node_modules\n*.log\n');
    expect(readLocalExclude(tmpDir)).toMatch(/\.cotx\//);
  });

  it('is idempotent when .cotx/ is already gitignored (trailing slash)', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n.cotx/\n');
    const changed = ensureCotxGitignored(tmpDir);
    expect(changed).toBe(false);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    // Should not have been appended twice.
    expect(content.match(/\.cotx\//g)?.length).toBe(1);
  });

  it('is idempotent when .cotx is already listed without trailing slash', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.cotx\n');
    const changed = ensureCotxGitignored(tmpDir);
    expect(changed).toBe(false);
  });

  it('is idempotent when .cotx/ is already listed in local exclude', () => {
    initGitRepo(tmpDir);
    ensureCotxGitignored(tmpDir);
    const changed = ensureCotxGitignored(tmpDir);
    expect(changed).toBe(false);
    expect(readLocalExclude(tmpDir).match(/\.cotx\//g)?.length).toBe(1);
  });

  it('can explicitly append .cotx/ to .gitignore when requested', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules');
    ensureCotxGitignored(tmpDir, undefined, { persistToGitignore: true });
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines).toContain('node_modules');
    expect(lines).toContain('.cotx/');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CotxStore } from '../../src/store/store.js';
import { captureGitFingerprint } from '../../src/lib/git.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
}

describe('CotxMeta.git persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-meta-git-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists git.head/branch/dirty_fingerprint into meta.yaml', () => {
    git(tmpDir, 'init --quiet');
    git(tmpDir, 'config user.email test@example.com');
    git(tmpDir, 'config user.name test');
    git(tmpDir, 'config commit.gpgsign false');
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v1');
    git(tmpDir, 'add a.txt');
    git(tmpDir, 'commit -m c1 --quiet');

    const store = new CotxStore(tmpDir);
    store.init('proj');
    const fingerprint = captureGitFingerprint(tmpDir);
    expect(fingerprint).toBeDefined();
    store.updateMeta({ git: fingerprint! });

    const raw = fs.readFileSync(path.join(tmpDir, '.cotx', 'meta.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const gitBlock = parsed.git as { head: string; branch: string; dirty_fingerprint: string };
    expect(gitBlock.head).toMatch(/^[0-9a-f]{40}$/);
    expect(gitBlock.branch.length).toBeGreaterThan(0);
    expect(gitBlock.dirty_fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reads back legacy meta.yaml without git field', () => {
    const store = new CotxStore(tmpDir);
    store.init('proj');
    const meta = store.readMeta();
    expect(meta.git).toBeUndefined();
    expect(meta.project).toBe('proj');
  });

  it('captureGitFingerprint returns undefined outside a git repo', () => {
    expect(captureGitFingerprint(tmpDir)).toBeUndefined();
  });
});

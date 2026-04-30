import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectFreshness, staleAnnotation } from '../../src/compiler/freshness-detector.js';
import { CotxStore } from '../../src/store/store.js';
import { captureGitFingerprint, captureLegacyDirtyFingerprint, ensureCotxGitignored } from '../../src/lib/git.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
}

function initGitRepo(dir: string): void {
  git(dir, 'init --quiet');
  git(dir, 'config user.email test@example.com');
  git(dir, 'config user.name test');
  git(dir, 'config commit.gpgsign false');
}

describe('detectFreshness', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-fresh-'));
    store = new CotxStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns no-meta when .cotx/ is absent', () => {
    const result = detectFreshness(tmpDir);
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe('no-meta');
  });

  it('returns fresh=true on a non-git directory with an index', () => {
    store.init('proj');
    const result = detectFreshness(tmpDir);
    expect(result.fresh).toBe(true);
    expect(result.reason).toBe('no-git');
  });

  it('returns fresh=true when compiled HEAD and working tree match', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello');
    git(tmpDir, 'add a.txt');
    git(tmpDir, 'commit -m initial --quiet');
    ensureCotxGitignored(tmpDir);

    store.init('proj');
    const git_ = captureGitFingerprint(tmpDir);
    expect(git_).toBeDefined();
    store.updateMeta({ git: git_! });

    const result = detectFreshness(tmpDir);
    expect(result.fresh).toBe(true);
  });

  it('detects head-changed after a new commit', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v1');
    git(tmpDir, 'add a.txt');
    git(tmpDir, 'commit -m c1 --quiet');

    store.init('proj');
    store.updateMeta({ git: captureGitFingerprint(tmpDir)! });

    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'v2');
    git(tmpDir, 'add b.txt');
    git(tmpDir, 'commit -m c2 --quiet');

    const result = detectFreshness(tmpDir);
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe('head-changed');
    expect(result.compiled_head).toBeDefined();
    expect(result.current_head).toBeDefined();
    expect(result.compiled_head).not.toEqual(result.current_head);
    expect(result.drifted_files?.length ?? 0).toBeGreaterThan(0);
    expect(result.hint).toMatch(/cotx_compile mode=delta|cotx_prepare_task/);
  });

  it('detects working-tree-dirty for uncommitted edits', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v1');
    git(tmpDir, 'add a.txt');
    git(tmpDir, 'commit -m c1 --quiet');

    store.init('proj');
    store.updateMeta({ git: captureGitFingerprint(tmpDir)! });

    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v2 — uncommitted');

    const result = detectFreshness(tmpDir);
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe('working-tree-dirty');
    expect(result.drifted_files?.length ?? 0).toBeGreaterThan(0);
  });

  it('detects content changes when git status text stays the same', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v1');
    git(tmpDir, 'add a.txt');
    git(tmpDir, 'commit -m c1 --quiet');

    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v2 uncommitted');
    store.init('proj');
    store.updateMeta({ git: captureGitFingerprint(tmpDir)! });

    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v3 uncommitted');

    const result = detectFreshness(tmpDir);
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe('working-tree-dirty');
  });

  it('stays fresh when no git fingerprint is recorded (legacy meta.yaml)', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v1');
    git(tmpDir, 'add a.txt');
    git(tmpDir, 'commit -m c1 --quiet');

    // Do NOT write git fingerprint — simulates an index compiled by an older cotx.
    store.init('proj');

    const result = detectFreshness(tmpDir);
    expect(result.fresh).toBe(true);
    expect(result.reason).toBe('no-git');
    expect(result.hint).toMatch(/predates git tracking/);
  });

  it('keeps clean indexes with legacy dirty fingerprints fresh', () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v1');
    git(tmpDir, 'add a.txt');
    git(tmpDir, 'commit -m c1 --quiet');
    ensureCotxGitignored(tmpDir);

    store.init('proj');
    const current = captureGitFingerprint(tmpDir)!;
    store.updateMeta({
      git: {
        head: current.head,
        branch: current.branch,
        dirty_fingerprint: captureLegacyDirtyFingerprint(tmpDir)!,
      },
    });

    const result = detectFreshness(tmpDir);
    expect(result.fresh).toBe(true);
  });
});

describe('staleAnnotation', () => {
  it('returns null when fresh', () => {
    expect(staleAnnotation({ fresh: true })).toBeNull();
  });

  it('returns null for informational no-git reason', () => {
    expect(staleAnnotation({ fresh: true, reason: 'no-git' })).toBeNull();
  });

  it('returns a stale annotation for head-changed', () => {
    const annotation = staleAnnotation({
      fresh: false,
      reason: 'head-changed',
      compiled_head: 'abc1234',
      current_head: 'def5678',
      drifted_files: ['src/a.ts', 'src/b.ts'],
      hint: 'stale — refresh me',
    });
    expect(annotation).not.toBeNull();
    expect(annotation?.stale_against_head).toBe(true);
    expect(annotation?.stale_reason).toBe('head-changed');
    expect(annotation?.drifted_files_count).toBe(2);
    expect(annotation?.stale_hint).toBe('stale — refresh me');
  });
});

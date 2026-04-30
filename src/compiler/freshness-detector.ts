import { CotxStore } from '../store/store.js';
import {
  captureGitFingerprint,
  captureLegacyDirtyFingerprint,
  getDiffedFiles,
  isGitRepo,
  tryReadGitValue,
} from '../lib/git.js';

export type FreshnessReason =
  | 'no-meta'
  | 'no-git'
  | 'head-changed'
  | 'working-tree-dirty';

export interface FreshnessStatus {
  fresh: boolean;
  reason?: FreshnessReason;
  compiled_head?: string;
  current_head?: string;
  compiled_branch?: string;
  current_branch?: string;
  compiled_dirty_fingerprint?: string;
  current_dirty_fingerprint?: string;
  /** Files that differ between the compiled HEAD and the current working tree. */
  drifted_files?: string[];
  /** Human-readable summary suitable for MCP response hints. */
  hint?: string;
}

/**
 * Compare the recorded git fingerprint in .cotx/meta.yaml against the
 * current working tree. Non-git projects are considered fresh.
 *
 * This is a fast check (no YAML scanning) intended to run before every
 * read-only MCP tool call so the response can be annotated when stale.
 */
export function detectFreshness(projectRoot: string): FreshnessStatus {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    return { fresh: false, reason: 'no-meta', hint: 'No .cotx/ found. Run cotx_compile first.' };
  }

  let meta;
  try {
    meta = store.readMeta();
  } catch {
    return { fresh: false, reason: 'no-meta', hint: 'Could not read .cotx/meta.yaml. Run cotx_compile.' };
  }

  if (!isGitRepo(projectRoot)) {
    return { fresh: true, reason: 'no-git' };
  }

  if (!meta.git) {
    // Index was compiled before this feature shipped. Treat as fresh to
    // preserve backwards compatibility; recommend recompilation in the hint.
    return {
      fresh: true,
      reason: 'no-git',
      hint: 'Index predates git tracking. Run cotx_compile to enable staleness detection.',
    };
  }

  const current = captureGitFingerprint(projectRoot);
  if (!current) {
    return { fresh: true, reason: 'no-git' };
  }

  if (current.head !== meta.git.head) {
    const drifted = getDiffedFiles(projectRoot, meta.git.head);
    return {
      fresh: false,
      reason: 'head-changed',
      compiled_head: meta.git.head,
      current_head: current.head,
      compiled_branch: meta.git.branch,
      current_branch: current.branch,
      drifted_files: drifted,
      hint: `Index compiled on ${meta.git.head.slice(0, 8)} (${meta.git.branch}); now on ${current.head.slice(0, 8)} (${current.branch}). Call cotx_compile mode=delta files=[${drifted.length} files] or cotx_prepare_task to refresh.`,
    };
  }

  const currentDirtyFingerprint = meta.git.ignore_fingerprint
    ? current.dirty_fingerprint
    : captureLegacyDirtyFingerprint(projectRoot) ?? current.dirty_fingerprint;
  if (currentDirtyFingerprint !== meta.git.dirty_fingerprint) {
    const drifted = getDiffedFiles(projectRoot);
    return {
      fresh: false,
      reason: 'working-tree-dirty',
      compiled_head: meta.git.head,
      current_head: current.head,
      compiled_branch: meta.git.branch,
      current_branch: current.branch,
      compiled_dirty_fingerprint: meta.git.dirty_fingerprint,
      current_dirty_fingerprint: currentDirtyFingerprint,
      drifted_files: drifted,
      hint: `Working tree has ${drifted.length} uncommitted file(s) not reflected in the index. Call cotx_compile mode=delta files=[...] or cotx_prepare_task to refresh.`,
    };
  }

  return { fresh: true };
}

/**
 * Shape returned to MCP read-tool callers. Stable key names so clients can
 * detect the annotation reliably.
 */
export interface StaleAnnotation {
  stale_against_head: true;
  stale_reason: FreshnessReason;
  stale_hint: string;
  compiled_head?: string;
  current_head?: string;
  compiled_branch?: string;
  current_branch?: string;
  drifted_files_count?: number;
}

/** Convert a stale FreshnessStatus into the subset of fields annotated into
 *  MCP read responses. Returns null when the index is fresh. */
export function staleAnnotation(status: FreshnessStatus): StaleAnnotation | null {
  if (status.fresh) return null;
  if (status.reason === 'no-git') return null; // informational only
  return {
    stale_against_head: true,
    stale_reason: status.reason ?? 'no-meta',
    stale_hint: status.hint ?? 'Index is stale. Call cotx_prepare_task to refresh.',
    compiled_head: status.compiled_head,
    current_head: status.current_head,
    compiled_branch: status.compiled_branch,
    current_branch: status.current_branch,
    drifted_files_count: status.drifted_files?.length,
  };
}

/** Re-exported for callers that only need the current branch (e.g. logs). */
export function currentBranch(projectRoot: string): string | undefined {
  return tryReadGitValue(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

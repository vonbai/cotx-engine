import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface GitFingerprint {
  head: string;
  branch: string;
  dirty_fingerprint: string;
  dirty_files_count?: number;
  ignore_fingerprint?: string;
  worktree_path?: string;
}

export interface CotxSeedWorktree {
  path: string;
  head?: string;
  branch?: string;
  drifted_files_count?: number;
}

export function tryReadGitValue(projectRoot: string, args: string[]): string | undefined {
  try {
    const value = execSync(`git ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isGitRepo(projectRoot: string): boolean {
  return tryReadGitValue(projectRoot, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function captureLegacyDirtyFingerprint(projectRoot: string): string | undefined {
  if (!isGitRepo(projectRoot)) return undefined;
  const porcelain = tryReadGitValue(projectRoot, ['status', '--porcelain']) ?? '';
  return createHash('sha256').update(porcelain).digest('hex').slice(0, 16);
}

const normalizeGitPath = (value: string): string => value.replace(/\\/g, '/');

const resolveInsideProject = (projectRoot: string, relativePath: string): string | null => {
  const absoluteRoot = path.resolve(projectRoot);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (absolutePath === absoluteRoot || absolutePath.startsWith(absoluteRoot + path.sep)) {
    return absolutePath;
  }
  return null;
};

const hashFileContent = (hash: ReturnType<typeof createHash>, filePath: string): void => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      hash.update(`non-file:${stat.size}:${stat.mtimeMs}`);
      return;
    }
    hash.update(fs.readFileSync(filePath));
  } catch {
    hash.update('<missing>');
  }
};

function getGitExcludePath(projectRoot: string): string | undefined {
  const raw = tryReadGitValue(projectRoot, ['rev-parse', '--git-path', 'info/exclude']);
  if (!raw) return undefined;
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function hasCotxIgnorePattern(content: string): boolean {
  const normalized = content.split('\n').map((line) => line.trim().replace(/\/$/, ''));
  return normalized.includes('.cotx') || normalized.includes('/.cotx');
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function captureIgnoreFingerprint(projectRoot: string): string {
  const hash = createHash('sha256');
  const files = [
    path.join(projectRoot, '.gitignore'),
    path.join(projectRoot, '.cotxignore'),
    getGitExcludePath(projectRoot),
  ].filter((filePath): filePath is string => Boolean(filePath));

  for (const filePath of files) {
    hash.update(path.basename(filePath));
    hash.update('\0');
    hash.update(readTextIfExists(filePath));
    hash.update('\0');
  }

  return hash.digest('hex').slice(0, 16);
}

export function captureGitFingerprint(projectRoot: string): GitFingerprint | undefined {
  if (!isGitRepo(projectRoot)) return undefined;
  const head = tryReadGitValue(projectRoot, ['rev-parse', 'HEAD']);
  const branch = tryReadGitValue(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head || !branch) return undefined;
  const worktreePath = tryReadGitValue(projectRoot, ['rev-parse', '--show-toplevel']);
  const porcelain = tryReadGitValue(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all']) ?? '';
  const changedFiles = getDiffedFiles(projectRoot);
  const ignoreFingerprint = captureIgnoreFingerprint(projectRoot);

  const hash = createHash('sha256');
  hash.update('status\0');
  hash.update(porcelain);
  hash.update('\0ignore\0');
  hash.update(ignoreFingerprint);

  for (const file of changedFiles) {
    const normalized = normalizeGitPath(file);
    hash.update('\0file\0');
    hash.update(normalized);
    hash.update('\0content\0');
    const absolutePath = resolveInsideProject(projectRoot, normalized);
    if (!absolutePath) {
      hash.update('<outside-project>');
      continue;
    }
    hashFileContent(hash, absolutePath);
  }

  const dirty_fingerprint = hash.digest('hex').slice(0, 16);
  return {
    head,
    branch,
    dirty_fingerprint,
    dirty_files_count: changedFiles.length,
    ignore_fingerprint: ignoreFingerprint,
    ...(worktreePath ? { worktree_path: worktreePath } : {}),
  };
}

/**
 * Ensure git ignores .cotx/ so the local build artifact never accidentally
 * enters a commit. By default this writes the repo-local exclude file instead
 * of mutating the project's tracked .gitignore.
 * Returns true iff a change was written.
 */
export function ensureCotxGitignored(
  projectRoot: string,
  log?: (line: string) => void,
  options?: { persistToGitignore?: boolean },
): boolean {
  if (!isGitRepo(projectRoot)) return false;
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const gitignoreContent = readTextIfExists(gitignorePath);
  if (hasCotxIgnorePattern(gitignoreContent)) return false;

  const targetPath = options?.persistToGitignore ? gitignorePath : getGitExcludePath(projectRoot);
  if (!targetPath) return false;

  const content = readTextIfExists(targetPath);
  if (hasCotxIgnorePattern(content)) return false;

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const appendix = `${separator}\n# cotx-engine compiled map (local build artifact)\n.cotx/\n`;
  fs.appendFileSync(targetPath, appendix);
  log?.(`Added .cotx/ to ${targetPath}`);
  return true;
}

/**
 * Return files changed between `baseRef` and the current working tree.
 * When `baseRef` is omitted, uses the index (HEAD) as the base.
 */
export function getDiffedFiles(projectRoot: string, baseRef?: string): string[] {
  const parts: string[] = [];
  const against = baseRef ?? 'HEAD';
  const tracked = tryReadGitValue(projectRoot, ['diff', '--name-only', against]) ?? '';
  const staged = baseRef
    ? ''
    : tryReadGitValue(projectRoot, ['diff', '--cached', '--name-only']) ?? '';
  const untracked = baseRef
    ? ''
    : tryReadGitValue(projectRoot, ['ls-files', '--others', '--exclude-standard']) ?? '';
  for (const blob of [tracked, staged, untracked]) {
    for (const line of blob.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  return [...new Set(parts)].sort();
}

interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
}

function parseWorktreeList(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  const flush = (): void => {
    if (current?.path) entries.push(current as WorktreeEntry);
    current = null;
  };

  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length).trim() };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.trim() === '') {
      flush();
    }
  }
  flush();

  return entries;
}

function readSeedGitMeta(seedPath: string): GitFingerprint | undefined {
  try {
    const raw = fs.readFileSync(path.join(seedPath, '.cotx', 'meta.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as { git?: GitFingerprint } | undefined;
    return parsed?.git;
  } catch {
    return undefined;
  }
}

function countDiffedFiles(projectRoot: string, baseRef?: string): number {
  if (!baseRef) return Number.MAX_SAFE_INTEGER;
  const raw = tryReadGitValue(projectRoot, ['diff', '--name-only', baseRef, 'HEAD']) ?? '';
  return raw.split('\n').map((line) => line.trim()).filter(Boolean).length;
}

/**
 * Find the best sibling worktree with a fresh .cotx/ index that can seed this
 * worktree. The caller still owns copying and delta-compiling drifted files.
 */
export function findBestCotxSeedWorktree(projectRoot: string): CotxSeedWorktree | undefined {
  if (!isGitRepo(projectRoot)) return undefined;
  const raw = tryReadGitValue(projectRoot, ['worktree', 'list', '--porcelain']);
  if (!raw) return undefined;

  const currentRoot = path.resolve(tryReadGitValue(projectRoot, ['rev-parse', '--show-toplevel']) ?? projectRoot);
  const currentHead = tryReadGitValue(projectRoot, ['rev-parse', 'HEAD']);
  const candidates: CotxSeedWorktree[] = [];

  for (const worktree of parseWorktreeList(raw)) {
    const candidatePath = path.resolve(worktree.path);
    if (candidatePath === currentRoot) continue;
    if (!fs.existsSync(path.join(candidatePath, '.cotx', 'meta.yaml'))) continue;

    const metaGit = readSeedGitMeta(candidatePath);
    if (metaGit) {
      const currentCandidate = captureGitFingerprint(candidatePath);
      if (!currentCandidate) continue;
      const dirtyFingerprint = metaGit.ignore_fingerprint
        ? currentCandidate.dirty_fingerprint
        : captureLegacyDirtyFingerprint(candidatePath);
      if (
        currentCandidate.head !== metaGit.head ||
        dirtyFingerprint !== metaGit.dirty_fingerprint
      ) {
        continue;
      }
    }

    const seedHead = metaGit?.head ?? worktree.head;
    const driftedFilesCount =
      seedHead && currentHead && seedHead === currentHead
        ? 0
        : countDiffedFiles(projectRoot, seedHead);

    candidates.push({
      path: candidatePath,
      head: seedHead,
      branch: metaGit?.branch ?? worktree.branch,
      drifted_files_count: driftedFilesCount,
    });
  }

  return candidates.sort((a, b) => {
    const byDrift = (a.drifted_files_count ?? Number.MAX_SAFE_INTEGER) -
      (b.drifted_files_count ?? Number.MAX_SAFE_INTEGER);
    if (byDrift !== 0) return byDrift;
    return a.path.localeCompare(b.path);
  })[0];
}

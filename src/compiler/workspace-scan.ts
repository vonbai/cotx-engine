import fs from 'node:fs';
import path from 'node:path';

export type WorkspaceInputCandidateKind =
  | 'readme'
  | 'agent-instructions'
  | 'docs'
  | 'architecture-doc'
  | 'manifest'
  | 'example'
  | 'cotx';

export type WorkspaceDirectoryKind =
  | 'repo-root'
  | 'nested-repo'
  | 'package'
  | 'asset'
  | 'docs'
  | 'example'
  | 'cotx'
  | 'architecture-store';

export interface WorkspaceInputCandidate {
  path: string;
  kind: WorkspaceInputCandidateKind;
  reason: string;
  boundary: string;
}

export interface WorkspaceDirectory {
  path: string;
  kind: WorkspaceDirectoryKind;
  depth: number;
}

export interface WorkspaceLayoutScan {
  project_root: string;
  generated_at: string;
  directories: WorkspaceDirectory[];
  candidates: WorkspaceInputCandidate[];
  summary: {
    directories: number;
    candidates: number;
    repo_boundaries: number;
    packages: number;
    asset_dirs?: number;
    docs_dirs: number;
    example_dirs: number;
    cotx_present: boolean;
    architecture_store_present: boolean;
  };
}

export interface WorkspaceScanOptions {
  maxDepth?: number;
  maxCandidates?: number;
  generatedAt?: string;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_CANDIDATES = 400;

const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'requirements.txt',
  'tsconfig.json',
]);

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc', '.yaml', '.yml', '.json', '.mmd']);
const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.avif',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
]);

const SKIP_DIRS = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.cache',
  '.turbo',
  '.next',
]);

export function scanWorkspaceLayout(
  projectRoot: string,
  options: WorkspaceScanOptions = {},
): WorkspaceLayoutScan {
  const absoluteRoot = path.resolve(projectRoot);
  const stat = safeStat(absoluteRoot);
  if (!stat?.isDirectory()) {
    throw new Error(`Project root does not exist or is not a directory: ${projectRoot}`);
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const directories = new Map<string, WorkspaceDirectory>();
  const candidates = new Map<string, WorkspaceInputCandidate>();

  const addDirectory = (relPath: string, kind: WorkspaceDirectoryKind): void => {
    const normalized = normalizeRelPath(relPath || '.');
    const key = `${kind}:${normalized}`;
    if (directories.has(key)) return;
    directories.set(key, {
      path: normalized,
      kind,
      depth: normalized === '.' ? 0 : normalized.split('/').length,
    });
  };

  const addCandidate = (
    relPath: string,
    kind: WorkspaceInputCandidateKind,
    reason: string,
    boundary: string,
  ): void => {
    const normalized = normalizeRelPath(relPath);
    const key = `${kind}:${normalized}`;
    if (candidates.has(key)) return;
    candidates.set(key, {
      path: normalized,
      kind,
      reason,
      boundary: normalizeRelPath(boundary || '.'),
    });
  };

  addDirectory('.', 'repo-root');

  const walk = (dirAbs: string, depth: number, boundary: string): void => {
    if (depth > maxDepth) return;
    const entries = safeReadDir(dirAbs).sort((a, b) => a.name.localeCompare(b.name));
    const relDir = relativePath(absoluteRoot, dirAbs);

    if (relDir !== '.' && safeStat(path.join(dirAbs, '.git'))?.isDirectory()) {
      addDirectory(relDir, 'nested-repo');
      boundary = relDir;
    }

    if (entries.some((entry) => entry.isFile() && MANIFEST_NAMES.has(entry.name))) {
      addDirectory(relDir, 'package');
    }
    if (relDir !== '.' && entries.some((entry) => entry.isFile() && ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))) {
      addDirectory(relDir, 'asset');
    }

    if (relDir === '.cotx' || relDir.startsWith('.cotx/')) addDirectory('.cotx', 'cotx');
    if (relDir === '.cotx/architecture' || relDir.startsWith('.cotx/architecture/')) {
      addDirectory('.cotx/architecture', 'architecture-store');
    }

    const base = path.basename(relDir);
    if (
      !relDir.startsWith('.cotx') &&
      (relDir === 'docs' || relDir.startsWith('docs/') || base === 'docs' || base === 'doc' || base === 'architecture' || base === 'adr')
    ) {
      addDirectory(relDir === '.' ? base : relDir, 'docs');
    }
    if (relDir === 'example' || relDir === 'examples' || relDir.startsWith('example/') || relDir.startsWith('examples/')) {
      addDirectory(relDir, 'example');
    }

    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const rel = relativePath(absoluteRoot, abs);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        if (shouldSkipDir(rel, entry.name)) {
          if (rel === '.cotx') addDirectory(rel, 'cotx');
          continue;
        }
        if (rel === '.cotx') {
          addDirectory(rel, 'cotx');
        }
        walk(abs, depth + 1, boundary);
        continue;
      }
      if (!entry.isFile()) continue;
      scanFileCandidate(rel, boundary, addCandidate);
    }
  };

  walk(absoluteRoot, 0, '.');

  const orderedDirectories = [...directories.values()].sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  const orderedCandidates = [...candidates.values()]
    .sort((a, b) =>
      candidatePriority(a) - candidatePriority(b) ||
      a.path.localeCompare(b.path) ||
      a.kind.localeCompare(b.kind),
    )
    .slice(0, maxCandidates);
  return {
    project_root: absoluteRoot,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    directories: orderedDirectories,
    candidates: orderedCandidates,
    summary: {
      directories: orderedDirectories.length,
      candidates: orderedCandidates.length,
      repo_boundaries: orderedDirectories.filter((entry) => entry.kind === 'repo-root' || entry.kind === 'nested-repo').length,
      packages: orderedDirectories.filter((entry) => entry.kind === 'package').length,
      asset_dirs: orderedDirectories.filter((entry) => entry.kind === 'asset').length,
      docs_dirs: orderedDirectories.filter((entry) => entry.kind === 'docs').length,
      example_dirs: orderedDirectories.filter((entry) => entry.kind === 'example').length,
      cotx_present: orderedDirectories.some((entry) => entry.kind === 'cotx'),
      architecture_store_present: orderedDirectories.some((entry) => entry.kind === 'architecture-store'),
    },
  };
}

function scanFileCandidate(
  relPath: string,
  boundary: string,
  addCandidate: (
    relPath: string,
    kind: WorkspaceInputCandidateKind,
    reason: string,
    boundary: string,
  ) => void,
): void {
  const base = path.basename(relPath);
  const lower = base.toLowerCase();

  if (relPath.startsWith('example/') || relPath.startsWith('examples/')) {
    if (lower.startsWith('readme') || MANIFEST_NAMES.has(base) || DOC_EXTENSIONS.has(path.extname(relPath).toLowerCase())) {
      addCandidate(relPath, 'example', 'local example/reference material', boundary);
    }
    return;
  }
  if (lower.startsWith('readme')) {
    addCandidate(relPath, 'readme', 'README-like file', boundary);
    return;
  }
  if (base === 'AGENTS.md' || base === 'CLAUDE.md') {
    addCandidate(relPath, 'agent-instructions', 'agent instruction file', boundary);
    return;
  }
  if (MANIFEST_NAMES.has(base)) {
    addCandidate(relPath, 'manifest', 'project/package manifest', boundary);
    return;
  }
  if (relPath.startsWith('docs/') || relPath.startsWith('doc/') || relPath.startsWith('architecture/') || relPath.startsWith('adr/')) {
    if (!DOC_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return;
    const kind = relPath.includes('/architecture/') || relPath.startsWith('architecture/') || relPath.startsWith('adr/')
      ? 'architecture-doc'
      : 'docs';
    addCandidate(relPath, kind, 'documentation file', boundary);
    return;
  }
}

function shouldSkipDir(relPath: string, name: string): boolean {
  if (relPath === '.cotx') return false;
  return SKIP_DIRS.has(name);
}

function candidatePriority(candidate: WorkspaceInputCandidate): number {
  const kindPriority: Record<WorkspaceInputCandidateKind, number> = {
    readme: 0,
    'agent-instructions': 1,
    manifest: 2,
    'architecture-doc': 3,
    docs: 4,
    example: 10,
    cotx: 50,
  };

  let priority = kindPriority[candidate.kind] ?? 100;
  if (candidate.boundary === '.') priority -= 2;
  if (candidate.path.startsWith('example/') || candidate.path.startsWith('examples/')) priority += 20;
  if (candidate.path.startsWith('.cotx/')) priority += 100;
  return priority;
}

function safeStat(absPath: string): fs.Stats | null {
  try {
    return fs.statSync(absPath);
  } catch {
    return null;
  }
}

function safeReadDir(absPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(absPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function relativePath(projectRoot: string, absPath: string): string {
  const rel = normalizeRelPath(path.relative(projectRoot, absPath));
  return rel || '.';
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '') || '.';
}

import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import type { WorkspaceLayoutScan } from './workspace-scan.js';
import { createIgnoreFilter } from '../config/ignore-service.js';

const SOURCE_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.rb',
  '.swift',
  '.dart',
  '.vue',
  '.svelte',
]);

const PERIPHERAL_TOP_LEVEL_DIRS = new Set([
  'docs',
  'doc',
  'test',
  'tests',
  'example',
  'examples',
  'samples',
  'scripts',
  'tools',
  'tooling',
  'fixtures',
  'fixture',
  'benchmarks',
  'benchmark',
  'generated',
  '.generated',
]);

const TOOLING_ROOT_SEGMENTS = new Set(['scripts', 'tools', 'tooling', 'hack', 'hacks', 'bin']);
const TEST_ROOT_SEGMENTS = new Set(['test', 'tests', '__tests__']);
const EXAMPLE_ROOT_SEGMENTS = new Set(['example', 'examples', 'samples']);
const GENERATED_ROOT_SEGMENTS = new Set(['generated', '.generated', 'gen', '__generated__']);

export type SourceRootRole =
  | 'repo-core'
  | 'app'
  | 'package'
  | 'tooling'
  | 'test'
  | 'example'
  | 'generated'
  | 'unknown';

export type SourceRootBoundaryKind = 'repo-root' | 'package' | 'nested-repo' | 'inferred-package';

export interface SourceRootCandidate {
  path: string;
  role: SourceRootRole;
  boundary: string;
  boundary_kind: SourceRootBoundaryKind;
  reason: string;
  confidence: number;
  file_count: number;
  sample_files: string[];
  selected: boolean;
}

export interface SourceRootInventory {
  roots: SourceRootCandidate[];
  selected: SourceRootCandidate[];
  excluded: SourceRootCandidate[];
  selected_paths: string[];
  summary: {
    total_roots: number;
    selected_roots: number;
    excluded_roots: number;
    by_role: Record<SourceRootRole, number>;
    by_boundary_kind: Record<SourceRootBoundaryKind, number>;
  };
}

interface Boundary {
  path: string;
  kind: SourceRootBoundaryKind;
}

interface LocalRootCandidate {
  local_path: string;
  reason: string;
  confidence: number;
}

export interface SourceRootInventoryOptions {
  workspaceLayout?: WorkspaceLayoutScan | null;
}

export async function collectProjectSourceRootInventory(
  projectRoot: string,
  options: SourceRootInventoryOptions = {},
): Promise<SourceRootInventory> {
  const graphFilePaths = readGraphFilePaths(projectRoot);
  if (graphFilePaths.length > 0) {
    return collectSourceRootInventory(graphFilePaths, options);
  }
  const ignoreFilter = await createIgnoreFilter(projectRoot);
  const files = await glob('**/*', {
    cwd: projectRoot,
    nodir: true,
    dot: false,
    ignore: ignoreFilter,
  });
  return collectSourceRootInventory(files, options);
}

export function collectSourceRootInventory(
  filePaths: string[],
  options: SourceRootInventoryOptions = {},
): SourceRootInventory {
  const normalizedFiles = [...new Set(
    filePaths
      .map(normalizeRelPath)
      .filter((filePath) => filePath !== '.')
      .filter(isSourceCodeFilePath),
  )].sort();

  const boundaries = buildBoundaries(normalizedFiles, options.workspaceLayout);
  const assignedFiles = assignFilesToBoundaries(normalizedFiles, boundaries);
  const byRoot = new Map<string, SourceRootCandidate>();

  for (const boundary of boundaries) {
    const files = assignedFiles.get(boundary.path) ?? [];
    if (files.length === 0) continue;
    const relativeFiles = files
      .map((filePath) => relativeWithinBoundary(boundary.path, filePath))
      .filter((filePath) => filePath.length > 0)
      .sort();

    const localRoots = detectBoundaryRoots(boundary, relativeFiles);
    for (const localRoot of localRoots) {
      const fullPath = joinBoundaryPath(boundary.path, localRoot.local_path);
      const matchingFiles = files
        .filter((filePath) => fileBelongsToRoot(fullPath, boundary.path, filePath))
        .sort();
      if (matchingFiles.length === 0) continue;

      const role = classifyRootRole(fullPath, boundary);
      const selected = role === 'repo-core' || role === 'app' || role === 'package';
      const candidate: SourceRootCandidate = {
        path: fullPath,
        role,
        boundary: boundary.path,
        boundary_kind: boundary.kind,
        reason: localRoot.reason,
        confidence: localRoot.confidence,
        file_count: matchingFiles.length,
        sample_files: matchingFiles.slice(0, 8),
        selected,
      };
      const existing = byRoot.get(fullPath);
      if (!existing || existing.confidence < candidate.confidence) {
        byRoot.set(fullPath, candidate);
      }
    }
  }

  const roots = [...byRoot.values()].sort((a, b) => a.path.localeCompare(b.path));
  const selected = roots.filter((root) => root.selected);
  const excluded = roots.filter((root) => !root.selected);
  const selectedPaths = selected
    .map((root) => root.path)
    .sort((a, b) => {
      if (a === '.') return 1;
      if (b === '.') return -1;
      return b.length - a.length || a.localeCompare(b);
    });

  return {
    roots,
    selected,
    excluded,
    selected_paths: selectedPaths,
    summary: {
      total_roots: roots.length,
      selected_roots: selected.length,
      excluded_roots: excluded.length,
      by_role: countByRole(roots),
      by_boundary_kind: countByBoundaryKind(roots),
    },
  };
}

export function detectSourceRoots(
  filePaths: string[],
  options: SourceRootInventoryOptions = {},
): string[] {
  return collectSourceRootInventory(filePaths, options).selected_paths;
}

export function isSourceCodeFilePath(filePath: string): boolean {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return SOURCE_FILE_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

function buildBoundaries(
  filePaths: string[],
  workspaceLayout: WorkspaceLayoutScan | null | undefined,
): Boundary[] {
  const byPath = new Map<string, Boundary>();
  byPath.set('.', { path: '.', kind: 'repo-root' });

  for (const filePath of filePaths) {
    const inferred = inferBoundaryFromFile(filePath);
    if (inferred) byPath.set(inferred.path, inferred);
  }

  if (workspaceLayout) {
    for (const directory of workspaceLayout.directories) {
      if (directory.kind !== 'package' && directory.kind !== 'nested-repo' && directory.kind !== 'repo-root') continue;
      const boundaryPath = normalizeRelPath(directory.path);
      const kind: SourceRootBoundaryKind =
        directory.kind === 'repo-root'
          ? 'repo-root'
          : directory.kind === 'nested-repo'
            ? 'nested-repo'
            : 'package';
      byPath.set(boundaryPath, { path: boundaryPath, kind });
    }
  }

  return [...byPath.values()].sort((a, b) => {
    if (a.path === '.') return 1;
    if (b.path === '.') return -1;
    return b.path.length - a.path.length || a.path.localeCompare(b.path);
  });
}

function inferBoundaryFromFile(filePath: string): Boundary | null {
  const match = filePath.match(/^(packages|apps|libs|crates)\/([^/]+)\//);
  if (!match) return null;
  return {
    path: `${match[1]}/${match[2]}`,
    kind: 'inferred-package',
  };
}

function assignFilesToBoundaries(filePaths: string[], boundaries: Boundary[]): Map<string, string[]> {
  const assigned = new Map<string, string[]>();
  for (const boundary of boundaries) assigned.set(boundary.path, []);

  for (const filePath of filePaths) {
    const boundary = boundaries.find((candidate) => belongsToBoundary(candidate.path, filePath)) ?? { path: '.', kind: 'repo-root' as const };
    const list = assigned.get(boundary.path) ?? [];
    list.push(filePath);
    assigned.set(boundary.path, list);
  }

  return assigned;
}

function belongsToBoundary(boundaryPath: string, filePath: string): boolean {
  if (boundaryPath === '.') return true;
  return filePath === boundaryPath || filePath.startsWith(`${boundaryPath}/`);
}

function relativeWithinBoundary(boundaryPath: string, filePath: string): string {
  if (boundaryPath === '.') return filePath;
  return normalizeRelPath(filePath.slice(boundaryPath.length + 1));
}

function detectBoundaryRoots(boundary: Boundary, relativeFiles: string[]): LocalRootCandidate[] {
  const byLocalRoot = new Map<string, LocalRootCandidate>();
  const add = (localPath: string, reason: string, confidence: number): void => {
    const normalized = normalizeRelPath(localPath);
    if (normalized === '.') return;
    const existing = byLocalRoot.get(normalized);
    if (!existing || existing.confidence < confidence) {
      byLocalRoot.set(normalized, { local_path: normalized, reason, confidence });
    }
  };

  if (relativeFiles.some((filePath) => filePath.startsWith('src/main/java/'))) {
    add('src/main/java', 'Detected Java source root within boundary.', 1);
  }
  if (relativeFiles.some((filePath) => filePath.startsWith('src/main/kotlin/'))) {
    add('src/main/kotlin', 'Detected Kotlin source root within boundary.', 1);
  }
  if (relativeFiles.some((filePath) => filePath.startsWith('src/'))) {
    add('src', 'Detected src/ source root within boundary.', 0.98);
  }

  for (const filePath of relativeFiles) {
    const cmdMatch = filePath.match(/^cmd\/([^/]+)\//);
    if (cmdMatch) add(`cmd/${cmdMatch[1]}`, 'Detected Go command source root.', 1);
  }

  if (relativeFiles.some((filePath) => filePath.startsWith('internal/'))) {
    add('internal', 'Detected internal/ source root within boundary.', 0.98);
  }
  if (relativeFiles.some((filePath) => filePath.startsWith('pkg/'))) {
    add('pkg', 'Detected pkg/ source root within boundary.', 0.98);
  }

  for (const filePath of relativeFiles) {
    const pythonMatch = filePath.match(/^([^/.][^/]*)\/.+\.py$/);
    if (!pythonMatch) continue;
    const firstDir = pythonMatch[1];
    if (PERIPHERAL_TOP_LEVEL_DIRS.has(firstDir)) continue;
    add(firstDir, 'Detected root-level Python package within boundary.', 0.86);
  }

  if (byLocalRoot.size === 0) {
    const hasRootLevelSourceFiles = relativeFiles.some((filePath) => !filePath.includes('/'));
    const topLevelDirs = [...new Set(
      relativeFiles
        .filter((filePath) => filePath.includes('/'))
        .map((filePath) => filePath.split('/')[0] ?? filePath)
        .filter(Boolean)
        .filter((dir) => dir !== '.' && !PERIPHERAL_TOP_LEVEL_DIRS.has(dir)),
    )].sort();

    if (boundary.kind === 'repo-root') {
      if (topLevelDirs.length === 1 && !hasRootLevelSourceFiles) {
        add(topLevelDirs[0], 'Fallback top-level source directory within repo root.', 0.6);
      }
    } else {
      add('.', 'No stronger convention found; use the boundary root as the source-root anchor.', 0.58);
    }
  }

  return [...byLocalRoot.values()].sort((a, b) => a.local_path.localeCompare(b.local_path));
}

function joinBoundaryPath(boundaryPath: string, localPath: string): string {
  if (localPath === '.') return boundaryPath;
  if (boundaryPath === '.') return localPath;
  return `${boundaryPath}/${localPath}`;
}

function fileBelongsToRoot(rootPath: string, boundaryPath: string, filePath: string): boolean {
  if (rootPath === boundaryPath) {
    return belongsToBoundary(boundaryPath, filePath);
  }
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

function classifyRootRole(rootPath: string, boundary: Boundary): SourceRootRole {
  const segments = rootPath.split('/');
  const first = segments[0] ?? rootPath;

  if (segments.some((segment) => GENERATED_ROOT_SEGMENTS.has(segment))) return 'generated';
  if (segments.some((segment) => EXAMPLE_ROOT_SEGMENTS.has(segment))) return 'example';
  if (segments.some((segment) => TEST_ROOT_SEGMENTS.has(segment))) return 'test';
  if (segments.some((segment) => TOOLING_ROOT_SEGMENTS.has(segment))) return 'tooling';

  if (rootPath.startsWith('apps/')) return 'app';
  if (rootPath.startsWith('packages/') || rootPath.startsWith('libs/') || rootPath.startsWith('crates/')) return 'package';
  if (rootPath.startsWith('cmd/')) return 'app';
  if (
    rootPath === 'src' ||
    rootPath.startsWith('src/') ||
    rootPath.startsWith('internal/') ||
    rootPath === 'internal' ||
    rootPath.startsWith('pkg/') ||
    rootPath === 'pkg'
  ) {
    return 'repo-core';
  }

  if (boundary.kind === 'nested-repo') {
    return first === 'example' || first === 'examples' ? 'example' : 'unknown';
  }
  if (boundary.kind === 'package' || boundary.kind === 'inferred-package') {
    return boundary.path.startsWith('apps/') ? 'app' : 'package';
  }

  return 'repo-core';
}

function countByRole(roots: SourceRootCandidate[]): Record<SourceRootRole, number> {
  const result: Record<SourceRootRole, number> = {
    'repo-core': 0,
    app: 0,
    package: 0,
    tooling: 0,
    test: 0,
    example: 0,
    generated: 0,
    unknown: 0,
  };
  for (const root of roots) result[root.role] += 1;
  return result;
}

function countByBoundaryKind(roots: SourceRootCandidate[]): Record<SourceRootBoundaryKind, number> {
  const result: Record<SourceRootBoundaryKind, number> = {
    'repo-root': 0,
    package: 0,
    'nested-repo': 0,
    'inferred-package': 0,
  };
  for (const root of roots) result[root.boundary_kind] += 1;
  return result;
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '') || '.';
}

function readGraphFilePaths(projectRoot: string): string[] {
  const graphPath = path.join(projectRoot, '.cotx', 'graph', 'nodes.json');
  if (!pathExists(graphPath)) return [];
  try {
    const filePaths = new Set<string>();
    for (const line of readLines(graphPath)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed) as { properties?: { filePath?: unknown } };
      const filePath = typeof parsed.properties?.filePath === 'string' ? normalizeRelPath(parsed.properties.filePath) : null;
      if (filePath && isSourceCodeFilePath(filePath)) filePaths.add(filePath);
    }
    return [...filePaths].sort();
  } catch {
    return [];
  }
}

function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  } catch {
    return [];
  }
}

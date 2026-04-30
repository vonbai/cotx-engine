import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  scanWorkspaceLayout,
  type WorkspaceInputCandidateKind,
  type WorkspaceLayoutScan,
} from './workspace-scan.js';
import { extendArray } from '../core/shared/array-utils.js';

export type OnboardingBudget = 'tiny' | 'standard' | 'deep';

export type OnboardingSourceKind = WorkspaceInputCandidateKind;

export type ConsistencyStatus = 'confirmed' | 'contradicted' | 'stale-doc' | 'graph-gap' | 'unknown';

export interface OnboardingEvidence {
  kind: 'file' | 'doc-reference' | 'manifest-field' | 'cotx-meta' | 'architecture-store';
  ref: string;
  detail?: string;
}

export interface OnboardingSource {
  path: string;
  kind: OnboardingSourceKind;
  size_bytes: number;
  preview_hash: string;
  truncated: boolean;
  headings: string[];
  referenced_paths: string[];
  excerpt?: string;
  metadata?: Record<string, unknown>;
  warnings?: string[];
}

export interface ArchitectureHypothesis {
  id: string;
  kind:
    | 'project-purpose'
    | 'runtime'
    | 'workspace-layout'
    | 'command-surface'
    | 'semantic-map'
    | 'architecture-store';
  statement: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: OnboardingEvidence[];
}

export interface ConsistencyFinding {
  status: ConsistencyStatus;
  subject: string;
  reason: string;
  evidence: OnboardingEvidence[];
}

export interface OnboardingContext {
  project_root: string;
  generated_at: string;
  budget: OnboardingBudget;
  workspace_scan: WorkspaceLayoutScan;
  sources: OnboardingSource[];
  hypotheses: ArchitectureHypothesis[];
  consistency: Record<ConsistencyStatus, ConsistencyFinding[]>;
  summary: {
    source_count: number;
    sources_by_kind: Record<OnboardingSourceKind, number>;
    hypothesis_count: number;
    consistency_counts: Record<ConsistencyStatus, number>;
    has_cotx: boolean;
    has_storage_v2_truth: boolean;
    has_architecture_store: boolean;
    graph_file_count: number | null;
    graph_file_index_status: 'complete' | 'partial' | 'missing';
    workspace_directories: number;
    workspace_candidates: number;
    asset_directories: number;
    repo_boundaries: number;
    package_boundaries: number;
    warnings: string[];
  };
}

export interface OnboardingContextOptions {
  budget?: OnboardingBudget;
  includeExcerpts?: boolean;
}

interface OnboardingLimits {
  maxFilesPerCategory: number;
  maxDocFiles: number;
  maxExampleFiles: number;
  maxBytesPerFile: number;
  maxFindings: number;
  maxReferencesPerSource: number;
  maxGraphIndexBytes: number;
  maxScanDepth: number;
  maxScanCandidates: number;
}

interface FilePreview {
  content: string;
  sizeBytes: number;
  previewHash: string;
  truncated: boolean;
  warnings: string[];
}

interface CotxSnapshot {
  exists: boolean;
  hasStorageV2Truth: boolean;
  hasArchitectureStore: boolean;
  compiledAt?: string;
  architectureGeneratedAt?: string;
  architecturePerspectives?: string[];
  graphFiles: Set<string> | null;
  graphFileIndexStatus: 'complete' | 'partial' | 'missing';
  warnings: string[];
}

const BUDGETS: Record<OnboardingBudget, OnboardingLimits> = {
  tiny: {
    maxFilesPerCategory: 8,
    maxDocFiles: 12,
    maxExampleFiles: 8,
    maxBytesPerFile: 4_096,
    maxFindings: 40,
    maxReferencesPerSource: 12,
    maxGraphIndexBytes: 1_000_000,
    maxScanDepth: 3,
    maxScanCandidates: 80,
  },
  standard: {
    maxFilesPerCategory: 20,
    maxDocFiles: 50,
    maxExampleFiles: 25,
    maxBytesPerFile: 12_000,
    maxFindings: 120,
    maxReferencesPerSource: 30,
    maxGraphIndexBytes: 25_000_000,
    maxScanDepth: 5,
    maxScanCandidates: 250,
  },
  deep: {
    maxFilesPerCategory: 50,
    maxDocFiles: 140,
    maxExampleFiles: 80,
    maxBytesPerFile: 32_000,
    maxFindings: 300,
    maxReferencesPerSource: 80,
    maxGraphIndexBytes: 100_000_000,
    maxScanDepth: 7,
    maxScanCandidates: 700,
  },
};

const VALIDATED_SOURCE_PREFIXES = [
  'src/',
  'app/',
  'apps/',
  'packages/',
  'lib/',
  'cmd/',
  'internal/',
  'pkg/',
  'crates/',
  'test/',
  'tests/',
];

const SKIPPED_WALK_DIRS = new Set([
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

export function collectOnboardingContext(
  projectRoot: string,
  options: OnboardingContextOptions = {},
): OnboardingContext {
  const absoluteRoot = path.resolve(projectRoot);
  const rootStat = safeStat(absoluteRoot);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Project root does not exist or is not a directory: ${projectRoot}`);
  }

  const budget = options.budget ?? 'standard';
  const limits = BUDGETS[budget];
  const includeExcerpts = options.includeExcerpts ?? budget !== 'tiny';
  const warnings: string[] = [];
  const sourcesByPath = new Map<string, OnboardingSource>();
  const workspaceScan = scanWorkspaceLayout(absoluteRoot, {
    maxDepth: limits.maxScanDepth,
    maxCandidates: limits.maxScanCandidates,
  });

  const addSource = (source: OnboardingSource): void => {
    const key = `${source.kind}:${source.path}`;
    if (!sourcesByPath.has(key)) sourcesByPath.set(key, source);
  };

  for (const candidate of selectOnboardingCandidates(workspaceScan.candidates, limits)) {
    addSource(readTextSource(absoluteRoot, candidate.path, candidate.kind, limits, includeExcerpts));
  }

  const sources = [...sourcesByPath.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
  for (const source of sources) {
    if (source.warnings) warnings.push(...source.warnings.map((warning) => `${source.path}: ${warning}`));
  }

  const cotx = readCotxSnapshot(absoluteRoot, limits);
  extendArray(warnings, cotx.warnings);

  const hypotheses = buildHypotheses(sources, cotx);
  const consistencyFindings = buildConsistencyFindings(absoluteRoot, sources, cotx, limits);
  const consistency = groupConsistency(consistencyFindings);
  const sourcesByKind = countSourcesByKind(sources);
  const consistencyCounts = countConsistencyByStatus(consistency);

  return {
    project_root: absoluteRoot,
    generated_at: new Date().toISOString(),
    budget,
    workspace_scan: workspaceScan,
    sources,
    hypotheses,
    consistency,
    summary: {
      source_count: sources.length,
      sources_by_kind: sourcesByKind,
      hypothesis_count: hypotheses.length,
      consistency_counts: consistencyCounts,
      has_cotx: cotx.exists,
      has_storage_v2_truth: cotx.hasStorageV2Truth,
      has_architecture_store: cotx.hasArchitectureStore,
      graph_file_count: cotx.graphFiles?.size ?? null,
      graph_file_index_status: cotx.graphFileIndexStatus,
      workspace_directories: workspaceScan.summary.directories,
      workspace_candidates: workspaceScan.summary.candidates,
      asset_directories: workspaceScan.summary.asset_dirs ?? 0,
      repo_boundaries: workspaceScan.summary.repo_boundaries,
      package_boundaries: workspaceScan.summary.packages,
      warnings,
    },
  };
}

function selectOnboardingCandidates(
  candidates: WorkspaceLayoutScan['candidates'],
  limits: OnboardingLimits,
): WorkspaceLayoutScan['candidates'] {
  const selected: WorkspaceLayoutScan['candidates'] = [];
  const generalCounts = new Map<OnboardingSourceKind, number>();
  let docsCount = 0;
  let exampleCount = 0;

  for (const candidate of candidates) {
    if (candidate.kind === 'cotx') continue;

    if (candidate.kind === 'docs' || candidate.kind === 'architecture-doc') {
      if (docsCount >= limits.maxDocFiles) continue;
      docsCount += 1;
      selected.push(candidate);
      continue;
    }

    if (candidate.kind === 'example') {
      if (exampleCount >= limits.maxExampleFiles) continue;
      exampleCount += 1;
      selected.push(candidate);
      continue;
    }

    const count = generalCounts.get(candidate.kind) ?? 0;
    if (count >= limits.maxFilesPerCategory) continue;
    generalCounts.set(candidate.kind, count + 1);
    selected.push(candidate);
  }

  return selected;
}

function readTextSource(
  projectRoot: string,
  relPath: string,
  kind: OnboardingSourceKind,
  limits: OnboardingLimits,
  includeExcerpt: boolean,
): OnboardingSource {
  const preview = readFilePreview(path.join(projectRoot, relPath), limits.maxBytesPerFile);
  const metadata = extractMetadata(relPath, preview.content);
  const referencedPaths = extractReferencedPaths(preview.content).slice(0, limits.maxReferencesPerSource);
  return {
    path: normalizeRelPath(relPath),
    kind,
    size_bytes: preview.sizeBytes,
    preview_hash: preview.previewHash,
    truncated: preview.truncated,
    headings: extractHeadings(preview.content),
    referenced_paths: referencedPaths,
    ...(includeExcerpt ? { excerpt: excerpt(preview.content) } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(preview.warnings.length > 0 ? { warnings: preview.warnings } : {}),
  };
}

function readFilePreview(absPath: string, maxBytes: number): FilePreview {
  const warnings: string[] = [];
  const stat = safeStat(absPath);
  if (!stat?.isFile()) {
    return {
      content: '',
      sizeBytes: 0,
      previewHash: hashText(''),
      truncated: false,
      warnings: [`missing file: ${absPath}`],
    };
  }

  const byteLimit = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(byteLimit);
  let bytesRead = 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    bytesRead = fs.readSync(fd, buffer, 0, byteLimit, 0);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  const content = buffer.subarray(0, bytesRead).toString('utf-8');
  return {
    content,
    sizeBytes: stat.size,
    previewHash: hashText(content),
    truncated: stat.size > maxBytes,
    warnings,
  };
}

function extractMetadata(relPath: string, content: string): Record<string, unknown> {
  const base = path.basename(relPath);
  if (base === 'package.json' || relPath.endsWith('/package.json')) {
    const parsed = parseJsonRecord(content);
    if (!parsed) return { parse_error: 'invalid package.json preview' };
    const scripts = isRecord(parsed.scripts) ? Object.keys(parsed.scripts).sort() : [];
    const bin = typeof parsed.bin === 'string'
      ? [parsed.bin]
      : isRecord(parsed.bin)
        ? Object.keys(parsed.bin).sort()
        : [];
    return {
      manifest_type: 'npm',
      package_name: typeof parsed.name === 'string' ? parsed.name : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      type: typeof parsed.type === 'string' ? parsed.type : undefined,
      workspaces: parsePackageWorkspaces(parsed.workspaces),
      bin,
      scripts,
    };
  }

  if (base === 'go.mod') {
    const moduleLine = content.split('\n').find((line) => line.startsWith('module '));
    return { manifest_type: 'go', module: moduleLine?.slice('module '.length).trim() };
  }

  if (base === 'Cargo.toml') {
    return { manifest_type: 'cargo', package_name: extractTomlName(content) };
  }

  if (base === 'pyproject.toml') {
    return { manifest_type: 'python', package_name: extractTomlName(content) };
  }

  if (relPath === '.cotx/meta.yaml') {
    const parsed = parseYamlRecord(content);
    return {
      cotx_project: typeof parsed?.project === 'string' ? parsed.project : undefined,
      compiled_at: typeof parsed?.compiled_at === 'string' ? parsed.compiled_at : undefined,
      stats: isRecord(parsed?.stats) ? parsed.stats : undefined,
    };
  }

  if (relPath === '.cotx/architecture/meta.yaml') {
    const parsed = parseYamlRecord(content);
    return {
      architecture_generated_at: typeof parsed?.generated_at === 'string' ? parsed.generated_at : undefined,
      perspectives: Array.isArray(parsed?.perspectives) ? parsed.perspectives : undefined,
      mode: typeof parsed?.mode === 'string' ? parsed.mode : undefined,
    };
  }

  return {};
}

function buildHypotheses(sources: OnboardingSource[], cotx: CotxSnapshot): ArchitectureHypothesis[] {
  const hypotheses = new Map<string, ArchitectureHypothesis>();
  const add = (hypothesis: ArchitectureHypothesis): void => {
    if (!hypotheses.has(hypothesis.id)) hypotheses.set(hypothesis.id, hypothesis);
  };

  const readme = sources.find((source) => source.kind === 'readme');
  const readmeTitle = readme?.headings[0];
  if (readme && readmeTitle) {
    add({
      id: 'project-purpose:readme-title',
      kind: 'project-purpose',
      statement: `README positions the project around "${readmeTitle}".`,
      confidence: 'medium',
      evidence: [{ kind: 'file', ref: readme.path, detail: 'first heading' }],
    });
  }

  for (const source of sources.filter((item) => item.kind === 'manifest')) {
    const metadata = source.metadata ?? {};
    if (metadata.manifest_type === 'npm' && typeof metadata.package_name === 'string') {
      add({
        id: `runtime:npm:${slug(source.path)}`,
        kind: 'runtime',
        statement: `Repository includes npm package "${metadata.package_name}".`,
        confidence: 'high',
        evidence: [{ kind: 'file', ref: source.path, detail: 'package.json name' }],
      });
    }

    const workspaces = arrayOfStrings(metadata.workspaces);
    if (workspaces.length > 0) {
      add({
        id: `workspace-layout:${slug(source.path)}`,
        kind: 'workspace-layout',
        statement: `Manifest declares workspace patterns: ${workspaces.join(', ')}.`,
        confidence: 'high',
        evidence: [{ kind: 'manifest-field', ref: `${source.path}#workspaces` }],
      });
    }

    const scripts = arrayOfStrings(metadata.scripts);
    const usefulScripts = scripts.filter((script) => ['build', 'test', 'lint', 'verify'].includes(script));
    if (usefulScripts.length > 0) {
      add({
        id: `command-surface:scripts:${slug(source.path)}`,
        kind: 'command-surface',
        statement: `Manifest exposes build/test commands: ${usefulScripts.join(', ')}.`,
        confidence: 'high',
        evidence: [{ kind: 'manifest-field', ref: `${source.path}#scripts` }],
      });
    }

    const bins = arrayOfStrings(metadata.bin);
    if (bins.length > 0) {
      add({
        id: `command-surface:bin:${slug(source.path)}`,
        kind: 'command-surface',
        statement: `Manifest exposes CLI binaries: ${bins.join(', ')}.`,
        confidence: 'high',
        evidence: [{ kind: 'manifest-field', ref: `${source.path}#bin` }],
      });
    }
  }

  if (cotx.exists) {
    const compiledAt = cotx.compiledAt ? ` compiled at ${cotx.compiledAt}` : '';
    add({
      id: 'semantic-map:cotx',
      kind: 'semantic-map',
      statement: `Existing cotx semantic map is present${compiledAt}.`,
      confidence: 'high',
      evidence: [{ kind: 'cotx-meta', ref: '.cotx/meta.yaml' }],
    });
  }

  if (cotx.hasArchitectureStore) {
    const perspectives = cotx.architecturePerspectives ?? [];
    add({
      id: 'architecture-store:cotx',
      kind: 'architecture-store',
      statement: perspectives.length > 0
        ? `Existing cotx architecture store declares perspectives: ${perspectives.join(', ')}.`
        : 'Existing cotx architecture store is present.',
      confidence: cotx.compiledAt && cotx.architectureGeneratedAt && Date.parse(cotx.architectureGeneratedAt) < Date.parse(cotx.compiledAt) ? 'medium' : 'high',
      evidence: [{ kind: 'architecture-store', ref: '.cotx/architecture/meta.yaml' }],
    });
  }

  const archDocs = sources.filter((source) => source.kind === 'architecture-doc');
  if (archDocs.length > 0) {
    add({
      id: 'architecture-store:docs',
      kind: 'architecture-store',
      statement: `Repository includes architecture-oriented docs under ${[...new Set(archDocs.map((source) => source.path.split('/')[0]))].join(', ')}.`,
      confidence: 'medium',
      evidence: archDocs.slice(0, 5).map((source) => ({ kind: 'file', ref: source.path })),
    });
  }

  return [...hypotheses.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

function buildConsistencyFindings(
  projectRoot: string,
  sources: OnboardingSource[],
  cotx: CotxSnapshot,
  limits: OnboardingLimits,
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const add = (finding: ConsistencyFinding): void => {
    if (findings.length >= limits.maxFindings) return;
    if (findings.some((existing) => existing.status === finding.status && existing.subject === finding.subject && existing.reason === finding.reason)) {
      return;
    }
    findings.push(finding);
  };

  if (!cotx.exists) {
    add({
      status: 'graph-gap',
      subject: '.cotx',
      reason: 'No compiled cotx semantic map is available to validate onboarding documents against the truth graph.',
      evidence: [{ kind: 'cotx-meta', ref: '.cotx/meta.yaml' }],
    });
  } else if (!cotx.hasStorageV2Truth) {
    add({
      status: 'graph-gap',
      subject: '.cotx/v2/truth.lbug',
      reason: 'Compiled sidecars exist, but the storage-v2 truth graph is missing.',
      evidence: [{ kind: 'cotx-meta', ref: '.cotx/meta.yaml' }],
    });
  }

  if (cotx.compiledAt && cotx.architectureGeneratedAt) {
    const compiledAt = Date.parse(cotx.compiledAt);
    const archGeneratedAt = Date.parse(cotx.architectureGeneratedAt);
    if (Number.isFinite(compiledAt) && Number.isFinite(archGeneratedAt) && archGeneratedAt < compiledAt) {
      add({
        status: 'stale-doc',
        subject: '.cotx/architecture',
        reason: `Architecture store was generated at ${cotx.architectureGeneratedAt}, before graph compile ${cotx.compiledAt}.`,
        evidence: [
          { kind: 'cotx-meta', ref: '.cotx/meta.yaml', detail: cotx.compiledAt },
          { kind: 'architecture-store', ref: '.cotx/architecture/meta.yaml', detail: cotx.architectureGeneratedAt },
        ],
      });
    }
  }

  for (const source of sources) {
    if (source.kind === 'manifest') {
      addManifestConsistency(projectRoot, source, add);
    }
    if (['readme', 'agent-instructions', 'docs', 'architecture-doc'].includes(source.kind)) {
      addDocumentReferenceConsistency(projectRoot, source, cotx.graphFiles, cotx.graphFileIndexStatus, add);
      if (source.referenced_paths.length === 0 && ['readme', 'docs', 'architecture-doc'].includes(source.kind)) {
        add({
          status: 'unknown',
          subject: source.path,
          reason: 'Document has no machine-checkable source path references in the sampled preview.',
          evidence: [{ kind: 'file', ref: source.path }],
        });
      }
    }
  }

  for (const anchor of readArchitectureFileAnchors(projectRoot, limits)) {
    addPathReferenceConsistency(projectRoot, anchor.filePath, cotx.graphFiles, cotx.graphFileIndexStatus, add, anchor.evidence);
  }

  return findings.sort((a, b) => a.status.localeCompare(b.status) || a.subject.localeCompare(b.subject) || a.reason.localeCompare(b.reason));
}

function addManifestConsistency(
  projectRoot: string,
  source: OnboardingSource,
  add: (finding: ConsistencyFinding) => void,
): void {
  const workspaces = arrayOfStrings(source.metadata?.workspaces);
  for (const workspace of workspaces) {
    if (!workspace.endsWith('/*')) {
      add({
        status: 'unknown',
        subject: `${source.path}#workspaces:${workspace}`,
        reason: 'Workspace pattern is not a simple directory glob and needs package-manager interpretation.',
        evidence: [{ kind: 'manifest-field', ref: `${source.path}#workspaces`, detail: workspace }],
      });
      continue;
    }
    const base = workspace.slice(0, -2);
    const abs = path.join(projectRoot, base);
    const entries = safeReadDir(abs).filter((entry) => entry.isDirectory());
    add({
      status: entries.length > 0 ? 'confirmed' : 'contradicted',
      subject: `${source.path}#workspaces:${workspace}`,
      reason: entries.length > 0
        ? `Workspace base ${base} exists with ${entries.length} package director${entries.length === 1 ? 'y' : 'ies'}.`
        : `Workspace base ${base} is missing or has no package directories.`,
      evidence: [{ kind: 'manifest-field', ref: `${source.path}#workspaces`, detail: workspace }],
    });
  }
}

function addDocumentReferenceConsistency(
  projectRoot: string,
  source: OnboardingSource,
  graphFiles: Set<string> | null,
  graphFileIndexStatus: CotxSnapshot['graphFileIndexStatus'],
  add: (finding: ConsistencyFinding) => void,
): void {
  for (const ref of source.referenced_paths.filter(isSourcePathReference)) {
    addPathReferenceConsistency(projectRoot, ref, graphFiles, graphFileIndexStatus, add, [
      { kind: 'doc-reference', ref: source.path, detail: ref },
    ]);
  }
}

function addPathReferenceConsistency(
  projectRoot: string,
  ref: string,
  graphFiles: Set<string> | null,
  graphFileIndexStatus: CotxSnapshot['graphFileIndexStatus'],
  add: (finding: ConsistencyFinding) => void,
  evidence: OnboardingEvidence[],
): void {
  const normalized = normalizeRelPath(ref.replace(/^\.\//, ''));
  const exists = safeStat(path.join(projectRoot, normalized))?.isFile() || safeStat(path.join(projectRoot, normalized))?.isDirectory();
  if (!exists) {
    add({
      status: 'contradicted',
      subject: normalized,
      reason: 'Referenced path does not exist in the working tree.',
      evidence,
    });
    return;
  }
  if (!graphFiles) {
    add({
      status: 'unknown',
      subject: normalized,
      reason: 'Referenced path exists, but no graph file index is available for validation.',
      evidence,
    });
    return;
  }
  if (!graphFiles.has(normalized) && graphFileIndexStatus !== 'complete') {
    add({
      status: 'unknown',
      subject: normalized,
      reason: `Referenced path exists, but graph file index is ${graphFileIndexStatus}; cannot classify as a graph gap.`,
      evidence,
    });
    return;
  }
  add({
    status: graphFiles.has(normalized) ? 'confirmed' : 'graph-gap',
    subject: normalized,
    reason: graphFiles.has(normalized)
      ? 'Referenced path exists and appears in the cotx graph file index.'
      : 'Referenced path exists in the working tree but does not appear in the cotx graph file index.',
    evidence,
  });
}

function readArchitectureFileAnchors(
  projectRoot: string,
  limits: OnboardingLimits,
): Array<{ filePath: string; evidence: OnboardingEvidence[] }> {
  const archRoot = path.join(projectRoot, '.cotx', 'architecture');
  if (!safeStat(archRoot)?.isDirectory()) return [];

  const result: Array<{ filePath: string; evidence: OnboardingEvidence[] }> = [];
  const dataFiles = walkFiles(projectRoot, '.cotx/architecture', {
    maxDepth: 5,
    maxFiles: limits.maxFilesPerCategory * 5,
    includeFile: (rel) => path.basename(rel) === 'data.yaml',
    skipDirectory: (_rel, name) => SKIPPED_WALK_DIRS.has(name),
  });

  for (const rel of dataFiles) {
    const preview = readFilePreview(path.join(projectRoot, rel), limits.maxBytesPerFile);
    const parsed = parseYamlRecord(preview.content);
    const componentFiles = new Set<string>();
    for (const filePath of arrayOfStrings(parsed?.files)) {
      componentFiles.add(filePath);
    }
    const components = Array.isArray(parsed?.components) ? parsed.components : [];
    for (const component of components) {
      if (!isRecord(component)) continue;
      for (const filePath of arrayOfStrings(component.files)) {
        componentFiles.add(filePath);
      }
    }
    for (const filePath of componentFiles) {
      result.push({
        filePath,
        evidence: [{ kind: 'architecture-store', ref: rel, detail: filePath }],
      });
    }
  }

  return result;
}

function readCotxSnapshot(projectRoot: string, limits: OnboardingLimits): CotxSnapshot {
  const cotxDir = path.join(projectRoot, '.cotx');
  const exists = Boolean(safeStat(cotxDir)?.isDirectory());
  const warnings: string[] = [];
  const meta = parseYamlFile(path.join(cotxDir, 'meta.yaml'), warnings);
  const archMeta = parseYamlFile(path.join(cotxDir, 'architecture', 'meta.yaml'), warnings);
  const graphFiles = exists ? readGraphFileIndex(projectRoot, limits, warnings) : null;
  return {
    exists,
    hasStorageV2Truth: Boolean(safeStat(path.join(cotxDir, 'v2', 'truth.lbug'))),
    hasArchitectureStore: Boolean(safeStat(path.join(cotxDir, 'architecture', 'meta.yaml'))?.isFile()),
    compiledAt: typeof meta?.compiled_at === 'string' ? meta.compiled_at : undefined,
    architectureGeneratedAt: typeof archMeta?.generated_at === 'string' ? archMeta.generated_at : undefined,
    architecturePerspectives: Array.isArray(archMeta?.perspectives)
      ? archMeta.perspectives.filter((item): item is string => typeof item === 'string').sort()
      : undefined,
    graphFiles: graphFiles?.files ?? null,
    graphFileIndexStatus: graphFiles?.status ?? 'missing',
    warnings,
  };
}

function readGraphFileIndex(projectRoot: string, limits: OnboardingLimits, warnings: string[]): { files: Set<string>; status: CotxSnapshot['graphFileIndexStatus'] } {
  const files = new Set<string>();
  let status: CotxSnapshot['graphFileIndexStatus'] = 'missing';
  const indexPath = path.join(projectRoot, '.cotx', 'index.json');
  const indexStat = safeStat(indexPath);
  if (indexStat?.isFile()) {
    if (indexStat.size > limits.maxGraphIndexBytes) {
      warnings.push(`Skipped .cotx/index.json graph file extraction because it is ${indexStat.size} bytes.`);
    } else {
      const index = parseJsonFile(indexPath, warnings);
      const graph = isRecord(index) && isRecord(index.graph) ? index.graph : null;
      const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
      for (const node of nodes) {
        if (isRecord(node) && typeof node.file === 'string') files.add(normalizeRelPath(node.file));
      }
      if (files.size > 0) status = 'partial';
    }
  }

  const graphNodesPath = path.join(projectRoot, '.cotx', 'graph', 'nodes.json');
  const graphNodesStat = safeStat(graphNodesPath);
  if (graphNodesStat?.isFile()) {
    if (graphNodesStat.size > limits.maxGraphIndexBytes) {
      warnings.push(`Skipped .cotx/graph/nodes.json graph file extraction because it is ${graphNodesStat.size} bytes.`);
      status = files.size > 0 ? 'partial' : 'missing';
    } else {
      const nodes = parseJsonArrayOrJsonLinesFile(graphNodesPath, warnings);
      if (Array.isArray(nodes)) {
        for (const node of nodes) {
          if (!isRecord(node)) continue;
          const props = isRecord(node.properties) ? node.properties : {};
          if (typeof props.filePath === 'string') files.add(normalizeRelPath(props.filePath));
          if (typeof node.filePath === 'string') files.add(normalizeRelPath(node.filePath));
        }
        status = 'complete';
      }
    }
  }

  return { files, status: files.size > 0 ? status : 'missing' };
}

function parseJsonArrayOrJsonLinesFile(absPath: string, warnings: string[]): unknown[] | null {
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch (error) {
    warnings.push(`Failed to read ${absPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const rows: unknown[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        rows.push(JSON.parse(trimmed) as unknown);
      } catch (error) {
        warnings.push(`Failed to parse JSONL row ${index + 1} in ${absPath}: ${error instanceof Error ? error.message : String(error)}`);
        return rows.length > 0 ? rows : null;
      }
    }
    return rows.length > 0 ? rows : null;
  }
}

function groupConsistency(findings: ConsistencyFinding[]): Record<ConsistencyStatus, ConsistencyFinding[]> {
  return {
    confirmed: findings.filter((finding) => finding.status === 'confirmed'),
    contradicted: findings.filter((finding) => finding.status === 'contradicted'),
    'stale-doc': findings.filter((finding) => finding.status === 'stale-doc'),
    'graph-gap': findings.filter((finding) => finding.status === 'graph-gap'),
    unknown: findings.filter((finding) => finding.status === 'unknown'),
  };
}

function countSourcesByKind(sources: OnboardingSource[]): Record<OnboardingSourceKind, number> {
  return {
    readme: sources.filter((source) => source.kind === 'readme').length,
    'agent-instructions': sources.filter((source) => source.kind === 'agent-instructions').length,
    docs: sources.filter((source) => source.kind === 'docs').length,
    'architecture-doc': sources.filter((source) => source.kind === 'architecture-doc').length,
    manifest: sources.filter((source) => source.kind === 'manifest').length,
    example: sources.filter((source) => source.kind === 'example').length,
    cotx: sources.filter((source) => source.kind === 'cotx').length,
  };
}

function countConsistencyByStatus(
  consistency: Record<ConsistencyStatus, ConsistencyFinding[]>,
): Record<ConsistencyStatus, number> {
  return {
    confirmed: consistency.confirmed.length,
    contradicted: consistency.contradicted.length,
    'stale-doc': consistency['stale-doc'].length,
    'graph-gap': consistency['graph-gap'].length,
    unknown: consistency.unknown.length,
  };
}

function walkFiles(
  projectRoot: string,
  startRel: string,
  options: {
    maxDepth: number;
    maxFiles: number;
    includeFile: (relPath: string) => boolean;
    skipDirectory: (relPath: string, name: string) => boolean;
  },
): string[] {
  const startAbs = path.join(projectRoot, startRel);
  if (!safeStat(startAbs)?.isDirectory()) return [];
  const result: string[] = [];

  const walk = (dirAbs: string, depth: number): void => {
    if (result.length >= options.maxFiles || depth > options.maxDepth) return;
    const entries = safeReadDir(dirAbs).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= options.maxFiles) return;
      const abs = path.join(dirAbs, entry.name);
      const rel = relativePath(projectRoot, abs);
      if (entry.isDirectory()) {
        if (!options.skipDirectory(rel, entry.name)) walk(abs, depth + 1);
        continue;
      }
      if (entry.isFile() && options.includeFile(rel)) {
        result.push(rel);
      }
    }
  };

  walk(startAbs, startRel === '.' ? 0 : 1);
  return result.sort();
}

function extractHeadings(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
    .filter((heading): heading is string => Boolean(heading))
    .slice(0, 12);
}

function extractReferencedPaths(content: string): string[] {
  const refs = new Set<string>();
  const pattern = /(?:^|[\s("'`])((?:\.\/)?(?:src|app|apps|packages|lib|cmd|internal|pkg|crates|test|tests|docs|example|examples|\.cotx)\/[A-Za-z0-9_./@%+=:-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const cleaned = match[1]
      .replace(/[),.;:'"`\]}]+$/g, '')
      .replace(/^\.\//, '');
    if (!cleaned.includes('://')) refs.add(normalizeRelPath(cleaned));
  }
  return [...refs].sort();
}

function isSourcePathReference(ref: string): boolean {
  return VALIDATED_SOURCE_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

function excerpt(content: string): string {
  return content
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function parsePackageWorkspaces(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').sort();
  if (isRecord(value) && Array.isArray(value.packages)) {
    return value.packages.filter((item): item is string => typeof item === 'string').sort();
  }
  return [];
}

function extractTomlName(content: string): string | undefined {
  return content.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseYamlRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed = yaml.load(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseYamlFile(absPath: string, warnings: string[]): Record<string, unknown> | null {
  if (!safeStat(absPath)?.isFile()) return null;
  try {
    return parseYamlRecord(fs.readFileSync(absPath, 'utf-8'));
  } catch (error) {
    warnings.push(`Failed to read ${absPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function parseJsonFile(absPath: string, warnings: string[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf-8')) as unknown;
  } catch (error) {
    warnings.push(`Failed to parse ${absPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return normalizeRelPath(path.relative(projectRoot, absPath));
}

function normalizeRelPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === '/' ? '.' : normalized.replace(/\/+$/g, '');
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root';
}

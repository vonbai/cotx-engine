import { execSync } from 'node:child_process';
import path from 'node:path';
import { detectDelta } from './delta-detector.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';
import type { ChangeReviewData, ChangeReviewFinding, DoctrineStatement } from '../store/schema.js';
import type { CotxStore } from '../store/store.js';
import { buildDecisionReview } from './decision-review.js';

const MAX_REVIEW_ADDED_LINES = 2_000;

export function normalizeReviewFiles(projectRoot: string, changedFiles: string[]): string[] {
  const root = path.resolve(projectRoot);
  const normalized = new Set<string>();
  for (const filePath of changedFiles) {
    const trimmed = filePath.trim();
    if (!trimmed) continue;
    const resolved = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(root, trimmed);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
    const relative = path.relative(root, resolved).replace(/\\/g, '/');
    if (!relative || relative.startsWith('..')) continue;
    normalized.add(relative);
  }
  return [...normalized];
}

function relevantDoctrineIds(doctrine: DoctrineStatement[] | undefined, changedModules: string[]): string[] {
  if (!doctrine) return [];
  return doctrine
    .filter((statement) =>
      statement.scope === 'repo' ||
      (statement.scope === 'module' && statement.module && changedModules.includes(statement.module)) ||
      statement.evidence.some((evidence) => changedModules.includes(evidence.ref)),
    )
    .map((statement) => statement.id);
}

function finding(input: Omit<ChangeReviewFinding, 'id'> & { id?: string }): ChangeReviewFinding {
  const id = input.id ?? `${input.kind}:${input.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { ...input, id };
}

function buildLegacyChangeReview(
  store: CotxStore,
  input: { changedFiles: string[]; addedLines: string[] },
): ChangeReviewData {
  const delta = detectDelta(store, input.changedFiles);
  const changedModules = delta.affectedModules;
  const doctrineIds = relevantDoctrineIds(store.readDoctrine()?.statements, changedModules);
  const findings: ChangeReviewFinding[] = [];

  // Bulk-read once — the previous code did store.readModule() inside a
  // `.some()` callback and store.readContract() inside a loop, both
  // hitting LBug per node and stacking into multi-second latency on
  // large repos (caused cotx_review_change to time out at 120s on
  // autoresearch-scale projects).
  const dbPath = path.join(store.projectRoot, '.cotx', 'v2', 'truth.lbug');
  const moduleById = new Map<string, { depended_by: string[] }>();
  for (const a of readSemanticArtifactsSync(dbPath, 'module')) {
    const m = a.payload as { depended_by?: string[] };
    moduleById.set(a.id, { depended_by: m.depended_by ?? [] });
  }
  const contractById = new Map<string, { id: string; provider: string; consumer: string }>();
  for (const a of readSemanticArtifactsSync(dbPath, 'contract')) {
    const c = a.payload as { id: string; provider: string; consumer: string };
    contractById.set(a.id, c);
  }

  const compatibilityRegex = /(compat|compatibility|legacy|fallback|shim|adapter|wrapper)/i;
  if (
    input.changedFiles.some((file) => compatibilityRegex.test(file)) ||
    input.addedLines.some((line) => compatibilityRegex.test(line))
  ) {
    findings.push(finding({
      kind: 'compatibility_layer',
      severity: 'warning',
      title: 'Compatibility layer detected',
      message: 'The change introduces compatibility-style code. Confirm this is better than fixing the owning path directly.',
      doctrine_refs: doctrineIds,
      evidence: [
        ...input.changedFiles.filter((file) => compatibilityRegex.test(file)).map((file) => ({ kind: 'doc' as const, ref: file })),
        ...input.addedLines.filter((line) => compatibilityRegex.test(line)).slice(0, 3).map((line) => ({ kind: 'change' as const, ref: line })),
      ],
      recommendation: 'Prefer changing the owning module or contract path before adding adapters or legacy shims.',
    }));
  }

  if (
    input.changedFiles.length <= 2 &&
    (delta.affectedContracts.length > 0 || delta.affectedFlows.length > 0 || changedModules.some((id) => (moduleById.get(id)?.depended_by ?? []).length > 0))
  ) {
    findings.push(finding({
      kind: 'local_patch',
      severity: 'warning',
      title: 'Local patch on shared path',
      message: 'A small local patch touches a module or flow that has broader project reach.',
      doctrine_refs: doctrineIds,
      evidence: input.changedFiles.map((file) => ({ kind: 'change' as const, ref: file })),
      recommendation: 'Review all related contracts and flows before finalizing the patch.',
    }));
  }

  for (const contractId of delta.affectedContracts) {
    const contract = contractById.get(contractId);
    if (!contract) continue;
    const consumerTouched = changedModules.includes(contract.consumer);
    const providerTouched = changedModules.includes(contract.provider);
    if (consumerTouched !== providerTouched) {
      findings.push(finding({
        kind: 'half_refactor',
        severity: 'warning',
        title: 'Asymmetric contract-side change',
        message: `Only one side of contract ${contract.id} changed directly (${contract.consumer} -> ${contract.provider}).`,
        doctrine_refs: doctrineIds,
        evidence: [{ kind: 'contract', ref: contract.id, detail: `${contract.consumer}->${contract.provider}` }],
        recommendation: 'Review both consumer and provider modules before completing the refactor.',
      }));
    }
  }

  if (doctrineIds.length > 0 && findings.length > 0) {
    findings.push(finding({
      kind: 'doctrine_violation',
      severity: 'info',
      title: 'Review doctrine before finalizing change',
      message: `This change intersects doctrine references: ${doctrineIds.join(', ')}.`,
      doctrine_refs: doctrineIds,
      evidence: doctrineIds.map((id) => ({ kind: 'doc' as const, ref: id })),
      recommendation: 'Compare the patch against the current project doctrine before merging.',
    }));
  }

  const warnings = findings.filter((item) => item.severity === 'warning').length;
  const errors = findings.filter((item) => item.severity === 'error').length;

  return {
    generated_at: new Date().toISOString(),
    changed_files: input.changedFiles,
    findings,
    summary: { warnings, errors },
  };
}

export function buildChangeReview(
  projectRoot: string,
  store: CotxStore,
  input: { changedFiles: string[]; addedLines: string[] },
): ChangeReviewData {
  const normalizedInput = {
    ...input,
    changedFiles: normalizeReviewFiles(projectRoot, input.changedFiles),
  };
  const decisionReview = buildDecisionReview(projectRoot, store, normalizedInput);
  const legacyReview = buildLegacyChangeReview(store, normalizedInput);

  const findings = new Map<string, ChangeReviewFinding>();
  for (const item of [...decisionReview.findings, ...legacyReview.findings]) {
    findings.set(item.id, item);
  }

  const mergedFindings = [...findings.values()].sort((a, b) => a.id.localeCompare(b.id));
  const warnings = mergedFindings.filter((item) => item.severity === 'warning').length;
  const errors = mergedFindings.filter((item) => item.severity === 'error').length;

  return {
    generated_at: decisionReview.generated_at,
    changed_files: normalizedInput.changedFiles,
    findings: mergedFindings,
    matched_option_id: decisionReview.matched_option_id,
    summary: { warnings, errors },
  };
}

export function detectChangedFilesFromGit(projectRoot: string): string[] {
  const diff = execSync('git diff --name-only HEAD', { cwd: projectRoot, encoding: 'utf-8' });
  const staged = execSync('git diff --cached --name-only', { cwd: projectRoot, encoding: 'utf-8' });
  return [...new Set([...diff.trim().split('\n'), ...staged.trim().split('\n')])].filter(Boolean);
}

export function detectAddedLinesFromGit(projectRoot: string, changedFiles: string[]): string[] {
  const normalizedFiles = normalizeReviewFiles(projectRoot, changedFiles);
  if (normalizedFiles.length === 0) return [];
  const command = ['git', 'diff', '--unified=0', 'HEAD', '--', ...normalizedFiles].join(' ');
  const diffText = execSync(command, { cwd: projectRoot, encoding: 'utf-8', shell: '/bin/bash' });
  const addedLines: string[] = [];
  for (const line of diffText.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    addedLines.push(line.slice(1));
    if (addedLines.length >= MAX_REVIEW_ADDED_LINES) break;
  }
  return addedLines;
}

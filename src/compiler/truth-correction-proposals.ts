import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { collectOnboardingContext, type OnboardingContext } from './onboarding-context.js';
import { GraphTruthStore } from '../store-v2/graph-truth-store.js';
import { quoteCypher } from '../store-v2/escaping.js';

export type CotxTruthCorrectionLayer =
  | 'module'
  | 'concept'
  | 'contract'
  | 'flow'
  | 'route'
  | 'tool'
  | 'process'
  | 'decision'
  | 'architecture';

export type CotxTruthCorrectionKind =
  | 'parser-gap'
  | 'compiler-gap'
  | 'architecture-grouping-gap'
  | 'architecture-description-gap'
  | 'missing-node'
  | 'missing-relation'
  | 'wrong-relation'
  | 'stale-doc'
  | 'other';

export interface CotxTruthCorrectionProposal {
  kind: CotxTruthCorrectionKind;
  title: string;
  current_fact?: string;
  proposed_fact: string;
  evidence_file_paths: string[];
  evidence_refs?: string[];
  suggested_test?: string;
  confidence: 'low' | 'medium' | 'high';
}

export type CotxTruthCorrectionStatus = 'open' | 'accepted' | 'rejected' | 'fixed' | 'stale';

export interface CotxTruthCorrectionRecord extends CotxTruthCorrectionProposal {
  schema_version: 'cotx.truth_correction_proposal.v1';
  id: string;
  created_at: string;
  updated_at?: string;
  layer: CotxTruthCorrectionLayer;
  status: CotxTruthCorrectionStatus;
  status_reason?: string;
}

export interface CotxTruthCorrectionSummary {
  total: number;
  by_kind: Record<CotxTruthCorrectionKind, number>;
  by_layer: Partial<Record<CotxTruthCorrectionLayer, number>>;
  by_status: Record<CotxTruthCorrectionStatus, number>;
  high_confidence: number;
  latest_created_at: string | null;
  records: CotxTruthCorrectionRecord[];
}

export interface CotxTruthCorrectionRegressionCandidate {
  id: string;
  title: string;
  kind: CotxTruthCorrectionKind;
  layer: CotxTruthCorrectionLayer;
  confidence: CotxTruthCorrectionRecord['confidence'];
  implementation_targets: string[];
  test_targets: string[];
  evidence_file_paths: string[];
  suggested_test: string;
  current_fact?: string;
  proposed_fact: string;
}

export interface CotxTruthCorrectionValidationFinding {
  level: 'error' | 'warning';
  code:
    | 'MISSING_EVIDENCE_FILE'
    | 'MISSING_NODE_DIRECTORY_EVIDENCE'
    | 'GRAPH_FILE_INDEX_INCOMPLETE'
    | 'TRUTH_GRAPH_MISSING'
    | 'MISSING_NODE_ALREADY_EXISTS'
    | 'MISSING_RELATION_ALREADY_EXISTS'
    | 'RELATION_REF_UNPARSEABLE'
    | 'VALIDATION_LIMITATION';
  message: string;
  record_id: string;
  evidence?: string;
}

export interface CotxTruthCorrectionRecordValidation {
  id: string;
  kind: CotxTruthCorrectionKind;
  status: CotxTruthCorrectionStatus;
  ok: boolean;
  findings: CotxTruthCorrectionValidationFinding[];
}

export interface CotxTruthCorrectionValidationResult {
  schema_version: 'cotx.truth_correction_validation.v1';
  checked_at: string;
  graph_status: 'present' | 'missing';
  ok: boolean;
  records: CotxTruthCorrectionRecordValidation[];
  findings: CotxTruthCorrectionValidationFinding[];
}

export interface CotxTruthCorrectionRegressionPlan {
  schema_version: 'cotx.truth_correction_regression_plan.v1';
  generated_at: string;
  total_candidates: number;
  high_confidence_candidates: number;
  candidates: CotxTruthCorrectionRegressionCandidate[];
}

const PROPOSAL_KINDS: CotxTruthCorrectionKind[] = [
  'parser-gap',
  'compiler-gap',
  'architecture-grouping-gap',
  'architecture-description-gap',
  'missing-node',
  'missing-relation',
  'wrong-relation',
  'stale-doc',
  'other',
];

const PROPOSAL_STATUSES: CotxTruthCorrectionStatus[] = ['open', 'accepted', 'rejected', 'fixed', 'stale'];
const SOURCE_FILE_PATH_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|c|h|cpp|hpp|cs|php|rb|swift|dart|vue|svelte|json|yaml|yml|toml)$/;
const DOC_FILE_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);

export function truthCorrectionProposalPath(projectRoot: string): string {
  return path.join(projectRoot, '.cotx', 'agent', 'truth-corrections.jsonl');
}

export function normalizeTruthCorrectionProposal(
  projectRoot: string,
  proposal: CotxTruthCorrectionProposal,
): CotxTruthCorrectionProposal {
  const evidenceFilePaths = proposal.evidence_file_paths.map((filePath) => {
    const resolved = resolveProjectPath(projectRoot, filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Evidence path does not exist: ${filePath}. evidence_file_paths must be project-relative file or directory paths; use evidence_refs for tool result refs.`);
    }
    return normalizeToolPath(path.relative(projectRoot, resolved));
  });
  return {
    ...proposal,
    title: proposal.title.trim(),
    proposed_fact: proposal.proposed_fact.trim(),
    current_fact: proposal.current_fact?.trim(),
    suggested_test: proposal.suggested_test?.trim(),
    evidence_file_paths: [...new Set(evidenceFilePaths)].sort(),
    evidence_refs: proposal.evidence_refs ? [...new Set(proposal.evidence_refs)].sort() : undefined,
  };
}

export function truthCorrectionProposalKey(proposal: CotxTruthCorrectionProposal): string {
  return JSON.stringify({
    kind: proposal.kind,
    title: proposal.title,
    current_fact: proposal.current_fact ?? '',
    proposed_fact: proposal.proposed_fact,
    evidence_file_paths: proposal.evidence_file_paths,
  });
}

export function appendTruthCorrectionProposal(
  projectRoot: string,
  layer: CotxTruthCorrectionLayer,
  proposal: CotxTruthCorrectionProposal,
  options: { createdAt?: string; id?: string; status?: CotxTruthCorrectionStatus } = {},
): CotxTruthCorrectionRecord {
  const record: CotxTruthCorrectionRecord = {
    schema_version: 'cotx.truth_correction_proposal.v1',
    id: options.id ?? truthCorrectionRecordId(layer, proposal),
    created_at: options.createdAt ?? new Date().toISOString(),
    layer,
    status: options.status ?? 'open',
    ...proposal,
  };
  const filePath = truthCorrectionProposalPath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  return record;
}

export function updateTruthCorrectionStatus(
  projectRoot: string,
  id: string,
  status: CotxTruthCorrectionStatus,
  options: { reason?: string; updatedAt?: string } = {},
): CotxTruthCorrectionRecord {
  const records = readTruthCorrectionRecords(projectRoot);
  const index = records.findIndex((record) => record.id === id);
  if (index < 0) {
    throw new Error(`Truth correction proposal not found: ${id}`);
  }
  records[index] = {
    ...records[index],
    status,
    updated_at: options.updatedAt ?? new Date().toISOString(),
    ...(options.reason ? { status_reason: options.reason } : {}),
  };
  writeTruthCorrectionRecords(projectRoot, records);
  return records[index];
}

export function readTruthCorrectionRecords(projectRoot: string): CotxTruthCorrectionRecord[] {
  const filePath = truthCorrectionProposalPath(projectRoot);
  if (!fs.existsSync(filePath)) return [];
  const records: CotxTruthCorrectionRecord[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = parseTruthCorrectionRecord(trimmed);
    if (parsed) records.push(parsed);
  }
  return records.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export function summarizeTruthCorrections(projectRoot: string): CotxTruthCorrectionSummary {
  const records = readTruthCorrectionRecords(projectRoot);
  const byKind = Object.fromEntries(PROPOSAL_KINDS.map((kind) => [kind, 0])) as Record<CotxTruthCorrectionKind, number>;
  const byStatus = Object.fromEntries(PROPOSAL_STATUSES.map((status) => [status, 0])) as Record<CotxTruthCorrectionStatus, number>;
  const byLayer: Partial<Record<CotxTruthCorrectionLayer, number>> = {};
  let highConfidence = 0;
  let latest: string | null = null;

  for (const record of records) {
    byKind[record.kind] += 1;
    byStatus[record.status] += 1;
    byLayer[record.layer] = (byLayer[record.layer] ?? 0) + 1;
    if (record.confidence === 'high') highConfidence += 1;
    if (!latest || record.created_at > latest) latest = record.created_at;
  }

  return {
    total: records.length,
    by_kind: byKind,
    by_layer: byLayer,
    by_status: byStatus,
    high_confidence: highConfidence,
    latest_created_at: latest,
    records,
  };
}

export function buildTruthCorrectionRegressionPlan(
  projectRoot: string,
  options: { generatedAt?: string; minConfidence?: CotxTruthCorrectionRecord['confidence'] } = {},
): CotxTruthCorrectionRegressionPlan {
  const minRank = confidenceRank(options.minConfidence ?? 'medium');
  const candidates = readTruthCorrectionRecords(projectRoot)
    .filter((record) => record.status === 'open' || record.status === 'accepted')
    .filter((record) => confidenceRank(record.confidence) >= minRank)
    .map((record, index) => regressionCandidate(record, index + 1));
  return {
    schema_version: 'cotx.truth_correction_regression_plan.v1',
    generated_at: options.generatedAt ?? new Date().toISOString(),
    total_candidates: candidates.length,
    high_confidence_candidates: candidates.filter((candidate) => candidate.confidence === 'high').length,
    candidates,
  };
}

export async function validateTruthCorrectionRecords(projectRoot: string): Promise<CotxTruthCorrectionValidationResult> {
  const records = readTruthCorrectionRecords(projectRoot);
  const graphFileIndexStatus = collectOnboardingContext(projectRoot, {
    budget: 'tiny',
    includeExcerpts: false,
  }).summary.graph_file_index_status;
  const graphPath = path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
  const graphExists = fs.existsSync(graphPath);
  const graph = graphExists ? new GraphTruthStore({ dbPath: graphPath, readOnly: true }) : null;
  if (graph) await graph.open();
  try {
    const recordResults: CotxTruthCorrectionRecordValidation[] = [];
    for (const record of records) {
      const findings: CotxTruthCorrectionValidationFinding[] = [];
      findings.push(...validateEvidenceFiles(projectRoot, record));
      findings.push(...validateGraphFileIndexStatus(record, graphFileIndexStatus, graphExists));
      if (requiresGraphValidation(record) && !graph) {
        findings.push({
          level: 'warning',
          code: 'TRUTH_GRAPH_MISSING',
          message: 'Storage-v2 truth graph is missing; graph-backed validation was skipped.',
          record_id: record.id,
        });
      } else if (graph) {
        findings.push(...await validateAgainstGraph(projectRoot, graph, record));
      }
      const narrowedFindings = narrowGraphFileIndexFindings(findings);
      recordResults.push({
        id: record.id,
        kind: record.kind,
        status: record.status,
        ok: narrowedFindings.every((finding) => !isNonGreenFinding(finding)),
        findings: narrowedFindings,
      });
    }
    const findings = recordResults.flatMap((record) => record.findings);
    return {
      schema_version: 'cotx.truth_correction_validation.v1',
      checked_at: new Date().toISOString(),
      graph_status: graphExists ? 'present' : 'missing',
      ok: findings.every((finding) => !isNonGreenFinding(finding)),
      records: recordResults,
      findings,
    };
  } finally {
    if (graph) await graph.close();
  }
}

export async function validateTruthCorrectionProposalCandidate(
  projectRoot: string,
  layer: CotxTruthCorrectionLayer,
  proposal: CotxTruthCorrectionProposal,
  options: {
    graphFileIndexStatus?: OnboardingContext['summary']['graph_file_index_status'];
    truthGraphPresent?: boolean;
  } = {},
): Promise<CotxTruthCorrectionValidationFinding[]> {
  const record: CotxTruthCorrectionRecord = {
    schema_version: 'cotx.truth_correction_proposal.v1',
    id: truthCorrectionRecordId(layer, proposal),
    created_at: new Date(0).toISOString(),
    layer,
    status: 'open',
    ...proposal,
  };
  const findings = validateEvidenceFiles(projectRoot, record);
  const graphFileIndexStatus = options.graphFileIndexStatus ?? collectOnboardingContext(projectRoot, {
    budget: 'tiny',
    includeExcerpts: false,
  }).summary.graph_file_index_status;
  const graphPath = path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
  const truthGraphPresent = options.truthGraphPresent ?? fs.existsSync(graphPath);
  findings.push(...validateGraphFileIndexStatus(record, graphFileIndexStatus, truthGraphPresent));
  if (requiresGraphValidation(record) && !truthGraphPresent) {
    findings.push({
      level: 'warning',
      code: 'TRUTH_GRAPH_MISSING',
      message: 'Storage-v2 truth graph is missing; graph-backed validation was skipped.',
      record_id: record.id,
    });
    return findings;
  }
  if (!requiresGraphValidation(record)) return findings;
  const graph = new GraphTruthStore({ dbPath: graphPath, readOnly: true });
  await graph.open();
  try {
    findings.push(...await validateAgainstGraph(projectRoot, graph, record));
    return narrowGraphFileIndexFindings(findings);
  } finally {
    await graph.close();
  }
}

export function formatTruthCorrectionRegressionPlanMarkdown(plan: CotxTruthCorrectionRegressionPlan): string {
  const lines = [
    '# Truth Correction Regression Plan',
    '',
    `Generated: ${plan.generated_at}`,
    `Candidates: ${plan.total_candidates}`,
    `High confidence: ${plan.high_confidence_candidates}`,
    '',
  ];

  if (plan.candidates.length === 0) {
    lines.push('No regression candidates matched the selected confidence threshold.');
    return `${lines.join('\n')}\n`;
  }

  for (const candidate of plan.candidates) {
    lines.push(`## ${candidate.id}: ${candidate.title}`, '');
    lines.push(`Kind: ${candidate.kind}`);
    lines.push(`Layer: ${candidate.layer}`);
    lines.push(`Confidence: ${candidate.confidence}`);
    lines.push('');
    lines.push('Implementation targets:');
    for (const target of candidate.implementation_targets) lines.push(`- ${target}`);
    lines.push('');
    lines.push('Test targets:');
    for (const target of candidate.test_targets) lines.push(`- ${target}`);
    lines.push('');
    lines.push('Evidence:');
    for (const evidence of candidate.evidence_file_paths) lines.push(`- ${evidence}`);
    lines.push('');
    if (candidate.current_fact) {
      lines.push(`Current fact: ${candidate.current_fact}`, '');
    }
    lines.push(`Proposed fact: ${candidate.proposed_fact}`, '');
    lines.push(`Suggested deterministic test: ${candidate.suggested_test}`, '');
  }

  return `${lines.join('\n')}\n`;
}

function parseTruthCorrectionRecord(line: string): CotxTruthCorrectionRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.schema_version !== 'cotx.truth_correction_proposal.v1') return null;
    if (!isProposalKind(parsed.kind)) return null;
    if (!isLayer(parsed.layer)) return null;
    if (parsed.confidence !== 'low' && parsed.confidence !== 'medium' && parsed.confidence !== 'high') return null;
    if (typeof parsed.created_at !== 'string') return null;
    if (typeof parsed.title !== 'string' || typeof parsed.proposed_fact !== 'string') return null;
    if (!Array.isArray(parsed.evidence_file_paths) || !parsed.evidence_file_paths.every((item) => typeof item === 'string')) return null;
    return {
      schema_version: 'cotx.truth_correction_proposal.v1',
      id: typeof parsed.id === 'string' ? parsed.id : truthCorrectionRecordId(parsed.layer, {
        kind: parsed.kind,
        title: parsed.title,
        proposed_fact: parsed.proposed_fact,
        evidence_file_paths: parsed.evidence_file_paths,
        confidence: parsed.confidence,
        ...(typeof parsed.current_fact === 'string' ? { current_fact: parsed.current_fact } : {}),
        ...(Array.isArray(parsed.evidence_refs) && parsed.evidence_refs.every((item) => typeof item === 'string') ? { evidence_refs: parsed.evidence_refs } : {}),
        ...(typeof parsed.suggested_test === 'string' ? { suggested_test: parsed.suggested_test } : {}),
      }),
      created_at: parsed.created_at,
      status: isStatus(parsed.status) ? parsed.status : 'open',
      layer: parsed.layer,
      kind: parsed.kind,
      title: parsed.title,
      proposed_fact: parsed.proposed_fact,
      evidence_file_paths: parsed.evidence_file_paths,
      confidence: parsed.confidence,
      ...(typeof parsed.current_fact === 'string' ? { current_fact: parsed.current_fact } : {}),
      ...(typeof parsed.updated_at === 'string' ? { updated_at: parsed.updated_at } : {}),
      ...(typeof parsed.status_reason === 'string' ? { status_reason: parsed.status_reason } : {}),
      ...(Array.isArray(parsed.evidence_refs) && parsed.evidence_refs.every((item) => typeof item === 'string') ? { evidence_refs: parsed.evidence_refs } : {}),
      ...(typeof parsed.suggested_test === 'string' ? { suggested_test: parsed.suggested_test } : {}),
    };
  } catch {
    return null;
  }
}

function writeTruthCorrectionRecords(projectRoot: string, records: CotxTruthCorrectionRecord[]): void {
  const filePath = truthCorrectionProposalPath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''), 'utf-8');
}

function truthCorrectionRecordId(layer: CotxTruthCorrectionLayer, proposal: CotxTruthCorrectionProposal): string {
  return `tc:${crypto.createHash('sha256').update(`${layer}:${truthCorrectionProposalKey(proposal)}`).digest('hex').slice(0, 16)}`;
}

function validateEvidenceFiles(projectRoot: string, record: CotxTruthCorrectionRecord): CotxTruthCorrectionValidationFinding[] {
  return record.evidence_file_paths.flatMap((filePath) => {
    const absPath = path.join(projectRoot, filePath);
    return fs.existsSync(absPath)
      ? []
      : [{
          level: 'error' as const,
          code: 'MISSING_EVIDENCE_FILE' as const,
          message: `Evidence path does not exist: ${filePath}`,
          record_id: record.id,
          evidence: filePath,
        }];
  });
}

function validateGraphFileIndexStatus(
  record: CotxTruthCorrectionRecord,
  graphFileIndexStatus: OnboardingContext['summary']['graph_file_index_status'],
  truthGraphPresent: boolean,
): CotxTruthCorrectionValidationFinding[] {
  if (!requiresCompleteGraphFileIndex(record) || graphFileIndexStatus === 'complete') return [];
  return [{
    level: truthGraphPresent ? 'warning' : 'error',
    code: 'GRAPH_FILE_INDEX_INCOMPLETE',
    message: truthGraphPresent
      ? `Graph file index is ${graphFileIndexStatus}; storage-v2 truth is present, so graph-backed validation continued, but sidecar-derived absence claims remain uncertain.`
      : `Graph file index is ${graphFileIndexStatus}; treat ${record.kind} as unknown until cotx compile produces a complete file index.`,
    record_id: record.id,
  }];
}

function requiresCompleteGraphFileIndex(record: CotxTruthCorrectionRecord): boolean {
  return record.kind === 'missing-node' ||
    record.kind === 'missing-relation' ||
    record.kind === 'wrong-relation';
}

function requiresGraphValidation(record: CotxTruthCorrectionRecord): boolean {
  return record.kind === 'missing-node' ||
    record.kind === 'missing-relation' ||
    record.kind === 'wrong-relation';
}

function narrowGraphFileIndexFindings(
  findings: CotxTruthCorrectionValidationFinding[],
): CotxTruthCorrectionValidationFinding[] {
  const hasDecisiveGraphBackedError = findings.some((finding) =>
    finding.code === 'MISSING_NODE_DIRECTORY_EVIDENCE' ||
    finding.code === 'MISSING_NODE_ALREADY_EXISTS' ||
    finding.code === 'MISSING_RELATION_ALREADY_EXISTS',
  );
  if (!hasDecisiveGraphBackedError) return findings;
  return findings.filter((finding) => finding.code !== 'GRAPH_FILE_INDEX_INCOMPLETE');
}

function isNonGreenFinding(finding: CotxTruthCorrectionValidationFinding): boolean {
  return finding.level === 'error' || finding.code === 'GRAPH_FILE_INDEX_INCOMPLETE';
}

async function validateAgainstGraph(
  projectRoot: string,
  graph: GraphTruthStore,
  record: CotxTruthCorrectionRecord,
): Promise<CotxTruthCorrectionValidationFinding[]> {
  if (record.kind === 'missing-node') {
    const findings: CotxTruthCorrectionValidationFinding[] = [];
    for (const filePath of record.evidence_file_paths) {
      const directoryEvidence = listDirectorySourceEvidence(projectRoot, filePath);
      if (directoryEvidence) {
        const graphBackedFiles: string[] = [];
        for (const sourceFile of directoryEvidence.sourceFiles) {
          if (await graphFilePathExists(graph, sourceFile)) graphBackedFiles.push(sourceFile);
        }
        const sample = graphBackedFiles.slice(0, 3).join(', ');
        findings.push({
          level: 'error',
          code: 'MISSING_NODE_DIRECTORY_EVIDENCE',
          message: directoryEvidence.sourceFiles.length === 0
            ? `Evidence path ${filePath} is a directory with no graph-indexable source files. missing-node proposals must cite concrete source files; use architecture-grouping-gap or another directory-level kind for module or asset concerns.`
            : graphBackedFiles.length === directoryEvidence.sourceFiles.length
              ? `Evidence path ${filePath} is a directory, not a concrete source-file node. ${graphBackedFiles.length} source file(s) under it already exist in the graph${sample ? ` (${sample})` : ''}; use architecture-grouping-gap for missing module boundaries or cite specific missing files instead.`
              : `Evidence path ${filePath} is a directory, not a concrete source-file node. It expands to ${directoryEvidence.sourceFiles.length} graph-indexable source file(s), and ${graphBackedFiles.length} already exist in the graph${sample ? ` (${sample})` : ''}; cite specific missing files instead of the directory path.`,
          record_id: record.id,
          evidence: filePath,
        });
        continue;
      }
      if (!isGraphNodeTargetEvidence(projectRoot, filePath)) continue;
      if (await graphFilePathExists(graph, filePath)) {
        findings.push({
          level: 'error',
          code: 'MISSING_NODE_ALREADY_EXISTS',
          message: `Graph already contains a CodeNode for evidence path: ${filePath}`,
          record_id: record.id,
          evidence: filePath,
        });
      }
    }
    return findings;
  }
  if (record.kind === 'missing-relation') {
    const refs = record.evidence_refs ?? [];
    const findings: CotxTruthCorrectionValidationFinding[] = [];
    for (const ref of refs) {
      const relation = parseRelationRef(ref);
      if (!relation) {
        findings.push({
          level: 'warning',
          code: 'RELATION_REF_UNPARSEABLE',
          message: `Could not parse relation evidence ref: ${ref}`,
          record_id: record.id,
          evidence: ref,
        });
        continue;
      }
      if (await graphRelationExists(graph, relation.from, relation.to)) {
        findings.push({
          level: 'error',
          code: 'MISSING_RELATION_ALREADY_EXISTS',
          message: `Graph already contains a relation from ${relation.from} to ${relation.to}`,
          record_id: record.id,
          evidence: ref,
        });
      }
    }
    return findings;
  }
  if (record.kind === 'wrong-relation') {
    return [{
      level: 'warning',
      code: 'VALIDATION_LIMITATION',
      message: 'Wrong-relation proposals require human review of expected relation type and direction.',
      record_id: record.id,
    }];
  }
  return [];
}

async function graphFilePathExists(graph: GraphTruthStore, filePath: string): Promise<boolean> {
  const rows = await graph.query(
    `MATCH (n:CodeNode) WHERE n.filePath = '${quoteCypher(filePath)}' RETURN n.id AS id LIMIT 1`,
  );
  return rows.length > 0;
}

async function graphRelationExists(graph: GraphTruthStore, from: string, to: string): Promise<boolean> {
  const rows = await graph.query(
    `MATCH (a {id:'${quoteCypher(from)}'})-[r:CodeRelation]->(b {id:'${quoteCypher(to)}'}) RETURN r.type AS type LIMIT 1`,
  );
  return rows.length > 0;
}

function parseRelationRef(ref: string): { from: string; to: string } | null {
  const match = ref.match(/^(.+?)(?:->|→)(.+)$/);
  if (!match) return null;
  return { from: match[1].trim(), to: match[2].trim() };
}

function isGraphNodeTargetEvidence(projectRoot: string, filePath: string): boolean {
  if (filePath.startsWith('.cotx/')) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (DOC_FILE_EXTENSIONS.has(ext)) return false;
  const absPath = path.join(projectRoot, filePath);
  if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) return true;
  return SOURCE_FILE_PATH_RE.test(filePath);
}

function listDirectorySourceEvidence(
  projectRoot: string,
  filePath: string,
): { sourceFiles: string[] } | null {
  const absPath = path.join(projectRoot, filePath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) return null;

  const sourceFiles: string[] = [];
  const stack = [absPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      const relative = normalizeToolPath(path.relative(projectRoot, child));
      if (SOURCE_FILE_PATH_RE.test(relative) && !DOC_FILE_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
        sourceFiles.push(relative);
      }
    }
  }

  return { sourceFiles: [...new Set(sourceFiles)].sort() };
}

function regressionCandidate(
  record: CotxTruthCorrectionRecord,
  ordinal: number,
): CotxTruthCorrectionRegressionCandidate {
  return {
    id: `${String(ordinal).padStart(3, '0')}-${record.kind}`,
    title: record.title,
    kind: record.kind,
    layer: record.layer,
    confidence: record.confidence,
    implementation_targets: implementationTargetsFor(record),
    test_targets: testTargetsFor(record),
    evidence_file_paths: record.evidence_file_paths,
    suggested_test: record.suggested_test ?? defaultSuggestedTest(record),
    ...(record.current_fact ? { current_fact: record.current_fact } : {}),
    proposed_fact: record.proposed_fact,
  };
}

function implementationTargetsFor(record: CotxTruthCorrectionRecord): string[] {
  switch (record.kind) {
    case 'architecture-description-gap':
    case 'architecture-grouping-gap':
      return ['src/compiler/architecture-compiler.ts', 'src/compiler/architecture-workspace-planner.ts'];
    case 'parser-gap':
    case 'missing-node':
      return ['src/core/parser/', 'src/core/bridge.ts', 'src/store-v2/write-storage-v2.ts'];
    case 'missing-relation':
    case 'wrong-relation':
      return ['src/core/parser/call-processor.ts', 'src/core/parser/import-processor.ts', 'src/store-v2/write-storage-v2.ts'];
    case 'compiler-gap':
      return ['src/compiler/', 'src/store-v2/write-storage-v2.ts'];
    case 'stale-doc':
      return ['src/compiler/onboarding-context.ts', 'src/compiler/stale-detector.ts'];
    case 'other':
      return [`src/compiler/${record.layer === 'architecture' ? 'architecture-compiler.ts' : ''}`].filter(Boolean);
  }
}

function testTargetsFor(record: CotxTruthCorrectionRecord): string[] {
  switch (record.kind) {
    case 'architecture-description-gap':
    case 'architecture-grouping-gap':
      return ['test/compiler/architecture-compiler.test.ts', 'test/compiler/architecture-workspace-planner.test.ts'];
    case 'parser-gap':
    case 'missing-node':
      return ['test/parser/', 'test/store-v2/storage-v2.test.ts'];
    case 'missing-relation':
    case 'wrong-relation':
      return ['test/parser/', 'test/compiler/closure-engine.test.ts'];
    case 'compiler-gap':
      return ['test/compiler/'];
    case 'stale-doc':
      return ['test/compiler/onboarding-context.test.ts', 'test/compiler/stale-detector.test.ts'];
    case 'other':
      return ['test/compiler/'];
  }
}

function defaultSuggestedTest(record: CotxTruthCorrectionRecord): string {
  return `Add a deterministic regression fixture for ${record.kind} using evidence: ${record.evidence_file_paths.join(', ')}.`;
}

function confidenceRank(confidence: CotxTruthCorrectionRecord['confidence']): number {
  return confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1;
}

function resolveProjectPath(projectRoot: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) {
    throw new Error(`Only project-relative paths are allowed: ${requestedPath}`);
  }
  const resolved = path.resolve(projectRoot, requestedPath);
  const root = path.resolve(projectRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${requestedPath}`);
  }
  return resolved;
}

function normalizeToolPath(value: string): string {
  return value === '' ? '.' : value.split(path.sep).join('/');
}

function isProposalKind(value: unknown): value is CotxTruthCorrectionKind {
  return typeof value === 'string' && PROPOSAL_KINDS.includes(value as CotxTruthCorrectionKind);
}

function isLayer(value: unknown): value is CotxTruthCorrectionLayer {
  return value === 'module' ||
    value === 'concept' ||
    value === 'contract' ||
    value === 'flow' ||
    value === 'route' ||
    value === 'tool' ||
    value === 'process' ||
    value === 'decision' ||
    value === 'architecture';
}

function isStatus(value: unknown): value is CotxTruthCorrectionStatus {
  return typeof value === 'string' && PROPOSAL_STATUSES.includes(value as CotxTruthCorrectionStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

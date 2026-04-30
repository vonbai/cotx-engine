import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  collectOnboardingContext,
  type OnboardingBudget,
  type OnboardingContext,
} from './onboarding-context.js';
import {
  summarizeTruthCorrections,
  type CotxTruthCorrectionSummary,
  type CotxTruthCorrectionLayer,
} from './truth-correction-proposals.js';

export type LlmEnrichmentEvalMode =
  | 'cotx-deterministic'
  | 'cotx-built-in-llm'
  | 'cotx-caller-agent'
  | 'gitnexus-wiki'
  | 'code-review-graph'
  | 'oh-my-mermaid';

export type LlmEnrichmentEvalProduct =
  | 'cotx'
  | 'gitnexus'
  | 'code-review-graph'
  | 'oh-my-mermaid';

export type LlmEnrichmentEvalLayer = CotxTruthCorrectionLayer;

export type LlmEnrichmentRubricDimension =
  | 'groundedness'
  | 'coverage'
  | 'architecture_usefulness'
  | 'agent_actionability'
  | 'brevity'
  | 'staleness_handling'
  | 'recursion_quality'
  | 'cost_latency';

export interface LlmEnrichmentEvalOptions {
  projectRoot: string;
  repo?: string;
  task?: string;
  layer?: LlmEnrichmentEvalLayer;
  mode?: LlmEnrichmentEvalMode;
  product?: LlmEnrichmentEvalProduct;
  budget?: OnboardingBudget;
  generatedAt?: string;
  runnerAvailable?: boolean;
  llmConfigured?: boolean;
}

export interface LlmEnrichmentEvalWriteOptions {
  outDir: string;
  jsonlName?: string;
  markdownName?: string;
  writeJsonl?: boolean;
}

export interface CallerAgentRunnerRequest {
  schema_version: 'cotx.caller_agent_runner.v1';
  generated_at: string;
  repo: string;
  project_root: string;
  task: string;
  layer: LlmEnrichmentEvalLayer;
  mode: 'cotx-caller-agent';
  product: 'cotx';
  read_only: true;
  constraints: string[];
  cotx: {
    present: boolean;
    compiled_at: string | null;
    truth_graph_present: boolean;
    architecture_present: boolean;
    architecture_generated_at: string | null;
    architecture_mode: string | null;
    architecture_perspectives: string[];
  };
  onboarding: {
    source_count: number;
    graph_file_count: number | null;
    graph_file_index_status: OnboardingContext['summary']['graph_file_index_status'];
    consistency_counts: OnboardingContext['summary']['consistency_counts'];
    top_hypotheses: Array<{
      id: string;
      kind: string;
      statement: string;
      confidence: string;
      evidence: Array<{ kind: string; ref: string; detail?: string }>;
    }>;
    warnings: string[];
  };
  truth_corrections: {
    total: number;
    high_confidence: number;
    latest_created_at: string | null;
    samples: Array<{
      kind: string;
      layer: string;
      title: string;
      confidence: string;
      evidence_file_paths: string[];
      suggested_test?: string;
    }>;
  };
  required_output: {
    schema_version: 'cotx.caller_agent_runner_result.v1';
    status_values: Array<'passed' | 'failed' | 'blocked'>;
    notes: string[];
  };
}

export interface CallerAgentRunnerResult {
  schema_version: 'cotx.caller_agent_runner_result.v1';
  status: 'passed' | 'failed' | 'blocked';
  summary: string;
  blockers?: string[];
  observations?: string[];
  evidence?: Array<{ kind: string; ref: string; detail?: string }>;
  scores?: Partial<Record<LlmEnrichmentRubricDimension, number>>;
  llm_calls?: number;
  token_estimate?: number;
  duration_ms?: number;
}

export interface CallerAgentRunnerInvocation {
  schema_version: 'cotx.caller_agent_runner.v1';
  configured: boolean;
  status: 'not-configured' | 'passed' | 'failed' | 'blocked' | 'error' | 'timed-out';
  timeout_ms: number;
  request: CallerAgentRunnerRequest;
  command?: string;
  args?: string[];
  duration_ms?: number;
  exit_code?: number | null;
  signal?: string | null;
  result?: CallerAgentRunnerResult;
  stdout_tail?: string;
  stderr_tail?: string;
  errors: string[];
}

export interface LlmEnrichmentRubricEntry {
  dimension: LlmEnrichmentRubricDimension;
  score: number | null;
  status: 'not-scored' | 'ready' | 'blocked';
  required_evidence: string[];
  deterministic_signals: Record<string, unknown>;
  notes: string[];
}

export interface LlmEnrichmentEvalRecord {
  schema_version: 'llm-enrichment-eval.v1';
  generated_at: string;
  repo: string;
  project_root: string;
  task: string;
  layer: LlmEnrichmentEvalLayer;
  mode: LlmEnrichmentEvalMode;
  product: LlmEnrichmentEvalProduct;
  execution: {
    status: 'ready' | 'blocked' | 'not-run';
    blockers: string[];
  };
  read_only: true;
  llm_calls: 0;
  token_estimate: null;
  onboarding: {
    source_count: number;
    sources_by_kind: OnboardingContext['summary']['sources_by_kind'];
    hypothesis_count: number;
    consistency_counts: OnboardingContext['summary']['consistency_counts'];
    has_cotx: boolean;
    has_storage_v2_truth: boolean;
    has_architecture_store: boolean;
    graph_file_count: number | null;
    graph_file_index_status: OnboardingContext['summary']['graph_file_index_status'];
    workspace_directories: number;
    workspace_candidates: number;
    asset_directories: number;
    repo_boundaries: number;
    package_boundaries: number;
    top_hypotheses: Array<{
      id: string;
      kind: string;
      statement: string;
      confidence: string;
      evidence: Array<{ kind: string; ref: string; detail?: string }>;
    }>;
    warnings: string[];
  };
  cotx: {
    present: boolean;
    compiled_at: string | null;
    stats: Record<string, unknown> | null;
    truth_graph_present: boolean;
  };
  architecture: {
    present: boolean;
    generated_at: string | null;
    mode: string | null;
    perspectives: string[];
    sampled_sidecars: {
      descriptions: number;
      diagrams: number;
      data_files: number;
    };
  };
  truth_corrections: {
    total: number;
    high_confidence: number;
    latest_created_at: string | null;
    by_kind: CotxTruthCorrectionSummary['by_kind'];
    by_layer: CotxTruthCorrectionSummary['by_layer'];
    samples: Array<{
      kind: string;
      layer: string;
      title: string;
      confidence: string;
      evidence_file_paths: string[];
      suggested_test?: string;
    }>;
  };
  caller_agent_runner?: CallerAgentRunnerInvocation;
  rubric: LlmEnrichmentRubricEntry[];
  observations: string[];
  next_actions: string[];
}

const RUBRIC_DIMENSIONS: LlmEnrichmentRubricDimension[] = [
  'groundedness',
  'coverage',
  'architecture_usefulness',
  'agent_actionability',
  'brevity',
  'staleness_handling',
  'recursion_quality',
  'cost_latency',
];

const MODES = new Set<LlmEnrichmentEvalMode>([
  'cotx-deterministic',
  'cotx-built-in-llm',
  'cotx-caller-agent',
  'gitnexus-wiki',
  'code-review-graph',
  'oh-my-mermaid',
]);

const PRODUCTS = new Set<LlmEnrichmentEvalProduct>([
  'cotx',
  'gitnexus',
  'code-review-graph',
  'oh-my-mermaid',
]);

const LAYERS = new Set<LlmEnrichmentEvalLayer>([
  'module',
  'concept',
  'contract',
  'flow',
  'route',
  'tool',
  'process',
  'decision',
  'architecture',
]);

export function buildLlmEnrichmentEvalRecord(
  options: LlmEnrichmentEvalOptions,
): LlmEnrichmentEvalRecord {
  const projectRoot = path.resolve(options.projectRoot);
  const rootStat = safeStat(projectRoot);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Project root does not exist or is not a directory: ${options.projectRoot}`);
  }

  const mode = options.mode ?? 'cotx-deterministic';
  if (!MODES.has(mode)) {
    throw new Error(`Invalid eval mode: ${mode}. Use one of: ${[...MODES].join(', ')}`);
  }

  const layer = options.layer ?? 'architecture';
  if (!LAYERS.has(layer)) {
    throw new Error(`Invalid eval layer: ${layer}. Use one of: ${[...LAYERS].join(', ')}`);
  }

  const product = options.product ?? inferProduct(mode);
  if (!PRODUCTS.has(product)) {
    throw new Error(`Invalid eval product: ${product}. Use one of: ${[...PRODUCTS].join(', ')}`);
  }

  const onboarding = collectOnboardingContext(projectRoot, {
    budget: options.budget ?? 'standard',
  });
  const cotxMeta = readYamlRecord(path.join(projectRoot, '.cotx', 'meta.yaml'));
  const architectureMeta = readYamlRecord(path.join(projectRoot, '.cotx', 'architecture', 'meta.yaml'));
  const architectureSidecars = countArchitectureSidecars(projectRoot);
  const truthCorrectionSummary = summarizeTruthCorrections(projectRoot);

  const cotx = {
    present: Boolean(safeStat(path.join(projectRoot, '.cotx'))?.isDirectory()),
    compiled_at: typeof cotxMeta?.compiled_at === 'string' ? cotxMeta.compiled_at : null,
    stats: isRecord(cotxMeta?.stats) ? cotxMeta.stats : null,
    truth_graph_present: Boolean(safeStat(path.join(projectRoot, '.cotx', 'v2', 'truth.lbug'))),
  };

  const architecture = {
    present: Boolean(safeStat(path.join(projectRoot, '.cotx', 'architecture', 'meta.yaml'))?.isFile()),
    generated_at: typeof architectureMeta?.generated_at === 'string' ? architectureMeta.generated_at : null,
    mode: typeof architectureMeta?.mode === 'string' ? architectureMeta.mode : null,
    perspectives: Array.isArray(architectureMeta?.perspectives)
      ? architectureMeta.perspectives.filter((item): item is string => typeof item === 'string').sort()
      : [],
    sampled_sidecars: architectureSidecars,
  };

  const observations = buildObservations(onboarding, cotx, architecture, truthCorrectionSummary);
  const nextActions = buildNextActions(onboarding, cotx, architecture, truthCorrectionSummary, mode);
  const execution = executionStatus(mode, {
    cotxPresent: cotx.present,
    truthGraphPresent: cotx.truth_graph_present,
    architecturePresent: architecture.present,
    layer,
    runnerAvailable: options.runnerAvailable,
    llmConfigured: options.llmConfigured,
  });

  return {
    schema_version: 'llm-enrichment-eval.v1',
    generated_at: options.generatedAt ?? new Date().toISOString(),
    repo: options.repo ?? path.basename(projectRoot),
    project_root: projectRoot,
    task: options.task ?? 'architecture enrichment baseline',
    layer,
    mode,
    product,
    execution,
    read_only: true,
    llm_calls: 0,
    token_estimate: null,
    onboarding: {
      source_count: onboarding.summary.source_count,
      sources_by_kind: onboarding.summary.sources_by_kind,
      hypothesis_count: onboarding.summary.hypothesis_count,
      consistency_counts: onboarding.summary.consistency_counts,
      has_cotx: onboarding.summary.has_cotx,
      has_storage_v2_truth: onboarding.summary.has_storage_v2_truth,
      has_architecture_store: onboarding.summary.has_architecture_store,
      graph_file_count: onboarding.summary.graph_file_count,
      graph_file_index_status: onboarding.summary.graph_file_index_status,
      workspace_directories: onboarding.summary.workspace_directories,
      workspace_candidates: onboarding.summary.workspace_candidates,
      asset_directories: onboarding.summary.asset_directories,
      repo_boundaries: onboarding.summary.repo_boundaries,
      package_boundaries: onboarding.summary.package_boundaries,
      top_hypotheses: onboarding.hypotheses.slice(0, 8).map((hypothesis) => ({
        id: hypothesis.id,
        kind: hypothesis.kind,
        statement: hypothesis.statement,
        confidence: hypothesis.confidence,
        evidence: hypothesis.evidence,
      })),
      warnings: onboarding.summary.warnings,
    },
    cotx,
    architecture,
    truth_corrections: {
      total: truthCorrectionSummary.total,
      high_confidence: truthCorrectionSummary.high_confidence,
      latest_created_at: truthCorrectionSummary.latest_created_at,
      by_kind: truthCorrectionSummary.by_kind,
      by_layer: truthCorrectionSummary.by_layer,
      samples: truthCorrectionSummary.records.slice(-5).map((record) => ({
        kind: record.kind,
        layer: record.layer,
        title: record.title,
        confidence: record.confidence,
        evidence_file_paths: record.evidence_file_paths,
        ...(record.suggested_test ? { suggested_test: record.suggested_test } : {}),
      })),
    },
    rubric: buildRubric(onboarding, cotx, architecture),
    observations,
    next_actions: nextActions,
  };
}

export function writeLlmEnrichmentEvalReport(
  records: LlmEnrichmentEvalRecord[],
  options: LlmEnrichmentEvalWriteOptions,
): { jsonl_path: string | null; markdown_path: string; records: number } {
  if (records.length === 0) {
    throw new Error('Cannot write LLM enrichment eval report with zero records.');
  }

  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const markdownPath = path.join(outDir, options.markdownName ?? 'llm-enrichment-eval.md');
  let jsonlPath: string | null = null;
  if (options.writeJsonl === true) {
    jsonlPath = path.join(outDir, options.jsonlName ?? 'llm-enrichment-eval.jsonl');
    fs.writeFileSync(jsonlPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8');
  }
  fs.writeFileSync(markdownPath, formatLlmEnrichmentEvalMarkdown(records, jsonlPath), 'utf-8');
  return { jsonl_path: jsonlPath, markdown_path: markdownPath, records: records.length };
}

export function formatLlmEnrichmentEvalMarkdown(
  records: LlmEnrichmentEvalRecord[],
  jsonlPath: string | null = null,
): string {
  const lines = [
    '# LLM Enrichment Eval Baseline',
    '',
    'This report is read-only. It records deterministic rubric inputs and invokes a caller-agent runner only when explicitly configured.',
    '',
    '| Repo | Layer | Mode | Product | Status | Runner | Sources | Hypotheses | Confirmed | Contradicted | Stale Docs | Graph Gaps | Unknown | Corrections | cotx | truth graph | architecture |',
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
  ];

  for (const record of records) {
    const counts = record.onboarding.consistency_counts;
    lines.push([
      record.repo,
      record.layer,
      record.mode,
      record.product,
      record.execution.status,
      record.caller_agent_runner?.status ?? '-',
      record.onboarding.source_count,
      record.onboarding.hypothesis_count,
      counts.confirmed,
      counts.contradicted,
      counts['stale-doc'],
      counts['graph-gap'],
      counts.unknown,
      record.truth_corrections.total,
      yesNo(record.cotx.present),
      yesNo(record.cotx.truth_graph_present),
      yesNo(record.architecture.present),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  for (const record of records) {
    lines.push('', `## ${record.repo}`, '');
    lines.push(`Task: ${record.task}`);
    lines.push(`Layer: ${record.layer}`);
    lines.push(`Project root: ${record.project_root}`);
    lines.push(`Generated: ${record.generated_at}`);
    if (record.execution.blockers.length > 0) {
      lines.push(`Execution blockers: ${record.execution.blockers.join('; ')}`);
    }
    if (record.caller_agent_runner) {
      lines.push(`Caller-agent runner: ${record.caller_agent_runner.status}`);
      if (record.caller_agent_runner.command) {
        lines.push(`Runner command: ${record.caller_agent_runner.command}`);
      }
      if (record.caller_agent_runner.result) {
        lines.push(`Runner summary: ${record.caller_agent_runner.result.summary}`);
        if (record.caller_agent_runner.result.blockers?.length) {
          lines.push(`Runner blockers: ${record.caller_agent_runner.result.blockers.join('; ')}`);
        }
      }
      if (record.caller_agent_runner.errors.length > 0) {
        lines.push(`Runner errors: ${record.caller_agent_runner.errors.join('; ')}`);
      }
    }
    lines.push('');
    lines.push('Top hypotheses:');
    if (record.onboarding.top_hypotheses.length === 0) {
      lines.push('- none');
    } else {
      for (const hypothesis of record.onboarding.top_hypotheses) {
        lines.push(`- ${hypothesis.kind}: ${hypothesis.statement}`);
      }
    }
    lines.push('');
    lines.push('Truth correction proposals:');
    if (record.truth_corrections.samples.length === 0) {
      lines.push('- none');
    } else {
      for (const proposal of record.truth_corrections.samples) {
        lines.push(`- ${proposal.layer}/${proposal.kind}: ${proposal.title} (${proposal.confidence})`);
      }
    }
    lines.push('');
    lines.push('Observations:');
    for (const observation of record.observations) {
      lines.push(`- ${observation}`);
    }
    lines.push('');
    lines.push('Next actions:');
    for (const action of record.next_actions) {
      lines.push(`- ${action}`);
    }
  }

  if (jsonlPath) lines.push('', `JSONL: ${jsonlPath}`);
  return `${lines.join('\n')}\n`;
}

function executionStatus(
  mode: LlmEnrichmentEvalMode,
  input: {
    cotxPresent: boolean;
    truthGraphPresent: boolean;
    architecturePresent: boolean;
    layer: LlmEnrichmentEvalLayer;
    runnerAvailable?: boolean;
    llmConfigured?: boolean;
  },
): LlmEnrichmentEvalRecord['execution'] {
  const blockers: string[] = [];
  if (mode === 'cotx-deterministic') {
    return input.truthGraphPresent
      ? { status: 'ready', blockers }
      : { status: 'blocked', blockers: ['cotx deterministic mode requires .cotx/v2/truth.lbug; run cotx compile'] };
  }
  if (mode === 'cotx-built-in-llm') {
    if (!input.llmConfigured) blockers.push('no LLM config available for built-in LLM mode');
    if (!input.cotxPresent) blockers.push('cotx map missing; run cotx compile before built-in LLM benchmark');
    if (input.layer === 'architecture' && !input.architecturePresent) blockers.push('canonical architecture data missing; run cotx compile');
    return blockers.length > 0 ? { status: 'blocked', blockers } : { status: 'ready', blockers };
  }
  if (mode === 'cotx-caller-agent') {
    if (!input.runnerAvailable) blockers.push('caller-agent runner is external and was not provided to this read-only harness');
    if (!input.cotxPresent) blockers.push('cotx map missing; run cotx compile before caller-agent benchmark');
    return blockers.length > 0 ? { status: 'blocked', blockers } : { status: 'ready', blockers };
  }
  if (mode === 'gitnexus-wiki' || mode === 'code-review-graph' || mode === 'oh-my-mermaid') {
    return input.runnerAvailable
      ? { status: 'ready', blockers }
      : { status: 'not-run', blockers: ['external comparator runner not wired in this read-only harness invocation'] };
  }
  return { status: 'blocked', blockers: [`unknown mode: ${mode}`] };
}

function inferProduct(mode: LlmEnrichmentEvalMode): LlmEnrichmentEvalProduct {
  if (mode === 'gitnexus-wiki') return 'gitnexus';
  if (mode === 'code-review-graph') return 'code-review-graph';
  if (mode === 'oh-my-mermaid') return 'oh-my-mermaid';
  return 'cotx';
}

function buildRubric(
  onboarding: OnboardingContext,
  cotx: LlmEnrichmentEvalRecord['cotx'],
  architecture: LlmEnrichmentEvalRecord['architecture'],
): LlmEnrichmentRubricEntry[] {
  return RUBRIC_DIMENSIONS.map((dimension) => ({
    dimension,
    score: null,
    status: rubricStatus(dimension, onboarding, cotx, architecture),
    required_evidence: requiredEvidenceForDimension(dimension),
    deterministic_signals: deterministicSignalsForDimension(dimension, onboarding, cotx, architecture),
    notes: notesForDimension(dimension, onboarding, cotx, architecture),
  }));
}

function rubricStatus(
  dimension: LlmEnrichmentRubricDimension,
  onboarding: OnboardingContext,
  cotx: LlmEnrichmentEvalRecord['cotx'],
  architecture: LlmEnrichmentEvalRecord['architecture'],
): LlmEnrichmentRubricEntry['status'] {
  if (dimension === 'groundedness' && !cotx.truth_graph_present) return 'blocked';
  if (dimension === 'staleness_handling' && !cotx.present) return 'blocked';
  if (dimension === 'recursion_quality' && !architecture.present) return 'blocked';
  return 'not-scored';
}

function requiredEvidenceForDimension(dimension: LlmEnrichmentRubricDimension): string[] {
  switch (dimension) {
    case 'groundedness':
      return ['file anchors', 'truth graph node or relation anchors', 'no contradicted path claims'];
    case 'coverage':
      return ['expected component list', 'architecture perspectives', 'manifest/package surfaces'];
    case 'architecture_usefulness':
      return ['component responsibilities', 'cross-component relationships', 'change navigation guidance'];
    case 'agent_actionability':
      return ['recommended next tools', 'bounded file/symbol targets', 'risk flags'];
    case 'brevity':
      return ['source counts', 'hypothesis count', 'recorded summary length'];
    case 'staleness_handling':
      return ['compiled_at', 'architecture generated_at', 'stale-doc findings'];
    case 'recursion_quality':
      return ['recursive doc roots', 'architecture sidecars', 'parent/child evidence links'];
    case 'cost_latency':
      return ['LLM call count', 'token estimate', 'wall time when available'];
  }
}

function deterministicSignalsForDimension(
  dimension: LlmEnrichmentRubricDimension,
  onboarding: OnboardingContext,
  cotx: LlmEnrichmentEvalRecord['cotx'],
  architecture: LlmEnrichmentEvalRecord['architecture'],
): Record<string, unknown> {
  const counts = onboarding.summary.consistency_counts;
  switch (dimension) {
    case 'groundedness':
      return {
        confirmed: counts.confirmed,
        contradicted: counts.contradicted,
        graph_gap: counts['graph-gap'],
        truth_graph_present: cotx.truth_graph_present,
      };
    case 'coverage':
      return {
        source_count: onboarding.summary.source_count,
        sources_by_kind: onboarding.summary.sources_by_kind,
        architecture_perspectives: architecture.perspectives,
      };
    case 'architecture_usefulness':
      return {
        hypothesis_count: onboarding.summary.hypothesis_count,
        architecture_present: architecture.present,
        architecture_sidecars: architecture.sampled_sidecars,
      };
    case 'agent_actionability':
      return {
        has_cotx: cotx.present,
        has_truth_graph: cotx.truth_graph_present,
        has_architecture_store: architecture.present,
      };
    case 'brevity':
      return {
        source_count: onboarding.summary.source_count,
        hypothesis_count: onboarding.summary.hypothesis_count,
        warning_count: onboarding.summary.warnings.length,
      };
    case 'staleness_handling':
      return {
        compiled_at: cotx.compiled_at,
        architecture_generated_at: architecture.generated_at,
        stale_doc_findings: counts['stale-doc'],
      };
    case 'recursion_quality':
      return {
        architecture_sidecars: architecture.sampled_sidecars,
      };
    case 'cost_latency':
      return {
        llm_calls: 0,
        token_estimate: null,
      };
  }
}

function notesForDimension(
  dimension: LlmEnrichmentRubricDimension,
  onboarding: OnboardingContext,
  cotx: LlmEnrichmentEvalRecord['cotx'],
  architecture: LlmEnrichmentEvalRecord['architecture'],
): string[] {
  const notes: string[] = [];
  const counts = onboarding.summary.consistency_counts;
  if (dimension === 'groundedness') {
    if (!cotx.truth_graph_present) notes.push('truth graph is missing');
    if (counts.contradicted > 0) notes.push(`${counts.contradicted} contradicted onboarding references need review`);
    if (counts['graph-gap'] > 0) notes.push(`${counts['graph-gap']} references exist in the tree but are absent from the graph index`);
  }
  if (dimension === 'staleness_handling' && counts['stale-doc'] > 0) {
    notes.push(`${counts['stale-doc']} stale-doc finding(s) detected`);
  }
  if (dimension === 'recursion_quality' && !architecture.present) {
    notes.push('no architecture store found');
  }
  if (dimension === 'cost_latency') {
    notes.push('baseline harness made zero LLM calls');
  }
  return notes;
}

function buildObservations(
  onboarding: OnboardingContext,
  cotx: LlmEnrichmentEvalRecord['cotx'],
  architecture: LlmEnrichmentEvalRecord['architecture'],
  truthCorrections: CotxTruthCorrectionSummary,
): string[] {
  const observations: string[] = [];
  const counts = onboarding.summary.consistency_counts;
  observations.push(`workspace scan found ${onboarding.summary.workspace_directories} director${onboarding.summary.workspace_directories === 1 ? 'y' : 'ies'}, ${onboarding.summary.workspace_candidates} candidate input(s), ${onboarding.summary.asset_directories} asset director${onboarding.summary.asset_directories === 1 ? 'y' : 'ies'}, ${onboarding.summary.repo_boundaries} repo boundary/boundaries, and ${onboarding.summary.package_boundaries} package boundary/boundaries`);
  observations.push(`onboarding sampled ${onboarding.summary.source_count} source(s) and produced ${onboarding.summary.hypothesis_count} deterministic hypothesis/hypotheses`);
  observations.push(`consistency categories: confirmed=${counts.confirmed}, contradicted=${counts.contradicted}, stale-doc=${counts['stale-doc']}, graph-gap=${counts['graph-gap']}, unknown=${counts.unknown}`);
  observations.push(cotx.present ? `cotx map present${cotx.compiled_at ? `, compiled_at=${cotx.compiled_at}` : ''}` : 'cotx map missing');
  observations.push(cotx.truth_graph_present ? 'storage-v2 truth graph present' : 'storage-v2 truth graph missing');
  observations.push(architecture.present ? `architecture store present with ${architecture.perspectives.length} perspective(s)` : 'architecture store missing');
  observations.push(truthCorrections.total > 0
    ? `${truthCorrections.total} truth correction proposal(s) recorded, ${truthCorrections.high_confidence} high-confidence`
    : 'no truth correction proposals recorded');
  return observations;
}

function buildNextActions(
  onboarding: OnboardingContext,
  cotx: LlmEnrichmentEvalRecord['cotx'],
  architecture: LlmEnrichmentEvalRecord['architecture'],
  truthCorrections: CotxTruthCorrectionSummary,
  mode: LlmEnrichmentEvalMode,
): string[] {
  const actions: string[] = [];
  const counts = onboarding.summary.consistency_counts;
  if (!cotx.present) actions.push('run cotx compile before graph-backed architecture validation');
  else if (!cotx.truth_graph_present) actions.push('recompile to populate .cotx/v2/truth.lbug before scoring groundedness');
  if (!architecture.present && mode.startsWith('cotx-')) actions.push('build the canonical C4/Structurizr-style architecture workspace before LLM docs generation');
  if (counts.contradicted > 0) actions.push('review contradicted onboarding document references before treating docs as architecture evidence');
  if (counts['graph-gap'] > 0) actions.push('inspect graph-gap references to decide whether parser coverage or docs are stale');
  if (counts['stale-doc'] > 0) actions.push('invalidate or refresh stale architecture docs before using them as synthesis input');
  if (truthCorrections.high_confidence > 0) actions.push('promote high-confidence truth correction proposals into deterministic parser/compiler tests');
  if (actions.length === 0) actions.push('score deterministic baseline output against the rubric, then run caller-agent and built-in LLM modes with the same task');
  return actions;
}

function countArchitectureSidecars(
  projectRoot: string,
): LlmEnrichmentEvalRecord['architecture']['sampled_sidecars'] {
  const counts = { descriptions: 0, diagrams: 0, data_files: 0 };
  const archRoot = path.join(projectRoot, '.cotx', 'architecture');
  if (!safeStat(archRoot)?.isDirectory()) return counts;

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    for (const entry of safeReadDir(dir)) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      if (entry.name === 'description.md') counts.descriptions += 1;
      if (entry.name === 'diagram.mmd') counts.diagrams += 1;
      if (entry.name === 'data.yaml') counts.data_files += 1;
    }
  };

  walk(archRoot, 0);
  return counts;
}

function readYamlRecord(filePath: string): Record<string, unknown> | null {
  if (!safeStat(filePath)?.isFile()) return null;
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeReadDir(filePath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(filePath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

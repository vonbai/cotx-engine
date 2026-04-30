import path from 'node:path';
import { readExistingConfig } from '../config.js';
import { tryReadGitValue } from '../lib/git.js';
import { runAgenticBootstrapEnrichment } from '../llm/agentic-enrichment-session.js';
import type { EnrichResult } from '../llm/enricher.js';
import type { ArchitectureEnrichResult } from '../llm/architecture-enricher.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import type {
  BootstrapEnrichmentState,
  CompileEnrichPolicy,
  IncrementalEnrichPolicy,
} from '../store/schema.js';
import { CotxStore } from '../store/store.js';

export const BOOTSTRAP_ENRICHMENT_VERSION = 'cotx-compile-bootstrap-v1';

export interface CompileBootstrapHooks {
  autoEnrich: (projectRoot: string, options?: {
    limit?: number;
    dryRun?: boolean;
    layer?: string;
    nodeIds?: string[];
    log?: (msg: string) => void;
  }) => Promise<EnrichResult>;
  enrichArchitecture: (projectRoot: string, options?: {
    dryRun?: boolean;
    log?: (...args: unknown[]) => void;
  }) => Promise<ArchitectureEnrichResult>;
}

export interface CompileBootstrapExecution {
  policy: CompileEnrichPolicy;
  ran: boolean;
  skipped_reason?: string;
  layers: Array<'module' | 'architecture'>;
  module_summary?: {
    total: number;
    succeeded: number;
    failed: number;
  };
  architecture_summary?: ArchitectureEnrichResult;
}

export interface IncrementalEnrichmentExecution {
  policy: IncrementalEnrichPolicy;
  ran: boolean;
  skipped_reason?: string;
  target_node_ids: string[];
  summary?: {
    total: number;
    succeeded: number;
    failed: number;
  };
}

interface BootstrapBaselineState {
  modulesReady: boolean;
  architectureReady: boolean;
  outdated: boolean;
}

function hasModuleBootstrapBaseline(store: CotxStore): boolean {
  const { modules } = store.loadAllSemanticArtifacts();
  return modules.some((m) => Boolean(m.enriched?.responsibility));
}

function hasArchitectureBootstrapBaseline(archStore: ArchitectureStore): boolean {
  if (!archStore.exists()) return false;
  const meta = archStore.readMeta();
  if (meta.mode === 'auto') return false;
  return archStore.listAllPaths().some((archPath) => {
    const description = archStore.readDescription(archPath);
    return Boolean(description && description.trim().length > 0);
  });
}

function readBaselineState(store: CotxStore, archStore: ArchitectureStore): BootstrapBaselineState {
  const bootstrap = store.readMeta().bootstrap_enrichment;
  const modulesReady = hasModuleBootstrapBaseline(store);
  const architectureReady = hasArchitectureBootstrapBaseline(archStore);
  const outdated = Boolean(
    bootstrap &&
    bootstrap.baseline_version !== BOOTSTRAP_ENRICHMENT_VERSION,
  );
  return { modulesReady, architectureReady, outdated };
}

function requestedBootstrapLayers(
  policy: CompileEnrichPolicy,
  state: BootstrapBaselineState,
): Array<'module' | 'architecture'> {
  if (policy === 'never') return [];
  if (policy === 'force-bootstrap') return ['module', 'architecture'];

  const layers: Array<'module' | 'architecture'> = [];
  if (state.outdated || !state.modulesReady) layers.push('module');
  if (state.outdated || !state.architectureReady) layers.push('architecture');
  return layers;
}

function buildBootstrapState(
  projectRoot: string,
  execution: CompileBootstrapExecution,
): BootstrapEnrichmentState | null {
  if (!execution.ran) return null;
  return {
    schema_version: 'cotx.bootstrap_enrichment.v1',
    baseline_version: BOOTSTRAP_ENRICHMENT_VERSION,
    policy: execution.policy,
    created_at: new Date().toISOString(),
    git_head: tryReadGitValue(projectRoot, ['rev-parse', 'HEAD']),
    git_branch: tryReadGitValue(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    worktree_path: path.resolve(projectRoot),
    layers: execution.layers,
    ...(execution.module_summary ? { module_summary: execution.module_summary } : {}),
    ...(execution.architecture_summary ? { architecture_summary: execution.architecture_summary } : {}),
  };
}

export async function runCompileBootstrapEnrichment(
  projectRoot: string,
  store: CotxStore,
  archStore: ArchitectureStore,
  policy: CompileEnrichPolicy,
  hooks: CompileBootstrapHooks,
  log: (line: string) => void,
): Promise<CompileBootstrapExecution> {
  if (policy === 'never') {
    return { policy, ran: false, skipped_reason: 'enrich_policy=never', layers: [] };
  }

  let config = null;
  try {
    config = readExistingConfig();
  } catch (error) {
    if (policy === 'force-bootstrap') throw error;
    return { policy, ran: false, skipped_reason: 'invalid-llm-config', layers: [] };
  }
  if (!config?.llm?.chat_model) {
    if (policy === 'force-bootstrap') {
      throw new Error('force-bootstrap requested, but no built-in LLM is configured in ~/.cotx/config.json');
    }
    return { policy, ran: false, skipped_reason: 'no-llm-configured', layers: [] };
  }

  const baseline = readBaselineState(store, archStore);
  const layers = requestedBootstrapLayers(policy, baseline);
  if (layers.length === 0) {
    return { policy, ran: false, skipped_reason: 'bootstrap-baseline-already-present', layers: [] };
  }

  const execution: CompileBootstrapExecution = {
    policy,
    ran: true,
    layers,
  };

  try {
    // Default: detach LLM enrichment to a background worker. Structural
    // compile (parse + algorithmic layers + auto_description) already
    // produced a fully-queryable map — the agent can use cotx_query /
    // cotx_context / cotx_map immediately against auto_description values.
    // The background worker adds LLM `enriched.responsibility` on modules
    // plus architecture descriptions. Progress is readable via
    // cotx_enrichment_status / .cotx/enrichment-status.json.
    log('  Bootstrap enrich: detaching to background worker');
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn(
        process.execPath,
        [process.argv[1], 'enrich-bg', projectRoot],
        { stdio: 'ignore', detached: true },
      );
      child.unref();
      log(`    background worker pid=${child.pid}; see .cotx/enrichment-status.json`);
    } catch (err) {
      log(`    [warn] failed to spawn background worker: ${err instanceof Error ? err.message : String(err)}; falling back to inline`);
      const agentic = await runAgenticBootstrapEnrichment(projectRoot, { llm: config.llm, log });
      if (layers.includes('module')) execution.module_summary = agentic.module_summary;
      if (layers.includes('architecture')) execution.architecture_summary = agentic.architecture_summary;
    }

    const state = buildBootstrapState(projectRoot, execution);
    if (state) store.updateMeta({ bootstrap_enrichment: state });
    return execution;
  } catch (error) {
    if (policy === 'force-bootstrap') throw error;
    return {
      ...execution,
      ran: false,
      skipped_reason: `bootstrap-failed:${error instanceof Error ? error.message : String(error)}`,
      layers,
    };
  }
}

export async function runIncrementalSemanticEnrichment(
  projectRoot: string,
  store: CotxStore,
  policy: IncrementalEnrichPolicy,
  staleNodes: Array<{ nodeId: string; layer: string }>,
  affectedNodeIds: Iterable<string>,
  hooks: Pick<CompileBootstrapHooks, 'autoEnrich'>,
  log: (line: string) => void,
): Promise<IncrementalEnrichmentExecution> {
  if (policy === 'never') {
    return { policy, ran: false, skipped_reason: 'enrich_policy=never', target_node_ids: [] };
  }

  let config = null;
  try {
    config = readExistingConfig();
  } catch (error) {
    if (policy === 'force-affected') throw error;
    return { policy, ran: false, skipped_reason: 'invalid-llm-config', target_node_ids: [] };
  }
  if (!config?.llm?.chat_model) {
    if (policy === 'force-affected') {
      throw new Error('force-affected requested, but no built-in LLM is configured in ~/.cotx/config.json');
    }
    return { policy, ran: false, skipped_reason: 'no-llm-configured', target_node_ids: [] };
  }

  const affectedSet = new Set([...affectedNodeIds]);
  const targetNodeIds = [...new Set(
    staleNodes
      .filter((node) => policy === 'stale-if-available' || policy === 'force-affected' || affectedSet.has(node.nodeId))
      .map((node) => node.nodeId),
  )].sort();

  if (targetNodeIds.length === 0) {
    return { policy, ran: false, skipped_reason: 'no-stale-targets', target_node_ids: [] };
  }

  log(`  Incremental enrich: ${targetNodeIds.length} target(s)`);
  const result = await hooks.autoEnrich(projectRoot, {
    nodeIds: targetNodeIds,
    log,
  });

  return {
    policy,
    ran: true,
    target_node_ids: targetNodeIds,
    summary: {
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
    },
  };
}

/**
 * Agentic enrichment session: the two-phase orchestrator that replaces the
 * old per-node/per-element loops in enricher.ts and architecture-enricher.ts.
 *
 * Design: cotx provides context (graph skeletons) + tools (read / batch_write)
 * + goal (system prompt). Agent decides strategy. Cotx measures outcome.
 */

import { Agent } from '@mariozechner/pi-agent-core';
import { createReadOnlyTools } from '@mariozechner/pi-coding-agent';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import type { LlmConfig } from '../config.js';
import { CotxStore } from '../store/store.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import {
  modelInfo,
  requirePiAgentModel,
  resolvePiAgentApiKey,
} from './agentic-model.js';
import {
  createEnrichmentTools,
  type EnrichmentToolsBundle,
  type EnrichmentWrite,
} from './agentic-enrichment-tools.js';
import {
  ENRICHMENT_SYSTEM_PROMPT,
  formatEnrichmentInput,
  type EnrichmentSessionInput,
} from './agentic-enrichment-prompts.js';
import {
  EnrichmentCache,
  buildEnricherVersion,
  hashPrompt,
} from './enrichment-cache.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';

const ENRICHMENT_CACHE_SCHEMA_VERSION = 1;

export interface EnrichmentSessionOptions {
  projectRoot: string;
  /** Optional label surfaced in logs (e.g. "modules:1/5", "finalize", "on-demand:concept"). */
  label?: string;
  skeleton: Record<string, unknown>;
  llm: LlmConfig;
  model?: Model<'openai-completions'>;
  budgetCap?: number;
  budgetSoftWarn?: number;
  log?: (msg: string) => void;
}

export interface EnrichmentSessionResult {
  /** Echoes back the label passed in options. */
  label: string;
  total_written: number;
  total_batches: number;
  total_tool_calls: number;
  finalized: boolean;
  written_sample: EnrichmentWrite[]; // up to 5
  skipped: Array<{ node_id: string; reason: string }>;
  model: { provider: string; id: string };
  duration_ms: number;
}

const MAX_SAMPLE = 5;
const DEFAULT_MAX_TURNS = 30;

export async function runEnrichmentSession(
  options: EnrichmentSessionOptions,
): Promise<EnrichmentSessionResult> {
  const log = options.log ?? (() => {});
  const label = options.label ?? 'enrich';
  const started = Date.now();
  const startedStamp = new Date().toISOString();
  log(`[enrich/${label}] T+0: session started at ${startedStamp}`);

  const model = options.model ?? requirePiAgentModel(options.llm);
  const writtenSample: EnrichmentWrite[] = [];
  const allSkipped: Array<{ node_id: string; reason: string }> = [];

  const bundle: EnrichmentToolsBundle = createEnrichmentTools({
    projectRoot: options.projectRoot,
    budgetCap: options.budgetCap,
    budgetSoftWarn: options.budgetSoftWarn,
    onToolCall: () => {},
    onBatchWrite: (written, skipped) => {
      for (const w of written) {
        if (writtenSample.length < MAX_SAMPLE) writtenSample.push(w);
      }
      for (const s of skipped) {
        allSkipped.push(s);
        log(`[enrich/${label}] skipped ${s.node_id}: ${s.reason}`);
      }
    },
    onFinalize: (reason) => {
      log(`[enrich/${label}] agent finalized: ${reason}`);
    },
  });

  const readOnlyTools = createReadOnlyTools(options.projectRoot);
  const tools: AgentTool<any>[] = [...readOnlyTools, ...bundle.tools];
  const allowedNames = new Set(tools.map((t) => t.name));

  const systemPrompt = ENRICHMENT_SYSTEM_PROMPT;

  // Enrichment is primarily a pattern-match + cite-source task. Reasoning
  // tokens add latency without improving grounded-citation quality, so we
  // default thinking off. Agent still has tools + ReAct if it needs deeper
  // analysis — reasoning is a different axis.
  const thinkingLevel: 'off' | 'medium' = 'off';

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools,
    },
    getApiKey: () => resolvePiAgentApiKey(options.llm),
    toolExecution: 'parallel',
    beforeToolCall: async ({ toolCall }) => {
      if (!allowedNames.has(toolCall.name)) {
        return { block: true, reason: `Tool not allowed in enrichment session: ${toolCall.name}. Allowed tools: ${Array.from(allowedNames).join(', ')}` };
      }
      // Note: do NOT block based on finalized state — with parallel tool
      // execution, cotx_finalize may race ahead of writes in the same batch,
      // but we still want those writes to land.
      return undefined;
    },
  });

  // Subscribe to agent events so we can see what the model is thinking/doing.
  // This is the core observability hook: without it we have no idea why the
  // agent loop might be stalling.
  // Full-fidelity observability: agent text blocks (reasoning / plan) kept
  // at 500 chars so prompt-engineers can study the agent's strategic
  // decisions. Tool calls stay short — the interesting info is the pattern
  // of which tools it reaches for.
  agent.subscribe((event) => {
    if (event.type === 'message_end' && 'message' in event && event.message?.role === 'assistant') {
      const msg = event.message as { content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }> };
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          const snippet = block.text.trim().slice(0, 500).replace(/\n/g, ' ');
          log(`[enrich/${label}] agent text: ${snippet}${block.text.length > 500 ? '…' : ''}`);
        } else if (block.type === 'toolCall') {
          const argsStr = JSON.stringify(block.arguments).slice(0, 140);
          log(`[enrich/${label}] agent tool: ${block.name}(${argsStr}${argsStr.length >= 140 ? '…' : ''})`);
        }
      }
    }
    if (event.type === 'tool_execution_end' && 'toolName' in event) {
      const errMark = (event as { isError?: boolean }).isError ? ' [ERROR]' : '';
      log(`[enrich/${label}] tool_done: ${event.toolName}${errMark}`);
    }
  });

  const sessionInput: EnrichmentSessionInput = {
    label,
    project_root: options.projectRoot,
    project_name: pickProjectName(options.projectRoot),
    compile_stats: pickStats(options.projectRoot),
    skeleton: options.skeleton,
  };

  log(`[enrich/${label}] starting agent with ${modelInfo(model).provider}/${modelInfo(model).id}`);

  // Run the agent with its initial prompt. pi-agent's prompt() drives the full
  // tool-calling loop until the model stops issuing tool calls.
  await agent.prompt(formatEnrichmentInput(sessionInput));

  // If the agent didn't produce a single write AND didn't finalize, it may
  // have misunderstood — surface a gentle nudge (ONE retry, not coercive).
  const state = bundle.getState();
  if (!state.finalized && state.totalBatches === 0) {
    log(`[enrich/${label}] zero writes — sending one clarifying nudge`);
    await agent.prompt(JSON.stringify({
      reminder: 'No write_enrichment calls yet. If the input context is sufficient, please start writing. If something is unclear or blocking, explain and call cotx_finalize with that reason.',
    }, null, 2));
  }

  const finalState = bundle.getState();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log(
    `[enrich/${label}] done in ${elapsed}s: wrote ${finalState.totalWritten} in ${finalState.totalBatches} batches, ` +
      `${finalState.totalToolCalls} total tool calls, finalized=${finalState.finalized}`,
  );

  return {
    label,
    total_written: finalState.totalWritten,
    total_batches: finalState.totalBatches,
    total_tool_calls: finalState.totalToolCalls,
    finalized: finalState.finalized,
    written_sample: writtenSample,
    skipped: allSkipped,
    model: modelInfo(model),
    duration_ms: Date.now() - started,
  };
}

function pickProjectName(projectRoot: string): string {
  try {
    const store = new CotxStore(projectRoot);
    if (store.exists()) return store.readMeta().project;
  } catch {}
  return projectRoot.split('/').filter(Boolean).pop() ?? 'project';
}

function pickStats(projectRoot: string) {
  try {
    const store = new CotxStore(projectRoot);
    if (store.exists()) return store.readMeta().stats;
  } catch {}
  return { modules: 0, concepts: 0, contracts: 0, flows: 0, concerns: 0 };
}

/**
 * Convenience: build the compact structural skeleton used as input to stage 1.
 * This is shared with integration code in enricher.ts.
 */
/**
 * Unified enrichment context — everything the agent might want to see,
 * always populated from one bulk LBug read per layer. Consumers slice
 * what they need into the per-session skeleton.
 */
export interface EnrichmentContext {
  top_dirs: string[];
  modules: Array<{
    node_id: string;
    struct_hash: string;
    files_count: number;
    files_sample: string[];
    depends_on: string[];
    depended_by: string[];
    auto_description?: string;
  }>;
  concepts: Array<{
    node_id: string;
    struct_hash: string;
    aliases: string[];
    appears_in: string[];
    layer: string;
    auto_description?: string;
  }>;
  contracts: Array<{
    node_id: string;
    struct_hash: string;
    provider: string;
    consumer: string;
    interface_sample: string[];
  }>;
  flows: Array<{
    node_id: string;
    struct_hash: string;
    trigger: string;
    steps_sample: Array<{ module: string; function: string }>;
  }>;
  module_summaries: Array<{ id: string; responsibility: string | null; files_count: number }>;
  architecture_perspectives: Array<{
    id: string;
    label: string;
    components: Array<{ id: string; kind: string; children_count: number }>;
  }>;
}

const MAX_FILES_PER_MODULE = 8;
const MAX_INTERFACE_PER_CONTRACT = 8;
const MAX_STEPS_PER_FLOW = 6;

/**
 * Build the full enrichment context in one pass: 4 bulk LBug reads + one
 * architecture-store walk. Any stage (module batch / architecture batch /
 * on-demand by nodeIds) is just a slice over this.
 */
export function buildEnrichmentContext(projectRoot: string): EnrichmentContext {
  const dbPath = `${projectRoot}/.cotx/v2/truth.lbug`;
  const allModules = readSemanticArtifactsSync(dbPath, 'module').map((a) => a.payload as any);
  const allConcepts = readSemanticArtifactsSync(dbPath, 'concept').map((a) => a.payload as any);
  const allContracts = readSemanticArtifactsSync(dbPath, 'contract').map((a) => a.payload as any);
  const allFlows = readSemanticArtifactsSync(dbPath, 'flow').map((a) => a.payload as any);

  const modules = allModules.map((mod) => ({
    node_id: mod.id,
    struct_hash: mod.struct_hash ?? '',
    files_count: (mod.files ?? []).length,
    files_sample: (mod.files ?? []).slice(0, MAX_FILES_PER_MODULE),
    depends_on: mod.depends_on ?? [],
    depended_by: mod.depended_by ?? [],
    auto_description: (mod.enriched as { auto_description?: string } | undefined)?.auto_description,
  }));

  const concepts = allConcepts.map((c) => ({
    node_id: c.id,
    struct_hash: c.struct_hash ?? '',
    aliases: c.aliases ?? [],
    appears_in: (c.appears_in ?? []).slice(0, 8),
    layer: c.layer ?? 'unknown',
    auto_description: (c.enriched as { auto_description?: string } | undefined)?.auto_description,
  }));

  const contracts = allContracts.map((c) => ({
    node_id: c.id,
    struct_hash: c.struct_hash ?? '',
    provider: c.provider,
    consumer: c.consumer,
    interface_sample: (c.interface ?? []).slice(0, MAX_INTERFACE_PER_CONTRACT).map((i: any) =>
      typeof i === 'string' ? i : i.name ?? JSON.stringify(i),
    ),
  }));

  const flows = allFlows.map((f: any) => {
    const steps = Array.isArray(f.steps) ? f.steps : [];
    return {
      node_id: f.id,
      struct_hash: f.struct_hash ?? '',
      trigger: f.trigger ?? '',
      steps_sample: steps.slice(0, MAX_STEPS_PER_FLOW).map((s: any) => ({
        module: s.module ?? '',
        function: s.function ?? '',
      })),
    };
  });

  const moduleSummaries = allModules.map((mod) => ({
    id: mod.id,
    responsibility: (mod.enriched as { responsibility?: string } | undefined)?.responsibility ?? null,
    files_count: (mod.files ?? []).length,
  }));

  const archStore = new ArchitectureStore(projectRoot);
  const architecturePerspectives: EnrichmentContext['architecture_perspectives'] = [];
  if (archStore.exists()) {
    for (const perspectiveId of archStore.listPerspectives()) {
      try {
        const perspective = archStore.readPerspective(perspectiveId);
        architecturePerspectives.push({
          id: perspectiveId,
          label: perspective.label ?? perspectiveId,
          components: (perspective.components ?? []).map((component: any) => ({
            id: component.id,
            kind: component.kind ?? 'component',
            children_count: component.children?.length ?? 0,
          })),
        });
      } catch {
        // perspective unreadable — skip
      }
    }
  }

  const topDirs = Array.from(
    new Set(modules.flatMap((m) => m.files_sample.map((f: string) => f.split('/')[0]))),
  )
    .filter(Boolean)
    .sort();

  return {
    top_dirs: topDirs,
    modules,
    concepts,
    contracts,
    flows,
    module_summaries: moduleSummaries,
    architecture_perspectives: architecturePerspectives,
  };
}

/**
 * Top-level orchestrator: runs the two-phase bootstrap enrichment plus one
 * optional retry session for any module/concept/contract/flow still missing
 * `enriched.*` after stage 1. Called from compile-bootstrap.ts when
 * enrich mode is "agentic" (the new default).
 */
export interface AgenticBootstrapOptions {
  llm: LlmConfig;
  log?: (msg: string) => void;
  budgetCap?: number;
}

export interface AgenticBootstrapResult {
  structural: EnrichmentSessionResult | null;
  retry: EnrichmentSessionResult | null;
  synthesis: EnrichmentSessionResult | null;
  module_summary: { total: number; succeeded: number; failed: number };
  architecture_summary: {
    perspectives_enriched: number;
    descriptions_written: number;
    diagrams_written: number;
  };
}

export async function runAgenticBootstrapEnrichment(
  projectRoot: string,
  options: AgenticBootstrapOptions,
): Promise<AgenticBootstrapResult> {
  const log = options.log ?? (() => {});

  // Phase B: enrichment response cache. Skip any node whose (id, struct_hash,
  // enricher_version, field) was already enriched. The enricher_version is
  // hashed from the single unified prompt so cache entries are invalidated
  // whenever the prompt changes.
  const enricherVersion = buildEnricherVersion(
    { enrichment: hashPrompt(ENRICHMENT_SYSTEM_PROMPT) },
    options.llm.chat_model ?? 'unknown',
    ENRICHMENT_CACHE_SCHEMA_VERSION,
  );
  const cache = new EnrichmentCache(projectRoot, enricherVersion);
  const forceFull = process.env.COTX_FORCE_FULL === '1';
  if (forceFull) {
    log(`[enrich] COTX_FORCE_FULL=1 — bypassing response cache lookups (will still persist fresh writes)`);
  } else {
    log(`[enrich] response cache version=${enricherVersion}`);
  }

  // Stage 1: Structural, split into 4 parallel layer sessions.
  // Each session has a smaller context, runs concurrently, and can finalize
  // independently. This is the core scale-up for large repos — total wall-time
  // becomes max(modules, concepts, contracts, flows) rather than their sum.
  const context = buildEnrichmentContext(projectRoot);
  log(
    `[enrich] bulk context: ${context.modules.length} modules, ${context.concepts.length} concepts, ${context.contracts.length} contracts, ${context.flows.length} flows, ${context.architecture_perspectives.length} arch perspectives`,
  );

  // Apply cache: split module skeleton into (cacheHits, cacheMisses). Hits get
  // written directly from cache without any LLM call. Only misses go into
  // agent sessions. --force-full skips lookups entirely.
  const { modules: modulesForAgent, restoredCount } = forceFull
    ? { modules: context.modules, restoredCount: 0 }
    : await applyCacheHits(projectRoot, context, cache, log);
  if (restoredCount > 0) {
    log(`[enrich] cache restored ${restoredCount} enrichments without LLM`);
  }

  // Sub-chunk modules. Smaller chunks = more parallel sessions = lower wall
  // time, because Gemini's latency for a single response grows roughly
  // linearly with total parallel tool_calls emitted. 30 keeps the output
  // response <6K tokens so first-byte / total-time are both faster, and the
  // concurrency=3 gateway cap can keep 3 chunks in flight simultaneously.
  // Default enrichment scope is modules only: concept/contract/flow rely on
  // auto_description; architecture is handled by the finalize session below.
  const MAX_NODES_PER_SESSION = 30;
  const layerTasks: Array<{ label: string; skeleton: Record<string, unknown> }> = [];
  if (modulesForAgent.length > 0) {
    const totalChunks = Math.max(1, Math.ceil(modulesForAgent.length / MAX_NODES_PER_SESSION));
    for (let i = 0; i < totalChunks; i++) {
      const slice = modulesForAgent.slice(i * MAX_NODES_PER_SESSION, (i + 1) * MAX_NODES_PER_SESSION);
      if (slice.length === 0) continue;
      layerTasks.push({
        label: totalChunks === 1 ? 'modules' : `modules:${i + 1}/${totalChunks}`,
        skeleton: { top_dirs: context.top_dirs, modules: slice },
      });
    }
  }

  // Cap the number of concurrent agent sessions to avoid overwhelming the
  // LLM gateway (LiteLLM's default concurrency is 3; firing 30+ sessions at
  // once queues them and makes each run 10x longer). Default is
  // llm.concurrent (typically 3-4). Override via COTX_ENRICH_CONCURRENCY.
  const sessionConcurrency = Number(process.env.COTX_ENRICH_CONCURRENCY) ||
    options.llm.concurrent ||
    4;
  log(`[enrich] running ${layerTasks.length} parallel agent sessions with concurrency=${sessionConcurrency}`);
  const layerResults = await runWithConcurrencyLimit(
    sessionConcurrency,
    layerTasks.map((task) => () =>
      runEnrichmentSession({
        projectRoot,
        label: task.label,
        skeleton: task.skeleton,
        llm: options.llm,
        budgetCap: options.budgetCap,
        log,
      }),
    ),
  );

  // Summarize module-session outcomes.
  const structural = aggregateLayerResults(layerResults, Date.now(), layerTasks[0]?.label ?? 'modules');

  // Persist fresh enrichments written in this run to cache.
  persistFreshEnrichments(projectRoot, cache, log);

  // Follow-up: one session that handles (a) any modules the first pass missed
  // and (b) architecture descriptions. Architecture writing reads
  // enriched.responsibility via cotx_context or module_summaries, so running
  // it AFTER module persist guarantees the input is complete. Giving both
  // missed-module and architecture work to the same session removes the old
  // artificial `retry` vs `synthesis` split.
  const missingModules = detectMissingStructuralNodes(projectRoot).filter((n) => n.layer === 'module');
  // Re-read context so the architecture session sees the freshly-written
  // module.responsibility values. (Cache persist + write queue may have
  // landed work after the initial buildEnrichmentContext.)
  const freshContext = buildEnrichmentContext(projectRoot);
  log(
    `[enrich] finalize: ${missingModules.length} module(s) missing, ${freshContext.architecture_perspectives.length} architecture perspective(s)`,
  );
  let retry: EnrichmentSessionResult | null = null;
  const synthesis = await runEnrichmentSession({
    projectRoot,
    label: 'finalize',
    skeleton: {
      missing_nodes: missingModules.length > 0 && missingModules.length < 200
        ? enrichMissingNodesWithContext(missingModules, context)
        : [],
      top_dirs: freshContext.top_dirs,
      module_summaries: freshContext.module_summaries,
      architecture_perspectives: freshContext.architecture_perspectives,
    } as unknown as Record<string, unknown>,
    llm: options.llm,
    budgetCap: options.budgetCap,
    log,
  });

  const cacheStats = cache.getStats();
  log(`[enrich] cache stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses, ${cacheStats.puts} puts, ${cacheStats.entries} total entries`);
  cache.close();

  // Compute summary metrics
  const moduleCount = context.modules.length;
  const stillMissing = detectMissingStructuralNodes(projectRoot).filter((n) => n.layer === 'module').length;
  const moduleSuccess = moduleCount - stillMissing;
  const architectureSummary = summarizeArchitectureOutput(projectRoot, freshContext);

  return {
    structural,
    retry,
    synthesis,
    module_summary: {
      total: moduleCount,
      succeeded: moduleSuccess,
      failed: stillMissing,
    },
    architecture_summary: architectureSummary,
  };
}

export interface MissingNode {
  node_id: string;
  layer: 'module' | 'concept' | 'contract' | 'flow';
  field: string;
}

/**
 * Split each layer into (cacheHits, cacheMisses). Writes cache hits directly
 * via commandWrite so the agent only sees misses. Returns the filtered
 * skeleton slices + count of restored nodes for logging.
 */
async function applyCacheHits(
  projectRoot: string,
  context: EnrichmentContext,
  cache: EnrichmentCache,
  log: (msg: string) => void,
): Promise<{
  modules: EnrichmentContext['modules'];
  concepts: EnrichmentContext['concepts'];
  contracts: EnrichmentContext['contracts'];
  flows: EnrichmentContext['flows'];
  restoredCount: number;
}> {
  const skeleton = context;
  let restored = 0;

  // Pre-read the current payload for each layer ONCE via the bulk query,
  // then rehydrate cache hits in memory. This avoids commandWrite's
  // findNodeAcrossLayers which did 4 full-layer scans per node — 126×4=504
  // redundant LBug reads on dolt before any write could land.
  const store = new CotxStore(projectRoot);
  const payloadByLayer: Record<'module' | 'concept' | 'contract' | 'flow', Map<string, any>> = {
    module: new Map(),
    concept: new Map(),
    contract: new Map(),
    flow: new Map(),
  };
  const dbPath = `${projectRoot}/.cotx/v2/truth.lbug`;
  for (const a of readSemanticArtifactsSync(dbPath, 'module')) payloadByLayer.module.set(a.id, a.payload);
  for (const a of readSemanticArtifactsSync(dbPath, 'concept')) payloadByLayer.concept.set(a.id, a.payload);
  for (const a of readSemanticArtifactsSync(dbPath, 'contract')) payloadByLayer.contract.set(a.id, a.payload);
  for (const a of readSemanticArtifactsSync(dbPath, 'flow')) payloadByLayer.flow.set(a.id, a.payload);

  const restoreOrKeep = async <T extends { struct_hash: string; node_id?: string }>(
    items: T[],
    layer: 'module' | 'concept' | 'contract' | 'flow',
    fieldName: 'responsibility' | 'definition' | 'guarantees' | 'error_paths',
  ): Promise<T[]> => {
    const misses: T[] = [];
    const fieldFull = `enriched.${fieldName}`;
    const map = payloadByLayer[layer];
    const writes: Array<Promise<{ ok: boolean; item: T }>> = [];
    for (const item of items) {
      const nodeId = item.node_id as string;
      if (!item.struct_hash) { misses.push(item); continue; }
      const hit = cache.get(nodeId, item.struct_hash, fieldFull);
      if (!hit) { misses.push(item); continue; }
      const node = map.get(nodeId);
      if (!node) { misses.push(item); continue; }
      const enriched = node.enriched ?? { source_hash: item.struct_hash, enriched_at: new Date().toISOString() };
      enriched[fieldName] = fieldName === 'error_paths' ? JSON.parse(hit.content) : hit.content;
      enriched.source_hash = item.struct_hash;
      enriched.enriched_at = new Date().toISOString();
      node.enriched = enriched;
      // Kick off the write without awaiting — all writes for this layer
      // land in one batched flush via the setImmediate window below.
      const writeP: Promise<void> =
        layer === 'module' ? store.writeModuleAsync(node) :
        layer === 'concept' ? store.writeConceptAsync(node) :
        layer === 'contract' ? store.writeContractAsync(node) :
        store.writeFlowAsync(node);
      writes.push(writeP.then(() => ({ ok: true, item }), () => ({ ok: false, item })));
    }
    const results = await Promise.all(writes);
    for (const r of results) {
      if (r.ok) restored += 1;
      else misses.push(r.item);
    }
    return misses;
  };

  const modules = await restoreOrKeep(skeleton.modules, 'module', 'responsibility');
  const concepts = await restoreOrKeep(skeleton.concepts, 'concept', 'definition');
  const contracts = await restoreOrKeep(skeleton.contracts, 'contract', 'guarantees');
  const flows = await restoreOrKeep(skeleton.flows, 'flow', 'error_paths');

  if (restored > 0) log(`[enrich] cache: restored ${restored} nodes directly`);

  return { modules, concepts, contracts, flows, restoredCount: restored };
}

/**
 * After the agent sessions complete, walk every node with an `enriched.*`
 * field and persist (node_id, struct_hash, field, content) to cache. Next
 * compile on the same struct_hash becomes a zero-LLM restore.
 */
function persistFreshEnrichments(
  projectRoot: string,
  cache: EnrichmentCache,
  log: (msg: string) => void,
): void {
  let persisted = 0;

  const normalize = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  };

  // Bulk-read each layer once instead of opening LBug per-node (same bug
  // that made startup take 2 min). With bulk reads, this entire persist
  // phase runs in a few seconds even on dolt-scale projects.
  const dbPath = `${projectRoot}/.cotx/v2/truth.lbug`;
  for (const a of readSemanticArtifactsSync(dbPath, 'module')) {
    const m = a.payload as { struct_hash?: string; enriched?: { responsibility?: unknown } };
    const resp = normalize(m.enriched?.responsibility);
    if (m.struct_hash && resp) {
      cache.put(a.id, m.struct_hash, 'enriched.responsibility', resp);
      persisted += 1;
    }
  }
  for (const a of readSemanticArtifactsSync(dbPath, 'concept')) {
    const c = a.payload as { struct_hash?: string; enriched?: { definition?: unknown } };
    const def = normalize(c.enriched?.definition);
    if (c.struct_hash && def) {
      cache.put(a.id, c.struct_hash, 'enriched.definition', def);
      persisted += 1;
    }
  }
  for (const a of readSemanticArtifactsSync(dbPath, 'contract')) {
    const c = a.payload as { struct_hash?: string; enriched?: { guarantees?: unknown } };
    const g = normalize(c.enriched?.guarantees);
    if (c.struct_hash && g) {
      cache.put(a.id, c.struct_hash, 'enriched.guarantees', g);
      persisted += 1;
    }
  }
  for (const a of readSemanticArtifactsSync(dbPath, 'flow')) {
    const f = a.payload as { struct_hash?: string; enriched?: { error_paths?: unknown } };
    const e = normalize(f.enriched?.error_paths);
    if (f.struct_hash && e) {
      cache.put(a.id, f.struct_hash, 'enriched.error_paths', e);
      persisted += 1;
    }
  }

  if (persisted > 0) log(`[enrich] cache: persisted ${persisted} enrichments for future runs`);
}

/**
 * Run a list of async task factories with at most N concurrent at a time.
 * Returns PromiseSettledResult[] preserving the input order.
 */
async function runWithConcurrencyLimit<T>(
  limit: number,
  taskFactories: Array<() => Promise<T>>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(taskFactories.length);
  let nextIdx = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIdx++;
      if (i >= taskFactories.length) return;
      try {
        const value = await taskFactories[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, taskFactories.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Combine the results of 4 parallel layer sessions into a single rollup.
 * Rejected sessions are logged and counted as 0 writes.
 */
function aggregateLayerResults(
  results: PromiseSettledResult<EnrichmentSessionResult>[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _startMs: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _firstLabel: string,
): EnrichmentSessionResult {
  let totalWritten = 0;
  let totalBatches = 0;
  let totalToolCalls = 0;
  let anyFinalized = false;
  let maxDuration = 0;
  let modelInfoRef: { provider: string; id: string } | null = null;
  const writtenSample: EnrichmentWrite[] = [];
  const skipped: Array<{ node_id: string; reason: string }> = [];

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const v = r.value;
      totalWritten += v.total_written;
      totalBatches += v.total_batches;
      totalToolCalls += v.total_tool_calls;
      anyFinalized = anyFinalized || v.finalized;
      maxDuration = Math.max(maxDuration, v.duration_ms);
      modelInfoRef = modelInfoRef ?? v.model;
      for (const w of v.written_sample) if (writtenSample.length < MAX_SAMPLE) writtenSample.push(w);
      for (const s of v.skipped) skipped.push(s);
    } else {
      skipped.push({ node_id: '<layer-session-failed>', reason: String(r.reason) });
    }
  }

  return {
    label: 'modules',
    total_written: totalWritten,
    total_batches: totalBatches,
    total_tool_calls: totalToolCalls,
    finalized: anyFinalized,
    written_sample: writtenSample,
    skipped,
    model: modelInfoRef ?? { provider: 'unknown', id: 'unknown' },
    duration_ms: maxDuration,
  };
}

/**
 * Enrich a bare list of missing-node ids with the full structural skeleton
 * entries so the retry agent doesn't need to call cotx_context.
 */
export function enrichMissingNodesWithContext(
  missing: MissingNode[],
  ctx: EnrichmentContext,
): Array<MissingNode & { context: unknown }> {
  const modIdx = new Map(ctx.modules.map((m) => [m.node_id, m]));
  const concIdx = new Map(ctx.concepts.map((c) => [c.node_id, c]));
  const contIdx = new Map(ctx.contracts.map((c) => [c.node_id, c]));
  const flowIdx = new Map(ctx.flows.map((f) => [f.node_id, f]));
  return missing.map((m) => {
    let context: unknown = null;
    if (m.layer === 'module') context = modIdx.get(m.node_id) ?? null;
    else if (m.layer === 'concept') context = concIdx.get(m.node_id) ?? null;
    else if (m.layer === 'contract') context = contIdx.get(m.node_id) ?? null;
    else if (m.layer === 'flow') context = flowIdx.get(m.node_id) ?? null;
    return { ...m, context };
  });
}

export function detectMissingStructuralNodes(projectRoot: string): MissingNode[] {
  const missing: MissingNode[] = [];
  const dbPath = `${projectRoot}/.cotx/v2/truth.lbug`;
  for (const a of readSemanticArtifactsSync(dbPath, 'module')) {
    const e = (a.payload as { enriched?: { responsibility?: string } }).enriched;
    if (!e?.responsibility) missing.push({ node_id: a.id, layer: 'module', field: 'enriched.responsibility' });
  }
  for (const a of readSemanticArtifactsSync(dbPath, 'concept')) {
    const e = (a.payload as { enriched?: { definition?: string } }).enriched;
    if (!e?.definition) missing.push({ node_id: a.id, layer: 'concept', field: 'enriched.definition' });
  }
  for (const a of readSemanticArtifactsSync(dbPath, 'contract')) {
    const e = (a.payload as { enriched?: { guarantees?: string } }).enriched;
    if (!e?.guarantees) missing.push({ node_id: a.id, layer: 'contract', field: 'enriched.guarantees' });
  }
  for (const a of readSemanticArtifactsSync(dbPath, 'flow')) {
    const e = (a.payload as { enriched?: { error_paths?: string } }).enriched;
    if (!e?.error_paths) missing.push({ node_id: a.id, layer: 'flow', field: 'enriched.error_paths' });
  }
  return missing;
}

function summarizeArchitectureOutput(
  projectRoot: string,
  skeleton: Pick<EnrichmentContext, 'architecture_perspectives'>,
): { perspectives_enriched: number; descriptions_written: number; diagrams_written: number } {
  const archStore = new ArchitectureStore(projectRoot);
  if (!archStore.exists()) {
    return { perspectives_enriched: 0, descriptions_written: 0, diagrams_written: 0 };
  }
  let descriptionsWritten = 0;
  let diagramsWritten = 0;
  for (const perspective of skeleton.architecture_perspectives) {
    const desc = archStore.readDescription(perspective.id);
    if (desc && desc.trim().length > 0) descriptionsWritten++;
    const diagram = archStore.readDiagram(perspective.id);
    if (diagram && diagram.trim().length > 0) diagramsWritten++;
    for (const component of perspective.components) {
      const componentPath = `${perspective.id}/${component.id}`;
      const compDesc = archStore.readDescription(componentPath);
      if (compDesc && compDesc.trim().length > 0) descriptionsWritten++;
      const compDiagram = archStore.readDiagram(componentPath);
      if (compDiagram && compDiagram.trim().length > 0) diagramsWritten++;
    }
  }
  return {
    perspectives_enriched: skeleton.architecture_perspectives.length,
    descriptions_written: descriptionsWritten,
    diagrams_written: diagramsWritten,
  };
}


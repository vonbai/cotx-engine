/**
 * LLM Auto-Enricher
 *
 * Reads stale nodes from the semantic map and writes LLM-generated enrichments
 * back using commandWrite. Concurrency is bounded by `llm.concurrent` config
 * (default: 3).
 */

import { readConfig } from '../config.js';
import { createLlmClient, type LlmClient } from './client.js';
import { CotxStore } from '../store/store.js';
import { detectStale } from '../compiler/stale-detector.js';
import { commandWrite } from '../commands/write.js';
import type { ModuleNode, ConceptNode, ContractNode, FlowNode } from '../store/schema.js';
import { extendArray } from '../core/shared/array-utils.js';

export interface EnrichResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    node_id: string;
    layer: string;
    field: string;
    status: 'ok' | 'error';
    error?: string;
  }>;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildModulePrompt(mod: ModuleNode): { system: string; user: string } {
  const autoDesc = (mod.enriched as Record<string, unknown> | undefined)?.auto_description as string | undefined;
  const lines: string[] = [
    `Module: ${mod.id}`,
    `Entry point: ${mod.canonical_entry || '(none)'}`,
    `Files (${mod.files.length}): ${mod.files.slice(0, 5).join(', ')}${mod.files.length > 5 ? ', ...' : ''}`,
    `Dependencies: ${mod.depends_on.length > 0 ? mod.depends_on.join(', ') : '(none)'}`,
    `Depended by: ${mod.depended_by.length > 0 ? mod.depended_by.join(', ') : '(none)'}`,
  ];
  if (autoDesc) {
    lines.push(`Auto-description: ${autoDesc}`);
  }
  return {
    system: "You are a code analyst. Write ONE concise sentence describing this module's responsibility.",
    user: lines.join('\n'),
  };
}

function buildConceptPrompt(concept: ConceptNode): { system: string; user: string } {
  return {
    system: 'You are a code analyst. Write ONE sentence defining this concept in the context of this codebase.',
    user: [
      `Concept: ${concept.id}`,
      `Aliases: ${concept.aliases.length > 0 ? concept.aliases.join(', ') : '(none)'}`,
      `Appears in: ${concept.appears_in.length} files`,
      `Home module: ${concept.layer}`,
    ].join('\n'),
  };
}

function buildContractPrompt(contract: ContractNode): { system: string; user: string } {
  return {
    system: 'You are a code analyst. List the key guarantees this interface provides, as a JSON array of strings.',
    user: [
      `Contract: ${contract.id}`,
      `Provider: ${contract.provider}`,
      `Consumer: ${contract.consumer}`,
      `Interface functions: ${contract.interface.join(', ')}`,
    ].join('\n'),
  };
}

function buildFlowPrompt(flow: FlowNode): { system: string; user: string } {
  const steps = flow.steps
    ? flow.steps.map(s => `${s.module}.${s.function}`).join(' → ')
    : '(none)';
  return {
    system: 'You are a code analyst. Describe error handling paths as a JSON array of {condition, behavior} objects.',
    user: [
      `Flow: ${flow.id}`,
      `Trigger: ${flow.trigger ?? '(none)'}`,
      `Steps: ${steps}`,
    ].join('\n'),
  };
}

type PromptPair = { system: string; user: string };

function buildPrompt(store: CotxStore, nodeId: string, layer: string): { prompt: PromptPair; field: string } | null {
  switch (layer) {
    case 'module': {
      if (!store.listModules().includes(nodeId)) return null;
      const mod = store.readModule(nodeId);
      return { prompt: buildModulePrompt(mod), field: 'enriched.responsibility' };
    }
    case 'concept': {
      if (!store.listConcepts().includes(nodeId)) return null;
      const concept = store.readConcept(nodeId);
      return { prompt: buildConceptPrompt(concept), field: 'enriched.definition' };
    }
    case 'contract': {
      if (!store.listContracts().includes(nodeId)) return null;
      const contract = store.readContract(nodeId);
      return { prompt: buildContractPrompt(contract), field: 'enriched.guarantees' };
    }
    case 'flow': {
      if (!store.listFlows().includes(nodeId)) return null;
      const flow = store.readFlow(nodeId);
      return { prompt: buildFlowPrompt(flow), field: 'enriched.error_paths' };
    }
    default:
      return null;
  }
}

// ── Concurrency helper ────────────────────────────────────────────────────────

async function runInBatches<T>(
  tasks: Array<() => Promise<T>>,
  batchSize: number,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn => fn()));
    extendArray(results, batchResults);
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Serial per-node enrichment driver. Kept for the `cotx enrich --auto` CLI
 * subcommand and legacy callers. New callers should use the agentic session
 * (see `agentic-enrichment-session.ts:runEnrichmentSession`), which emits
 * parallel tool calls and batches writes — it is 10-50x faster on >20 nodes.
 *
 * @deprecated Prefer `runEnrichmentSession` for interactive/MCP paths.
 */
export async function autoEnrich(
  projectRoot: string,
  options?: {
    limit?: number;
    dryRun?: boolean;
    layer?: string;
    nodeIds?: string[];
    log?: (msg: string) => void;
  },
): Promise<EnrichResult> {
  const log = options?.log ?? (() => {});

  // 1. Find stale nodes
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    throw new Error('No .cotx/ found. Run: cotx compile');
  }

  const staleResult = detectStale(store);
  let staleNodes = staleResult.staleEnrichments;

  // Filter by layer if requested
  if (options?.layer) {
    staleNodes = staleNodes.filter(n => n.layer === options.layer);
  }

  if (options?.nodeIds && options.nodeIds.length > 0) {
    const allowed = new Set(options.nodeIds);
    staleNodes = staleNodes.filter(n => allowed.has(n.nodeId));
  }

  // Apply limit
  if (options?.limit !== undefined && options.limit > 0) {
    staleNodes = staleNodes.slice(0, options.limit);
  }

  log(`Found ${staleNodes.length} stale node(s) to enrich`);

  const results: EnrichResult['results'] = [];

  if (options?.dryRun) {
    // Dry run: report what would be enriched without calling LLM
    for (const { nodeId, layer } of staleNodes) {
      const built = buildPrompt(store, nodeId, layer);
      const field = built?.field ?? `enriched.${layer === 'module' ? 'responsibility' : layer === 'concept' ? 'definition' : layer === 'contract' ? 'guarantees' : 'error_paths'}`;
      results.push({ node_id: nodeId, layer, field, status: 'ok' });
      log(`[dry-run] Would enrich ${layer}/${nodeId} → ${field}`);
    }
    return {
      total: staleNodes.length,
      succeeded: staleNodes.length,
      failed: 0,
      results,
    };
  }

  // 2. Load LLM config only when we actually need to call the model
  const config = readConfig();
  if (!config.llm) {
    throw new Error(
      'No LLM configuration found. Add "llm" to ~/.cotx/config.json with base_url and chat_model.',
    );
  }

  const llmConfig = config.llm;
  const concurrent = llmConfig.concurrent ?? 3;

  // 3. Create LLM client (validates API key eagerly for non-dry runs)
  let client: LlmClient;
  try {
    client = createLlmClient(llmConfig);
  } catch (err) {
    throw new Error(
      `Failed to create LLM client: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 4. Build tasks
  const tasks = staleNodes.map(({ nodeId, layer }) => async () => {
    const built = buildPrompt(store, nodeId, layer);
    if (!built) {
      const result = {
        node_id: nodeId,
        layer,
        field: 'unknown',
        status: 'error' as const,
        error: `Node not found in store`,
      };
      results.push(result);
      log(`[skip] ${layer}/${nodeId}: node not found`);
      return;
    }

    const { prompt, field } = built;
    log(`[enrich] ${layer}/${nodeId} → ${field}`);

    try {
      const response = await client.chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        { max_tokens: llmConfig.max_tokens ?? 300 },
      );

      const content = response.content.trim();
      const writeResult = await commandWrite(projectRoot, nodeId, field, content);

      if (writeResult.success) {
        results.push({ node_id: nodeId, layer, field, status: 'ok' });
        log(`[ok] ${layer}/${nodeId}`);
      } else {
        results.push({
          node_id: nodeId,
          layer,
          field,
          status: 'error',
          error: writeResult.message,
        });
        log(`[error] ${layer}/${nodeId}: ${writeResult.message}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ node_id: nodeId, layer, field, status: 'error', error });
      log(`[error] ${layer}/${nodeId}: ${error}`);
    }
  });

  // 5. Run with concurrency control
  await runInBatches(tasks, concurrent);

  const succeeded = results.filter(r => r.status === 'ok').length;
  const failed = results.filter(r => r.status === 'error').length;

  return {
    total: staleNodes.length,
    succeeded,
    failed,
    results,
  };
}

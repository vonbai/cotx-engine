/**
 * MCP Tool Definitions and Handlers
 *
 * Defines the MCP tools cotx-engine exposes to AI agents.
 * The current surface includes compile/query/context/impact plus map, write,
 * batch_write, enrich, lint, and diff.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { execSync } from 'node:child_process';
import { commandCompile } from '../commands/compile.js';
import { commandUpdate } from '../commands/update.js';
import { commandLint } from '../commands/lint.js';
import { commandWrite } from '../commands/write.js';
import { detectStale } from '../compiler/stale-detector.js';
import { generateMapSummary } from '../commands/map.js';
import { commandDiff } from '../commands/diff.js';
import { commandCypher } from '../commands/cypher.js';
import { commandDecisionQuery } from '../commands/decision-query.js';
import { CotxStore } from '../store/store.js';
import { CotxGraph } from '../query/graph-index.js';
import { readConfig } from '../config.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import { ArchitectureIndex } from '../store/architecture-index.js';
import { GraphTruthStore, type CodeNodeContextResult } from '../store-v2/graph-truth-store.js';
import { DecisionRuleIndex } from '../store-v2/decision-rule-index.js';
import { buildChangePlan } from '../compiler/change-planner.js';
import { buildChangeReview, detectAddedLinesFromGit, detectChangedFilesFromGit } from '../compiler/change-review.js';
import { collectOnboardingContext, type OnboardingBudget } from '../compiler/onboarding-context.js';
import { scanWorkspaceLayout } from '../compiler/workspace-scan.js';
import { detectFreshness, staleAnnotation, type FreshnessStatus } from '../compiler/freshness-detector.js';
import { collectProjectSourceRootInventory } from '../compiler/source-root-inventory.js';

export const AUTO_REFRESH_DRIFT_LIMIT = 500;

/**
 * If the index is stale due to HEAD change or working-tree modifications and
 * the drift is within the safe threshold, run a delta compile to refresh.
 * Returns a summary the MCP caller can surface to the agent.
 */
export async function maybeAutoRefresh(
  projectRoot: string,
  freshness: FreshnessStatus,
): Promise<{
  attempted: boolean;
  succeeded: boolean;
  trigger?: 'head-changed' | 'working-tree-dirty';
  files_updated?: number;
  duration_ms?: number;
  skip_reason?: string;
  error?: string;
}> {
  if (freshness.fresh) return { attempted: false, succeeded: false };
  if (freshness.reason !== 'head-changed' && freshness.reason !== 'working-tree-dirty') {
    return { attempted: false, succeeded: false, skip_reason: freshness.reason };
  }
  const drifted = freshness.drifted_files ?? [];
  if (drifted.length === 0) {
    return { attempted: false, succeeded: false, skip_reason: 'no-drifted-files' };
  }
  if (drifted.length > AUTO_REFRESH_DRIFT_LIMIT) {
    return {
      attempted: false,
      succeeded: false,
      skip_reason: `drift-exceeds-limit (${drifted.length} > ${AUTO_REFRESH_DRIFT_LIMIT})`,
    };
  }
  const started = Date.now();
  try {
    await commandUpdate(projectRoot, drifted, {
      silent: true,
      enrichPolicy: 'stale-if-available',
    });
    return {
      attempted: true,
      succeeded: true,
      trigger: freshness.reason,
      files_updated: drifted.length,
      duration_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      trigger: freshness.reason,
      files_updated: drifted.length,
      duration_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Tool handler ───────────────────────────────────────────────────────────

type McpContent = { type: 'text'; text: string };
type McpResult = { content: McpContent[]; isError?: boolean };

function ok(data: unknown): McpResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): McpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

interface ArchitectureRulesFile {
  forbidden_dependencies?: Array<{
    from?: string;
    to?: string;
    message?: string;
  }>;
}

/**
 * Read-class tools whose responses should be annotated with stale_against_head
 * when the index lags behind the current working tree. prepare_task handles its
 * own freshness so it's excluded.
 */
const STALE_ANNOTATED_TOOLS = new Set([
  'cotx_query',
  'cotx_context',
  'cotx_impact',
  'cotx_map',
  'cotx_doctrine',
  'cotx_cypher',
  'cotx_decision_query',
  'cotx_canonical_paths',
  'cotx_route_map',
  'cotx_shape_check',
  'cotx_api_impact',
  'cotx_tool_map',
  'cotx_detect_changes',
  'cotx_plan_change',
  'cotx_review_change',
  'cotx_enrichment_status',
]);

/**
 * Merge staleness annotation into a read-tool response without disturbing the
 * original payload. Silently no-ops on errors, non-object payloads, or fresh
 * indexes so the worst case is "no annotation added".
 */
function annotateWithStaleness(projectRoot: string, result: McpResult): McpResult {
  if (result.isError) return result;
  if (!projectRoot) return result;
  try {
    const freshness = detectFreshness(projectRoot);
    const stale = staleAnnotation(freshness);
    if (!stale) return result;
    const text = result.content[0]?.text;
    if (!text) return result;
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    const merged = { ...parsed, ...stale };
    return { content: [{ type: 'text', text: JSON.stringify(merged) }] };
  } catch {
    return result;
  }
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<McpResult> {
  try {
    const result = await handleToolCallInner(name, args);
    if (STALE_ANNOTATED_TOOLS.has(name)) {
      const projectRoot = args.project_root as string;
      return annotateWithStaleness(projectRoot, result);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cotx handleToolCall error (${name}): ${message}\n`);
    return err(message);
  }
}

async function handleToolCallInner(
  name: string,
  args: Record<string, unknown>,
): Promise<McpResult> {
  switch (name) {
    case 'cotx_compile': {
      const projectRoot = args.project_root as string;
      const mode = (args.mode as string | undefined) ?? 'full';
      if (mode === 'delta') {
        const incrementalPolicy = parseIncrementalEnrichPolicy(args.enrich_policy);
        if (!incrementalPolicy) return err('Invalid enrich_policy for delta mode. Use: never, affected-if-available, stale-if-available, or force-affected.');
        const files = args.files as string[] | undefined;
        const result = await commandUpdate(projectRoot, files, { silent: true, enrichPolicy: incrementalPolicy });
        return ok({ status: 'updated', ...result });
      } else {
        const enrichPolicy = parseCompileEnrichPolicy(args.enrich_policy);
        if (!enrichPolicy) return err('Invalid enrich_policy. Use: never, bootstrap-if-available, or force-bootstrap.');
        const seedFrom = args.seed_from as string | undefined;
        const forceFull = Boolean(args.force_full);
        await commandCompile(projectRoot, { silent: true, enrichPolicy, seedFrom, forceFull });
        const store = new CotxStore(projectRoot);
        const meta = store.readMeta();
        const staleResult = detectStale(store);
        const staleCount = staleResult.summary.enrichments;
        return ok({
          status: 'compiled',
          compiled_at: meta.compiled_at,
          stats: meta.stats,
          bootstrap_enrichment: meta.bootstrap_enrichment ?? null,
          stale_enrichments: staleCount,
          hint: staleCount > 0
            ? `${staleCount} enrichments stale. Call cotx_query with filter="stale" to get enrichment tasks.`
            : undefined,
        });
      }
    }

    case 'cotx_query': {
      const projectRoot = args.project_root as string;
      const store = new CotxStore(projectRoot);
      if (!store.exists()) {
        return err('No .cotx/ found. Run cotx_compile first.');
      }

      const filter = args.filter as string | undefined;

      // Stale filter: delegate to enrich logic (absorbed from cotx_enrich)
      if (filter === 'stale') {
        const layer = (args.layer as string | undefined) ?? 'module';
        const limit = (args.limit as number | undefined) ?? 10;

        // auto_enrich short-circuit: route through the agentic session so
        // the on-demand path shares the same batching / async write queue /
        // parallel tool-call behaviour as the bootstrap path. The old
        // serial enricher is kept for the CLI (`cotx enrich --auto`) but
        // MCP callers should not hit it — Gemini's per-node sequential
        // emit made 50-node on-demand refreshes take 5-10 minutes.
        if (args.auto_enrich === true) {
          const { readExistingConfig } = await import('../config.js');
          const config = readExistingConfig();
          if (!config?.llm?.chat_model) {
            return err('auto_enrich=true requires an LLM (set llm.chat_model in ~/.cotx/config.json).');
          }
          const {
            runEnrichmentSession,
            detectMissingStructuralNodes,
            enrichMissingNodesWithContext,
            buildEnrichmentContext,
          } = await import('../llm/agentic-enrichment-session.js');

          // Two ways to scope the on-demand call:
          //  1. nodeIds: explicit list of node ids — enriches exactly those.
          //  2. (no nodeIds) — treats the layer as a whole, filters missing
          //     nodes, caps at `limit`.
          const requestedIds = Array.isArray(args.nodeIds)
            ? (args.nodeIds as unknown[]).filter((x): x is string => typeof x === 'string')
            : null;
          const allMissing = detectMissingStructuralNodes(projectRoot);
          let scoped = layer === 'all'
            ? allMissing
            : allMissing.filter((n) => n.layer === layer);
          if (requestedIds && requestedIds.length > 0) {
            const want = new Set(requestedIds);
            scoped = scoped.filter((n) => want.has(n.node_id));
          }
          scoped = scoped.slice(0, limit);

          if (scoped.length === 0) {
            return ok({
              total: 0,
              succeeded: 0,
              failed: 0,
              results: [],
              hint: requestedIds && requestedIds.length > 0
                ? `None of the provided nodeIds are stale in layer ${layer}.`
                : `No stale ${layer === 'all' ? 'nodes' : `${layer} nodes`} found.`,
            });
          }

          const ctx = buildEnrichmentContext(projectRoot);
          // Echo agent reasoning + tool calls to stderr so prompt engineers
          // can inspect traces from MCP-invoked runs. stdout stays JSON-only.
          const session = await runEnrichmentSession({
            projectRoot,
            label: `on-demand:${layer}${requestedIds ? ':byIds' : ''}`,
            skeleton: {
              missing_nodes: enrichMissingNodesWithContext(scoped, ctx),
            },
            llm: config.llm,
            budgetCap: Math.min(300, scoped.length + 20),
            log: (msg: string) => console.error(msg),
          });
          return ok({
            total: scoped.length,
            succeeded: session.total_written,
            failed: scoped.length - session.total_written,
            results: session.written_sample,
            skipped: session.skipped,
            duration_ms: session.duration_ms,
            model: session.model,
          });
        }

        const tasks: Array<{
          node_id: string;
          layer: string;
          field: string;
          context: Record<string, unknown>;
          instruction: string;
        }> = [];

        // Bulk-read all layers once; the prior implementation walked each
        // layer twice (listX + per-node readX) inside the stale-task builder,
        // roughly 4N LBug opens on large repos. One bulk read caps it at 4.
        const { modules: allModules, concepts: allConcepts, contracts: allContracts, flows: allFlows } = store.loadAllSemanticArtifacts();

        if (layer === 'module' || layer === 'all') {
          // Build module → exported function names from contracts where the module is provider
          const providerExports = new Map<string, string[]>();
          for (const contract of allContracts) {
            const existing = providerExports.get(contract.provider) ?? [];
            existing.push(...contract.interface.slice(0, 5));
            providerExports.set(contract.provider, existing);
          }

          const graph = CotxGraph.fromStoreCached(store);
          const moduleExports = new Map<string, string[]>();
          for (const node of graph.allNodes('module')) {
            moduleExports.set(node.id, [...new Set(providerExports.get(node.id) ?? [])].slice(0, 15));
          }

          // Build dep descriptions for richer context
          const depDescriptions = new Map<string, string>();
          for (const mod of allModules) {
            const resp = mod.enriched?.responsibility ?? (mod.enriched as Record<string, unknown> | undefined)?.auto_description as string | undefined;
            if (resp) depDescriptions.set(mod.id, resp);
          }

          for (const mod of allModules) {
            if (tasks.length >= limit) break;
            if (mod.enriched?.responsibility && mod.enriched.source_hash === mod.struct_hash) continue;

            const depCtx = mod.depends_on.slice(0, 5).map((d) => {
              const desc = depDescriptions.get(d);
              return desc ? `${d} (${desc})` : d;
            });

            tasks.push({
              node_id: mod.id,
              layer: 'module',
              field: 'enriched.responsibility',
              context: {
                files_count: mod.files.length,
                files_sample: mod.files.slice(0, 8),
                canonical_entry: mod.canonical_entry,
                exported_api: moduleExports.get(mod.id) ?? [],
                depends_on_with_desc: depCtx,
                depended_by: mod.depended_by.slice(0, 5),
                auto_description: (mod.enriched as Record<string, unknown> | undefined)?.auto_description ?? null,
              },
              instruction: 'Write a one-sentence description of this module\'s responsibility. You have: file names, entry point, exported API functions, and dependency descriptions. Write a human-quality sentence, not a keyword list. Use cotx_write with field "enriched.responsibility".',
            });
          }
        }

        if (layer === 'concept' || layer === 'all') {
          for (const concept of allConcepts) {
            if (tasks.length >= limit) break;
            if (concept.enriched?.definition && concept.enriched.source_hash === concept.struct_hash) continue;
            tasks.push({
              node_id: concept.id,
              layer: 'concept',
              field: 'enriched.definition',
              context: {
                aliases: concept.aliases,
                appears_in_count: concept.appears_in.length,
                appears_in_sample: concept.appears_in.slice(0, 5),
                home_module: concept.layer,
              },
              instruction: 'Write a one-sentence definition of this domain concept. Use cotx_write with field "enriched.definition".',
            });
          }
        }

        if (layer === 'contract' || layer === 'all') {
          for (const contract of allContracts) {
            if (tasks.length >= limit) break;
            if (contract.enriched?.guarantees && contract.enriched.source_hash === contract.struct_hash) continue;
            tasks.push({
              node_id: contract.id,
              layer: 'contract',
              field: 'enriched.guarantees',
              context: {
                provider: contract.provider,
                consumer: contract.consumer,
                interface_sample: contract.interface.slice(0, 10),
              },
              instruction: 'Describe what this contract guarantees: what the consumer can rely on from the provider. Use cotx_write with field "enriched.guarantees" and a JSON array of strings.',
            });
          }
        }

        if (layer === 'flow' || layer === 'all') {
          for (const flow of allFlows) {
            if (tasks.length >= limit) break;
            if (flow.enriched?.error_paths && flow.enriched.source_hash === flow.struct_hash) continue;
            if (flow.type !== 'flow' || !flow.steps || flow.steps.length === 0) continue;
            tasks.push({
              node_id: flow.id,
              layer: 'flow',
              field: 'enriched.error_paths',
              context: {
                trigger: flow.trigger,
                steps_count: flow.steps.length,
                steps_sample: flow.steps.slice(0, 5).map((s) => `${s.module}.${s.function}`),
              },
              instruction: 'Describe what happens when steps in this flow fail. Use cotx_write with field "enriched.error_paths" and a JSON array of {condition, behavior} objects.',
            });
          }
        }

        const config = readConfig();
        const autoEnrichAvailable = Boolean(config.llm?.chat_model);

        return ok({
          tasks,
          total: tasks.length,
          auto_enrich_available: autoEnrichAvailable,
          ...(autoEnrichAvailable ? { auto_enrich_hint: 'LLM is configured. Call cotx_query with auto_enrich=true to let cotx-engine enrich automatically.' } : {}),
          hint: 'For each task, generate a one-sentence description from the context, then call cotx_write with a writes array to save all results.',
          delegation: tasks.length > 5
            ? 'These are independent, simple text generation tasks (~300 tokens each). If you have sub-agent capability, delegate to a lightweight model (e.g. haiku) for cost efficiency.'
            : undefined,
        });
      }

      // Architecture layer dispatch
      const queryLayer = args.layer as string | undefined;
      if (queryLayer === 'architecture') {
        const archStore = new ArchitectureStore(projectRoot);
        if (!archStore.exists()) return ok({ results: [], count: 0, hint: 'No architecture data. Run cotx compile.' });
        const archIndex = ArchitectureIndex.fromStore(archStore);
        const archKeyword = args.query as string;
        if (!archKeyword) return err('Missing query for architecture search.');
        const archLimit = (args.limit as number | undefined) ?? 15;
        const results = archIndex.search(archKeyword, archLimit);
        return ok({ query: archKeyword, layer: 'architecture', count: results.length, results });
      }

      const keyword = args.query as string;
      const layer = args.layer as string | undefined;
      const mode = (args.mode as string | undefined) ?? 'keyword';
      const focusNode = args.focus_node as string | undefined;
      const limit = (args.limit as number | undefined) ?? 15;

      if (mode === 'semantic') {
        const { semanticSearch } = await import('../llm/embeddings.js');
        try {
          const results = await semanticSearch(projectRoot, keyword, limit, { layer });
          return ok({ query: keyword, mode: 'semantic', count: results.length, results });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return err(`Semantic search failed: ${msg}. Run 'cotx embed' to build the index.`);
        }
      }

      if (mode === 'focus') {
        const results = await v2CodeSearch(projectRoot, keyword ?? focusNode, layer, limit);
        return ok({ query: keyword ?? null, mode: 'focus', focus_node: focusNode ?? null, count: results.length, results, note: 'focus mode now uses typed graph search; PageRank over semantic artifacts was removed to avoid fallback behavior.' });
      }

      // Default: keyword mode runs BOTH BM25 over semantic artifacts
      // (modules / concepts / contracts / flows) AND v2 typed-graph search
      // over code symbols (functions / classes / etc). Previously this
      // only called v2CodeSearch, so natural-language queries against the
      // semantic layer returned 0 even when the layer contained matches.
      const graph = CotxGraph.fromStoreCached(store);
      const bm25Hits = graph.searchWithScores(keyword ?? '', layer)
        .slice(0, limit)
        .map((n) => ({ id: n.id, layer: n.layer, score: n.score, source: 'bm25_semantic' as const }));
      const codeHits = (await v2CodeSearch(projectRoot, keyword, layer, limit))
        .map((c: any) => ({ ...c, source: 'typed_graph' as const }));
      // Merge by score when available; semantic BM25 hits first (domain
      // nodes usually rank ahead of raw code-symbol matches for NL queries),
      // then code symbols, capped at limit.
      const results = [...bm25Hits, ...codeHits].slice(0, limit);
      return ok({ query: keyword, layer: layer ?? null, count: results.length, results });
    }

    case 'cotx_context': {
      const projectRoot = args.project_root as string;
      const nodeId = args.node_id as string;
      const store = new CotxStore(projectRoot);
      if (!store.exists()) {
        return err('No .cotx/ found. Run cotx_compile first.');
      }

      // Architecture dispatch
      if (nodeId.startsWith('architecture/')) {
        const archStore = new ArchitectureStore(projectRoot);
        if (!archStore.exists()) return err('No architecture data. Run cotx compile.');
        const archPath = nodeId.slice('architecture/'.length);
        const parts = archPath.split('/');
        if (parts.length === 1) {
          const data = archStore.readPerspective(parts[0]);
          const description = archStore.readDescription(parts[0]);
          const diagram = archStore.readDiagram(parts[0]);
          return ok({
            id: nodeId,
            layer: 'architecture',
            data: { ...data, description, diagram },
            children: archStore.listChildren(parts[0]),
          });
        } else {
          const elementPath = parts.slice(1).join('/');
          const fullPath = `${parts[0]}/${elementPath}`;
          let data;
          try {
            data = archStore.readElement(parts[0], elementPath);
          } catch {
            const perspective = archStore.readPerspective(parts[0]);
            const fallbackId = elementPath.split('/').pop() ?? elementPath;
            data = perspective.components.find((component) => component.id === fallbackId);
            if (!data) {
              return err(`Architecture node "${nodeId}" not found. If recently added, run cotx_compile mode=delta files=[...] or cotx_prepare_task to refresh.`);
            }
          }
          return ok({
            id: nodeId,
            layer: 'architecture',
            data: {
              ...data,
              description: archStore.readDescription(fullPath),
              diagram: archStore.readDiagram(fullPath),
            },
            children: archStore.listChildren(fullPath),
          });
        }
      }

      const typedContext = await v2CodeNodeContext(projectRoot, nodeId);
      if (!typedContext) return err(`Code node "${nodeId}" not found in storage-v2 typed graph. If recently added, run cotx_compile mode=delta files=[...] or cotx_prepare_task to refresh.`);
      return ok(typedContext);
    }

    case 'cotx_impact': {
      const projectRoot = args.project_root as string;
      const target = args.target as string;
      const direction = args.direction as string | undefined;
      const store = new CotxStore(projectRoot);
      if (!store.exists()) {
        return err('No .cotx/ found. Run cotx_compile first.');
      }
      const typedImpact = await v2CodeNodeImpact(projectRoot, target, direction === 'downstream' ? 'downstream' : 'upstream');
      if (!typedImpact) return err(`Code node "${target}" not found in storage-v2 typed graph. If recently added, run cotx_compile mode=delta files=[...] or cotx_prepare_task to refresh.`);
      return ok(typedImpact);
    }

    case 'cotx_batch_write':
      return err('cotx_batch_write has been merged into cotx_write. Pass writes as an array.');

    case 'cotx_write': {
      const projectRoot = args.project_root as string;

      // Architecture write dispatch (single write mode with architecture/ prefix)
      const singleNodeId = args.node_id as string | undefined;
      if (singleNodeId?.startsWith('architecture/') && !Array.isArray(args.writes)) {
        const archStore = new ArchitectureStore(projectRoot);
        if (!archStore.exists()) return err('No architecture data. Run cotx compile.');
        const archPath = singleNodeId.slice('architecture/'.length);
        const field = args.field as string;
        const content = args.content as string;
        archStore.writeField(archPath, field, content);
        return ok({ success: true, status: 'written', node_id: singleNodeId, field });
      }

      const writes = args.writes as Array<{ node_id: string; field: string; content: string }> | undefined;

      // Batch mode: writes array provided
      if (Array.isArray(writes)) {
        if (writes.length === 0) {
          return err('writes must be a non-empty array of {node_id, field, content}');
        }
        const results: Array<{ node_id: string; success: boolean; message: string }> = [];
        for (const w of writes) {
          if (w.node_id.startsWith('architecture/')) {
            const archStore = new ArchitectureStore(projectRoot);
            if (!archStore.exists()) {
              results.push({
                node_id: w.node_id,
                success: false,
                message: 'No architecture data. Run cotx compile.',
              });
              continue;
            }
            try {
              const archPath = w.node_id.slice('architecture/'.length);
              archStore.writeField(archPath, w.field, w.content);
              results.push({ node_id: w.node_id, success: true, message: `Updated ${w.node_id} ${w.field}` });
            } catch (error) {
              results.push({
                node_id: w.node_id,
                success: false,
                message: error instanceof Error ? error.message : String(error),
              });
            }
            continue;
          }

          const r = await commandWrite(projectRoot, w.node_id, w.field, w.content, { author: 'agent' });
          results.push({ node_id: w.node_id, ...r });
        }
        const succeeded = results.filter((r) => r.success).length;
        return ok({ total: writes.length, succeeded, failed: writes.length - succeeded, results });
      }

      // Single write mode
      const result = await commandWrite(
        projectRoot,
        args.node_id as string,
        args.field as string,
        args.content as string,
        { author: 'agent' },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'cotx_map': {
      const projectRoot = args.project_root as string;
      const store = new CotxStore(projectRoot);
      if (!store.exists()) {
        return err('No .cotx/ found. Run cotx_compile first.');
      }
      const scope = (args.scope as string | undefined) ?? 'overview';

      if (scope === 'architecture') {
        const archStore = new ArchitectureStore(projectRoot);
        if (!archStore.exists()) return ok({ hint: 'No architecture data. Run cotx compile.' });
        const meta = archStore.readMeta();
        const perspectives = meta.perspectives.map((id) => {
          try {
            const data = archStore.readPerspective(id);
            return { id, label: data.label, components_count: data.components.length, edges_count: data.edges.length };
          } catch {
            return { id, label: id, components_count: 0, edges_count: 0 };
          }
        });
        return ok({ perspectives, generated_at: meta.generated_at, mode: meta.mode });
      }

      const depth = (args.depth as number | undefined) ?? 2;
      const markdown = generateMapSummary(store, scope, depth);
      return ok(markdown);
    }

    case 'cotx_lint': {
      const projectRoot = args.project_root as string;
      const strict = (args.strict as boolean | undefined) ?? false;
      const rules = (args.rules as string[] | undefined) ?? ['consistency'];
      const preflightStore = new CotxStore(projectRoot);
      if (!preflightStore.exists()) {
        return err('No .cotx/ found. Run cotx_compile first.');
      }
      const requestedRules = new Set(rules);
      const issues = requestedRules.has('consistency')
        ? await commandLint(projectRoot, { json: false, strict, silent: true })
        : [];

      // Additional rule: dead_code (module-level heuristic, not symbol-precise analysis)
      if (requestedRules.has('dead_code')) {
        const store = new CotxStore(projectRoot);
        if (store.exists()) {
          const { modules, flows } = store.loadAllSemanticArtifacts();
          const flowTouchedModules = new Set<string>();
          for (const flow of flows) for (const step of flow.steps ?? []) flowTouchedModules.add(step.module);
          for (const mod of modules) {
            if (mod.id === '_root') continue;
            if ((mod.depended_by?.length ?? 0) === 0 && (mod.files?.length ?? 0) > 0 && !flowTouchedModules.has(mod.id)) {
              issues.push({
                level: 'INFO',
                type: 'DEAD_CODE_CANDIDATE',
                node_id: mod.id,
                layer: 'module',
                message: `Module "${mod.id}" has no dependents and does not appear in any flow (potential unused module)`,
              });
            }
          }
        }
      }

      if (requestedRules.has('architecture')) {
        const store = new CotxStore(projectRoot);
        const rulesPath = path.join(projectRoot, '.cotx', 'rules.yaml');
        if (store.exists() && fs.existsSync(rulesPath)) {
          let parsed: ArchitectureRulesFile | null = null;
          try {
            parsed = yaml.load(fs.readFileSync(rulesPath, 'utf-8')) as ArchitectureRulesFile;
          } catch {
            issues.push({
              level: 'ERROR',
              type: 'ARCHITECTURE_RULES_INVALID',
              node_id: '_rules',
              layer: 'module',
              message: 'Failed to parse .cotx/rules.yaml',
            });
          }

          const archModules = store.loadAllSemanticArtifacts().modules;
          const archModulesById = new Map(archModules.map((m) => [m.id, m]));
          for (const rule of parsed?.forbidden_dependencies ?? []) {
            if (!rule.from || !rule.to) continue;
            const mod = archModulesById.get(rule.from);
            if (!mod) continue;
            if ((mod.depends_on ?? []).includes(rule.to)) {
              issues.push({
                level: 'ERROR',
                type: 'ARCHITECTURE_VIOLATION',
                node_id: rule.from,
                layer: 'module',
                message: rule.message ?? `Module "${rule.from}" must not depend on "${rule.to}"`,
              });
            }
          }
        }
      }

      return ok({ issues, count: issues.length, rules });
    }

    case 'cotx_enrich':
      return err('cotx_enrich has been merged into cotx_query. Use filter: "stale".');

    case 'cotx_diff': {
      const result = await commandDiff(args.project_root as string, {
        snapshot: args.snapshot as string | undefined,
        silent: true,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'cotx_doctrine': {
      const store = new CotxStore(args.project_root as string);
      if (!store.exists()) return err('No .cotx/ found. Run cotx_compile first.');
      const doctrine = store.readDoctrine();
      if (!doctrine) return err('No doctrine data. Run cotx_compile first.');
      return ok(doctrine);
    }

    case 'cotx_cypher': {
      const projectRoot = args.project_root as string;
      const query = args.query as string;
      if (!query) return err('Missing query');
      try {
        return ok(await commandCypher(projectRoot, query));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    }

    case 'cotx_decision_query': {
      const projectRoot = args.project_root as string;
      const kind = args.kind as 'canonical' | 'closure';
      const target = args.target as string;
      if (kind !== 'canonical' && kind !== 'closure') return err('kind must be: canonical or closure');
      if (!target) return err('Missing target');
      try {
        return ok(await commandDecisionQuery(projectRoot, kind, target));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    }

    case 'cotx_canonical_paths': {
      const store = new CotxStore(args.project_root as string);
      if (!store.exists()) return err('No .cotx/ found. Run cotx_compile first.');
      const v2 = await v2CanonicalPaths(args.project_root as string);
      if (v2) return ok(v2);
      return err('No storage-v2 canonical path rule index data. Run cotx_compile first.');
    }

    case 'cotx_route_map': {
      const projectRoot = args.project_root as string;
      try {
        return ok(await v2RouteMap(projectRoot, args.route as string | undefined));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    }

    case 'cotx_shape_check': {
      const projectRoot = args.project_root as string;
      try {
        return ok(await v2ShapeCheck(projectRoot, args.route as string | undefined));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    }

    case 'cotx_api_impact': {
      const projectRoot = args.project_root as string;
      try {
        return ok(await v2ApiImpact(projectRoot, {
          route: args.route as string | undefined,
          file: args.file as string | undefined,
        }));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    }

    case 'cotx_tool_map': {
      const projectRoot = args.project_root as string;
      try {
        return ok(await v2ToolMap(projectRoot, args.tool as string | undefined));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    }

    case 'cotx_detect_changes': {
      const projectRoot = args.project_root as string;
      try {
        return ok(await v2DetectChanges(projectRoot, {
          scope: args.scope as string | undefined,
          baseRef: args.base_ref as string | undefined,
        }));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    }

    case 'cotx_plan_change': {
      const store = new CotxStore(args.project_root as string);
      if (!store.exists()) return err('No .cotx/ found. Run cotx_compile first.');
      const plan = buildChangePlan(
        args.project_root as string,
        store,
        args.target as string,
        args.intent as string | undefined,
      );
      store.writeLatestPlan(plan);
      store.appendPlan(plan);
      return ok(plan);
    }

    case 'cotx_review_change': {
      const projectRoot = args.project_root as string;
      const store = new CotxStore(projectRoot);
      if (!store.exists()) return err('No .cotx/ found. Run cotx_compile first.');
      const files = (args.files as string[] | undefined) ?? detectChangedFilesFromGit(projectRoot);
      const review = buildChangeReview(projectRoot, store, {
        changedFiles: files,
        addedLines: detectAddedLinesFromGit(projectRoot, files),
      });
      store.writeLatestReview(review);
      store.appendReview(review);
      return ok(review);
    }

    case 'cotx_onboarding_context': {
      const projectRoot = args.project_root as string;
      if (!projectRoot || !fs.existsSync(projectRoot)) return err('Project root does not exist.');
      const budget = parseOnboardingBudget(args.budget);
      if (!budget) return err('Invalid budget. Use: tiny, standard, or deep.');
      const context = collectOnboardingContext(projectRoot, { budget });
      return ok(context);
    }

    case 'cotx_minimal_context': {
      const projectRoot = args.project_root as string;
      if (!projectRoot || !fs.existsSync(projectRoot)) return err('Project root does not exist.');
      const budget = parseOnboardingBudget(args.budget);
      if (!budget) return err('Invalid budget. Use: tiny, standard, or deep.');
      const context = await buildMinimalContext(projectRoot, {
        task: args.task as string | undefined,
        focus: args.focus as string | undefined,
        changedFiles: args.changed_files as string[] | undefined,
        budget,
      });
      return ok(context);
    }

    case 'cotx_prepare_task': {
      const projectRoot = args.project_root as string;
      if (!projectRoot || !fs.existsSync(projectRoot)) return err('Project root does not exist.');
      const budget = parseOnboardingBudget(args.budget);
      if (!budget) return err('Invalid budget. Use: tiny, standard, or deep.');
      const context = await buildPrepareTask(projectRoot, {
        task: args.task as string | undefined,
        focus: args.focus as string | undefined,
        changedFiles: args.changed_files as string[] | undefined,
        budget,
      });
      return ok(context);
    }

    case 'cotx_enrichment_status': {
      const projectRoot = args.project_root as string;
      if (!projectRoot || !fs.existsSync(projectRoot)) return err('Project root does not exist.');
      const store = new CotxStore(projectRoot);
      if (!store.exists()) {
        return ok({ status: 'no-map', message: 'Run cotx_compile first.' });
      }
      // Check for a background-worker status file (Phase C detach).
      let bgStatus: unknown = null;
      try {
        const bgRaw = fs.readFileSync(path.join(projectRoot, '.cotx', 'enrichment-status.json'), 'utf-8');
        const parsed = JSON.parse(bgRaw);
        // Probe if pid is alive
        let pidAlive = false;
        if (typeof parsed.pid === 'number') {
          try {
            process.kill(parsed.pid, 0);
            pidAlive = true;
          } catch {
            pidAlive = false;
          }
        }
        bgStatus = { ...parsed, pid_alive: pidAlive };
      } catch {
        // no background worker active
      }
      const staleResult = detectStale(store);
      const staleCount = staleResult.summary.enrichments;

      // Count nodes with enriched content per layer — one bulk read,
      // not N+1 per-node. (Previously this alone drove cotx_enrichment_status
      // to tens of seconds on large repos under any write-lock contention.)
      let modulesEnriched = 0, conceptsEnriched = 0, contractsEnriched = 0, flowsEnriched = 0;
      let modulesTotal = 0, conceptsTotal = 0, contractsTotal = 0, flowsTotal = 0;
      let bulk: ReturnType<CotxStore['loadAllSemanticArtifacts']> | null = null;
      try {
        bulk = store.loadAllSemanticArtifacts();
        for (const m of bulk.modules) { modulesTotal++; if ((m.enriched as { responsibility?: string } | undefined)?.responsibility) modulesEnriched++; }
        for (const c of bulk.concepts) { conceptsTotal++; if ((c.enriched as { definition?: string } | undefined)?.definition) conceptsEnriched++; }
        for (const c of bulk.contracts) { contractsTotal++; if ((c.enriched as { guarantees?: string } | undefined)?.guarantees) contractsEnriched++; }
        for (const f of bulk.flows) { flowsTotal++; if ((f.enriched as { error_paths?: unknown } | undefined)?.error_paths) flowsEnriched++; }
      } catch (err) {
        // partial data OK
      }

      const total = modulesTotal + conceptsTotal + contractsTotal + flowsTotal;
      const enriched = modulesEnriched + conceptsEnriched + contractsEnriched + flowsEnriched;
      const coverage = total > 0 ? enriched / total : 1;
      const overallStatus = staleCount > 0
        ? 'stale'
        : coverage >= 0.95 ? 'complete' : coverage > 0 ? 'partial' : 'empty';

      const embeddingsPath = path.join(projectRoot, '.cotx', 'embeddings.json');
      const embeddingsBuilt = fs.existsSync(embeddingsPath);
      let embeddingsStatus: Record<string, unknown> = { built: embeddingsBuilt };
      if (embeddingsBuilt) {
        try {
          const raw = fs.readFileSync(embeddingsPath, 'utf-8');
          const idx = JSON.parse(raw) as { built_at?: string; entries?: Array<{ layer: string; id: string }> };
          const indexed = new Set((idx.entries ?? []).map((e) => `${e.layer}\0${e.id}`));
          let missing = 0;
          if (bulk) {
            for (const m of bulk.modules) if (!indexed.has(`module\0${m.id}`)) missing++;
            for (const c of bulk.concepts) if (!indexed.has(`concept\0${c.id}`)) missing++;
            for (const c of bulk.contracts) if (!indexed.has(`contract\0${c.id}`)) missing++;
            for (const f of bulk.flows) if (!indexed.has(`flow\0${f.id}`)) missing++;
          }
          const liveCount = modulesTotal + conceptsTotal + contractsTotal + flowsTotal;
          const orphan = (idx.entries ?? []).length - (liveCount - missing);
          embeddingsStatus = {
            built: true,
            built_at: idx.built_at ?? null,
            indexed_nodes: (idx.entries ?? []).length,
            missing_from_index: missing,
            orphan_in_index: Math.max(0, orphan),
            stale: missing > 0 || orphan > 0,
            hint: missing > 0 || orphan > 0
              ? `Embedding index is stale: ${missing} live nodes missing, ${orphan} orphan entries. Re-run \`cotx embed\` to refresh (semantic search will include outdated / missing results until then).`
              : undefined,
          };
        } catch {
          embeddingsStatus = { built: true, stale: true, hint: 'Embedding index unreadable. Run `cotx embed` to rebuild.' };
        }
      } else {
        embeddingsStatus = {
          built: false,
          hint: 'No semantic embedding index built. Natural-language queries via cotx_query mode=semantic are unavailable — they will fall back to BM25 + typed-graph search. Run `cotx embed` to enable semantic search (one-time cost, ~2-5 min depending on node count).',
        };
      }

      return ok({
        status: overallStatus,
        coverage_ratio: Number(coverage.toFixed(3)),
        enriched, total, stale: staleCount,
        per_layer: {
          modules: { enriched: modulesEnriched, total: modulesTotal },
          concepts: { enriched: conceptsEnriched, total: conceptsTotal },
          contracts: { enriched: contractsEnriched, total: contractsTotal },
          flows: { enriched: flowsEnriched, total: flowsTotal },
        },
        background: bgStatus,
        embeddings: embeddingsStatus,
        hint: (bgStatus as { status?: string } | null)?.status === 'running'
          ? `Background enrichment worker is still populating enriched.* fields (pid=${(bgStatus as { pid?: number }).pid}, ${(bgStatus as { done?: number }).done}/${(bgStatus as { total?: number }).total}). Read-tools can still return useful results using auto_description and structural context — don't block.`
          : staleCount > 0
            ? `${staleCount} enrichments are stale (code changed). Run cotx_compile --enrich-policy=bootstrap-if-available to refresh.`
            : coverage < 0.95
              ? `Coverage ${Math.round(coverage * 100)}%. Missing enrichments fall back to auto_description; run cotx_compile to fill gaps.`
              : 'Enrichment is complete and fresh.',
      });
    }

    case 'cotx_source_roots': {
      const projectRoot = args.project_root as string;
      if (!projectRoot || !fs.existsSync(projectRoot)) return err('Project root does not exist.');
      const budget = parseOnboardingBudget(args.budget);
      if (!budget) return err('Invalid budget. Use: tiny, standard, or deep.');

      const workspaceLayout = scanWorkspaceLayout(projectRoot);
      const inventory = await collectProjectSourceRootInventory(projectRoot, { workspaceLayout });
      const assist = args.assist === true;

      if (!assist) {
        return ok({
          project_root: projectRoot,
          inventory,
          assistant: {
            requested: false,
            available: false,
          },
        });
      }

      const { readExistingConfig } = await import('../config.js');
      const config = readExistingConfig();
      if (!config?.llm?.chat_model) {
        return ok({
          project_root: projectRoot,
          inventory,
          assistant: {
            requested: true,
            available: false,
            reason: 'No built-in LLM configured. Set llm.chat_model in ~/.cotx/config.json.',
          },
        });
      }

      const onboarding = collectOnboardingContext(projectRoot, { budget });
      const { runSourceRootDiscoveryAdvisor } = await import('../llm/source-root-advisor.js');
      const advisor = await runSourceRootDiscoveryAdvisor({
        projectRoot,
        inventory,
        onboarding,
        llm: config.llm,
      });
      return ok({
        project_root: projectRoot,
        inventory,
        assistant: {
          requested: true,
          available: true,
          parsed: advisor.parsed,
          raw_output: advisor.raw_output,
          tool_calls: advisor.tool_calls,
          truth_correction_proposals: advisor.truth_correction_proposals,
          truth_correction_events: advisor.truth_correction_events,
          model: advisor.model,
        },
      });
    }

    default:
      return ok({ status: 'not_implemented', tool: name });
  }
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        default?: unknown;
        items?: {
          type: string;
          properties?: Record<string, { type: string }>;
          required?: string[];
          enum?: string[];
        };
        enum?: string[];
        minimum?: number;
        maximum?: number;
      }
    >;
    required: string[];
  };
}

async function v2CodeNodeContext(projectRoot: string, nodeId: string): Promise<unknown | null> {
  const dbPath = path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
  if (!fs.existsSync(dbPath)) return null;
  const store = new GraphTruthStore({ dbPath, readOnly: true });
  try {
    await store.open();
    const typed = await store.codeNodeContext(nodeId);
    return typed ? formatCodeNodeContext(typed) : null;
  } catch (error) {
    if (String(error).includes('Table CodeNode does not exist')) return null;
    throw error;
  } finally {
    await store.close();
  }
}

async function v2CodeNodeImpact(projectRoot: string, nodeId: string, direction: 'upstream' | 'downstream'): Promise<unknown | null> {
  const dbPath = path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
  if (!fs.existsSync(dbPath)) return null;
  const store = new GraphTruthStore({ dbPath, readOnly: true });
  try {
    await store.open();
    const typed = await store.codeNodeContext(nodeId);
    if (typed) {
      const impacted = await store.codeImpact(nodeId, direction, 3, ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES', 'HANDLES_ROUTE', 'FETCHES', 'HANDLES_TOOL', 'STEP_IN_PROCESS']);
      return {
        target: { id: nodeId, layer: typed.label },
        direction,
        depths: {
          d1: {
            label: impacted.length === 0 ? 'NO DIRECT IMPACT' : 'AFFECTED CODE NODES',
            nodes: impacted,
            total: impacted.length,
          },
        },
        summary: {
          total_affected: impacted.length,
          risk: impacted.length === 0 ? 'LOW' : impacted.length <= 9 ? 'MEDIUM' : 'HIGH',
          affected_nodes: impacted,
        },
      };
    }
    return null;
  } catch (error) {
    if (String(error).includes('Table CodeNode does not exist')) return null;
    throw error;
  } finally {
    await store.close();
  }
}

function formatCodeNodeContext(typed: CodeNodeContextResult): unknown {
  const outgoing = typed.outgoing.map((item) => ({
    to: item.to,
    layer: item.label,
    relation: item.type,
    name: item.name,
    filePath: item.filePath,
    confidence: item.confidence,
    reason: item.reason,
    step: item.step,
  }));
  const incoming = typed.incoming.map((item) => ({
    from: item.from,
    layer: item.label,
    relation: item.type,
    name: item.name,
    filePath: item.filePath,
    confidence: item.confidence,
    reason: item.reason,
    step: item.step,
  }));
  return {
    status: 'found',
    id: typed.id,
    layer: typed.label,
    symbol: {
      uid: typed.id,
      name: typed.name,
      kind: typed.label,
      filePath: typed.filePath,
      startLine: typed.startLine,
      endLine: typed.endLine,
      isExported: typed.isExported,
      properties: typed.properties,
    },
    data: {
      name: typed.name,
      filePath: typed.filePath,
      startLine: typed.startLine,
      endLine: typed.endLine,
      isExported: typed.isExported,
      properties: typed.properties,
    },
    incoming,
    outgoing,
    incoming_by_type: groupRelationsByType(incoming),
    outgoing_by_type: groupRelationsByType(outgoing),
    processes: typed.processes,
  };
}

function groupRelationsByType(relations: Array<{ relation: string } & Record<string, unknown>>): Record<string, unknown[]> {
  const grouped: Record<string, unknown[]> = {};
  for (const relation of relations) {
    const key = relation.relation.toLowerCase();
    (grouped[key] ??= []).push(relation);
  }
  return grouped;
}

async function v2CanonicalPaths(projectRoot: string): Promise<unknown[] | null> {
  const dbPath = path.join(projectRoot, '.cotx', 'v2', 'rules.db');
  if (!fs.existsSync(dbPath)) return null;
  const index = new DecisionRuleIndex({ dbPath });
  await index.open();
  try {
    const rows = await index.listCanonical();
    return rows.length > 0 ? rows : null;
  } finally {
    index.close();
  }
}

async function withV2Graph<T>(projectRoot: string, fn: (store: GraphTruthStore) => Promise<T>): Promise<T> {
  const dbPath = path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
  if (!fs.existsSync(dbPath)) throw new Error('No storage-v2 truth store found. Run cotx_compile first.');
  const store = new GraphTruthStore({ dbPath, readOnly: true });
  await store.open();
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

async function v2RouteMap(projectRoot: string, route?: string): Promise<unknown> {
  const routes = await withV2Graph(projectRoot, (store) => store.routeMap(route));
  return { routes, total: routes.length };
}

async function v2ShapeCheck(projectRoot: string, route?: string): Promise<unknown> {
  const routes = await withV2Graph(projectRoot, (store) => store.shapeCheck(route));
  const mismatches = routes.filter((item) => item.status === 'MISMATCH');
  return { routes, total: routes.length, mismatches: mismatches.length };
}

async function v2ApiImpact(projectRoot: string, input: { route?: string; file?: string }): Promise<unknown> {
  const routeMap = await withV2Graph(projectRoot, async (store) => {
    const routes = await store.routeMap(input.route);
    return input.file
      ? routes.filter((route) => route.filePath === input.file || route.handlers.some((handler) => handler.filePath === input.file))
      : routes;
  });
  const shaped = await withV2Graph(projectRoot, async (store) => {
    const routeIds = new Set(routeMap.map((route) => route.id));
    return (await store.shapeCheck(input.route)).filter((route) => routeIds.has(route.id));
  });
  const mismatchById = new Map(shaped.map((route) => [route.id, route]));
  const routes = routeMap.map((route) => {
    const shape = mismatchById.get(route.id);
    const mismatches = shape?.missingKeys ?? [];
    const risk = route.consumers.length >= 10 || mismatches.length >= 4
      ? 'HIGH'
      : route.consumers.length >= 4 || mismatches.length > 0
        ? 'MEDIUM'
        : 'LOW';
    return { ...route, missingKeys: mismatches, risk };
  });
  if (input.route || input.file) {
    return routes.length === 1 ? routes[0] : { routes, total: routes.length };
  }
  return { routes, total: routes.length };
}

async function v2ToolMap(projectRoot: string, tool?: string): Promise<unknown> {
  const tools = await withV2Graph(projectRoot, (store) => store.toolMap(tool));
  return { tools, total: tools.length };
}

async function v2CodeSearch(projectRoot: string, query: string | undefined, layer: string | undefined, limit: number): Promise<unknown[]> {
  return withV2Graph(projectRoot, (store) => store.searchCodeNodes(query, layer ? labelForLayerFilter(layer) : undefined, limit));
}

function labelForLayerFilter(layer: string): string {
  const map: Record<string, string> = {
    module: 'Module',
    concept: 'CodeElement',
    contract: 'Interface',
    flow: 'Process',
    concern: 'CodeElement',
    function: 'Function',
    method: 'Method',
    class: 'Class',
    route: 'Route',
    tool: 'Tool',
  };
  return map[layer] ?? layer;
}

async function v2DetectChanges(projectRoot: string, input: { scope?: string; baseRef?: string }): Promise<unknown> {
  const diff = readGitDiff(projectRoot, input);
  const rangesByFile = new Map(
    [...parseDiffRanges(diff).entries()].map(([filePath, ranges]) => [filePath, mergeRanges(ranges)]),
  );
  const changedNodes: Array<{ id: string; label: string; name: string; filePath: string; startLine: number; endLine: number }> = [];
  const affected = new Set<string>();
  const affectedProcesses = new Map<string, { id: string; label: string; changedNode: string; step: number }>();

  await withV2Graph(projectRoot, async (store) => {
    for (const [filePath, ranges] of rangesByFile) {
      const span = ranges.reduce((acc, range) => ({
        start: Math.min(acc.start, range.start),
        end: Math.max(acc.end, range.end),
      }), { start: Number.POSITIVE_INFINITY, end: 0 });
      if (!Number.isFinite(span.start) || span.end <= 0) continue;
      const nodes = await store.query(
        `MATCH (n:CodeNode) WHERE n.filePath = '${quoteToolCypher(filePath)}' AND n.startLine <= ${span.end} AND n.endLine >= ${span.start} AND n.label <> 'File' AND n.label <> 'Folder' AND n.label <> 'Community' AND n.label <> 'Process' RETURN n.id AS id, n.label AS label, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine ORDER BY n.startLine`,
      );
      for (const node of nodes) {
        const startLine = Number(node.startLine ?? 0);
        const endLine = Number(node.endLine ?? 0);
        if (!overlapsAnyRange(startLine, endLine, ranges)) continue;
          changedNodes.push({
            id: String(node.id),
            label: String(node.label ?? ''),
            name: String(node.name ?? ''),
            filePath: String(node.filePath ?? ''),
            startLine,
            endLine,
          });
      }
    }

    const changed = dedupeChangedNodes(changedNodes);
    for (const id of await store.codeImpactMany(changed.map((node) => node.id), 'upstream', 3, ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'ACCESSES', 'HANDLES_ROUTE', 'FETCHES', 'HANDLES_TOOL', 'STEP_IN_PROCESS'])) {
      affected.add(id);
    }
    for (const process of await store.codeProcessesForNodes(changed.map((node) => node.id))) {
      affectedProcesses.set(`${process.id}:${process.nodeId}`, {
        id: process.id,
        label: process.label,
        changedNode: process.nodeId,
        step: process.step,
      });
    }
  });

  const changed = dedupeChangedNodes(changedNodes);
  const risk = affected.size >= 50 || affectedProcesses.size >= 10
    ? 'HIGH'
    : affected.size >= 10 || affectedProcesses.size > 0
      ? 'MEDIUM'
      : 'LOW';

  return {
    scope: input.scope ?? 'unstaged',
    changed_files: [...rangesByFile.keys()].sort(),
    changed_symbols: changed,
    affected_symbols: [...affected].sort().slice(0, 200),
    affected_processes: [...affectedProcesses.values()].sort((a, b) => a.id.localeCompare(b.id) || a.changedNode.localeCompare(b.changedNode)),
    risk,
    summary: {
      changed_symbols: changed.length,
      affected_symbols: affected.size,
      affected_processes: affectedProcesses.size,
    },
  };
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length <= 1) return ranges.slice();
  const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

function overlapsAnyRange(startLine: number, endLine: number, ranges: Array<{ start: number; end: number }>): boolean {
  for (const range of ranges) {
    if (startLine <= range.end && endLine >= range.start) return true;
  }
  return false;
}

function readGitDiff(projectRoot: string, input: { scope?: string; baseRef?: string }): string {
  const scope = input.scope ?? 'unstaged';
  const args = scope === 'staged'
    ? ['diff', '--cached', '--unified=0']
    : scope === 'all'
      ? ['diff', 'HEAD', '--unified=0']
      : scope === 'compare'
        ? ['diff', input.baseRef ?? 'main', '--unified=0']
        : ['diff', '--unified=0'];
  return execSync(`git ${args.map(shellArg).join(' ')}`, { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
}

function parseDiffRanges(diff: string): Map<string, Array<{ start: number; end: number }>> {
  const ranges = new Map<string, Array<{ start: number; end: number }>>();
  let currentFile: string | null = null;
  for (const line of diff.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1] === '/dev/null' ? null : fileMatch[1];
      continue;
    }
    if (!currentFile) continue;
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) continue;
    const start = Number(hunkMatch[1]);
    const length = Number(hunkMatch[2] ?? '1');
    const end = Math.max(start, start + Math.max(1, length) - 1);
    const list = ranges.get(currentFile) ?? [];
    list.push({ start, end });
    ranges.set(currentFile, list);
  }
  return ranges;
}

function dedupeChangedNodes(nodes: Array<{ id: string; label: string; name: string; filePath: string; startLine: number; endLine: number }>): Array<{ id: string; label: string; name: string; filePath: string; startLine: number; endLine: number }> {
  return [...new Map(nodes.map((node) => [node.id, node])).values()]
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine || a.id.localeCompare(b.id));
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteToolCypher(value: unknown): string {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function parseOnboardingBudget(value: unknown): OnboardingBudget | null {
  if (value === undefined) return 'standard';
  return value === 'tiny' || value === 'standard' || value === 'deep' ? value : null;
}

function parseCompileEnrichPolicy(value: unknown): 'never' | 'bootstrap-if-available' | 'force-bootstrap' | null {
  if (value === undefined) return 'bootstrap-if-available';
  return value === 'never' || value === 'bootstrap-if-available' || value === 'force-bootstrap'
    ? value
    : null;
}

function parseIncrementalEnrichPolicy(value: unknown): 'never' | 'affected-if-available' | 'stale-if-available' | 'force-affected' | null {
  if (value === undefined) return 'affected-if-available';
  return value === 'never' || value === 'affected-if-available' || value === 'stale-if-available' || value === 'force-affected'
    ? value
    : null;
}

function workspaceLayoutNeedsRefresh(
  cachedWorkspaceLayout: ReturnType<CotxStore['readWorkspaceLayout']>,
  archStore: ArchitectureStore,
): boolean {
  if (!cachedWorkspaceLayout) return true;
  if (cachedWorkspaceLayout.summary.architecture_store_present !== archStore.exists()) return true;
  if (cachedWorkspaceLayout.candidates.some((candidate) => candidate.path.startsWith('.cotx/'))) return true;
  if (cachedWorkspaceLayout.directories.some((entry) => entry.kind === 'docs' && entry.path.startsWith('.cotx'))) return true;
  return false;
}

async function buildMinimalContext(
  projectRoot: string,
  input: { task?: string; focus?: string; changedFiles?: string[]; budget: OnboardingBudget },
): Promise<unknown> {
  const store = new CotxStore(projectRoot);
  const archStore = new ArchitectureStore(projectRoot);
  const cachedWorkspaceLayout = store.exists() ? store.readWorkspaceLayout() : null;
  const cachedLayoutStale = workspaceLayoutNeedsRefresh(cachedWorkspaceLayout, archStore);
  const workspaceLayout = cachedLayoutStale
    ? scanWorkspaceLayout(projectRoot)
    : cachedWorkspaceLayout!;
  const limits = input.budget === 'tiny'
    ? { code: 3, architecture: 3, candidates: 8 }
    : input.budget === 'deep'
      ? { code: 15, architecture: 10, candidates: 25 }
      : { code: 8, architecture: 6, candidates: 15 };
  const taskText = [input.task, input.focus, ...(input.changedFiles ?? [])].filter(Boolean).join(' ');
  const classification = classifyMinimalContextTask(taskText);
  const recommendedTools = recommendMinimalContextTools(store.exists(), workspaceLayout.summary.architecture_store_present, classification.intent);
  const sourceRootInventory = await collectProjectSourceRootInventory(projectRoot, { workspaceLayout });
  const riskFlags: string[] = [];
  const query = input.focus ?? input.task;

  let topCodeResults: unknown[] = [];
  if (store.exists() && query) {
    try {
      topCodeResults = await v2CodeSearch(projectRoot, query, undefined, limits.code);
    } catch {
      riskFlags.push('typed-graph-unavailable');
    }
  }

  let topArchitectureResults: unknown[] = [];
  if (query) {
    if (archStore.exists()) {
      try {
        topArchitectureResults = ArchitectureIndex.fromStore(archStore).search(query, limits.architecture);
      } catch {
        riskFlags.push('architecture-index-unavailable');
      }
    }
  }

  if (!store.exists()) riskFlags.push('cotx-map-missing');
  if (cachedLayoutStale) riskFlags.push('workspace-layout-stale');
  if (!workspaceLayout.summary.architecture_store_present) riskFlags.push('architecture-store-missing');

  return {
    task: input.task ?? null,
    focus: input.focus ?? null,
    budget: input.budget,
    task_classification: classification,
    workspace: {
      summary: workspaceLayout.summary,
      source_root_inventory: {
        summary: sourceRootInventory.summary,
        selected: sourceRootInventory.selected.slice(0, limits.candidates),
        excluded: sourceRootInventory.excluded.slice(0, limits.candidates),
      },
      candidate_inputs: workspaceLayout.candidates.slice(0, limits.candidates),
      asset_directories: workspaceLayout.directories
        .filter((entry) => entry.kind === 'asset')
        .slice(0, limits.candidates),
      package_boundaries: workspaceLayout.directories
        .filter((entry) => entry.kind === 'package')
        .slice(0, limits.candidates),
      repo_boundaries: workspaceLayout.directories
        .filter((entry) => entry.kind === 'repo-root' || entry.kind === 'nested-repo')
        .slice(0, limits.candidates),
    },
    changed_files: (input.changedFiles ?? []).map((filePath) => ({
      file: filePath,
      exists: fs.existsSync(path.join(projectRoot, filePath)),
    })),
    top_code_results: topCodeResults,
    top_architecture_results: topArchitectureResults,
    recommended_next_tools: recommendedTools,
    risk_flags: riskFlags,
    token_budget: {
      mode: input.budget,
      max_code_results: limits.code,
      max_architecture_results: limits.architecture,
      instruction: 'Do not read the full repository. Start with candidate_inputs, then use cotx_context/cotx_impact only for selected graph-backed targets.',
    },
  };
}

type PrepareTaskPhase = 'bootstrap' | 'enrich' | 'develop' | 'review';
type EnrichmentMode = 'none' | 'bounded-stale-enrich' | 'architecture-enrich' | 'docs-consistency-review';

function isPrepareTaskRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function countConsistencyStatus(onboarding: unknown, status: 'confirmed' | 'contradicted' | 'stale-doc' | 'graph-gap' | 'unknown'): number {
  if (!isPrepareTaskRecord(onboarding) || !isPrepareTaskRecord(onboarding.summary) || !isPrepareTaskRecord(onboarding.summary.consistency_counts)) return 0;
  const value = onboarding.summary.consistency_counts[status];
  return typeof value === 'number' ? value : 0;
}

function summaryBoolean(onboarding: unknown, field: 'has_cotx' | 'has_storage_v2_truth' | 'has_architecture_store'): boolean {
  if (!isPrepareTaskRecord(onboarding) || !isPrepareTaskRecord(onboarding.summary)) return false;
  return onboarding.summary[field] === true;
}

function summaryString(onboarding: unknown, field: 'graph_file_index_status'): string | null {
  if (!isPrepareTaskRecord(onboarding) || !isPrepareTaskRecord(onboarding.summary)) return null;
  const value = onboarding.summary[field];
  return typeof value === 'string' ? value : null;
}

function classifyPrepareTaskPhase(
  minimal: unknown,
  onboarding: unknown,
): {
  phase: PrepareTaskPhase;
  enrichment: {
    recommended: boolean;
    mode: EnrichmentMode;
    reason: string;
    triggers: string[];
  };
} {
  const hasCotx = summaryBoolean(onboarding, 'has_cotx');
  const hasTruth = summaryBoolean(onboarding, 'has_storage_v2_truth');
  const graphFileIndexStatus = summaryString(onboarding, 'graph_file_index_status');
  const graphGaps = countConsistencyStatus(onboarding, 'graph-gap');
  const staleDocs = countConsistencyStatus(onboarding, 'stale-doc');
  const unknown = countConsistencyStatus(onboarding, 'unknown');
  const contradicted = countConsistencyStatus(onboarding, 'contradicted');
  const minimalRecord = isPrepareTaskRecord(minimal) ? minimal : null;
  const taskIntent = isPrepareTaskRecord(minimal) && isPrepareTaskRecord(minimal.task_classification) && typeof minimal.task_classification.intent === 'string'
    ? minimal.task_classification.intent
    : 'general';
  const changedFiles = Array.isArray(minimalRecord?.changed_files)
    ? (minimalRecord.changed_files as Array<unknown>).length
    : 0;

  if (!hasCotx || !hasTruth) {
    return {
      phase: 'bootstrap',
      enrichment: {
        recommended: false,
        mode: 'none',
        reason: 'Deterministic truth is not ready yet. Compile/bootstrap before enrichment.',
        triggers: ['missing-cotx-or-truth'],
      },
    };
  }

  if (changedFiles > 0 || taskIntent === 'change') {
    return {
      phase: 'review',
      enrichment: {
        recommended: false,
        mode: 'none',
        reason: 'Deterministic truth is ready and the task is already change-oriented; proceed directly to review/planning tools.',
        triggers: [],
      },
    };
  }

  const triggers: string[] = [];
  if (graphFileIndexStatus && graphFileIndexStatus !== 'complete') triggers.push(`graph-file-index-${graphFileIndexStatus}`);
  if (graphGaps > 0) triggers.push(`graph-gap:${graphGaps}`);
  if (staleDocs > 0) triggers.push(`stale-doc:${staleDocs}`);
  if (unknown > 0) triggers.push(`unknown:${unknown}`);
  if (contradicted > 0) triggers.push(`contradicted:${contradicted}`);

  if (taskIntent === 'architecture' && (graphGaps > 0 || staleDocs > 0 || unknown > 0 || contradicted > 0 || graphFileIndexStatus === 'partial')) {
    return {
      phase: 'enrich',
      enrichment: {
        recommended: true,
        mode: 'architecture-enrich',
        reason: 'Architecture understanding would benefit from bounded evidence-backed enrichment before development.',
        triggers,
      },
    };
  }

  if (graphGaps > 0 || staleDocs > 0 || contradicted > 0 || unknown >= 12) {
    return {
      phase: 'enrich',
      enrichment: {
        recommended: true,
        mode: 'docs-consistency-review',
        reason: 'Repo cognition still has enough uncertainty or stale documentation that bounded enrichment/review should happen first.',
        triggers,
      },
    };
  }

  if (unknown > 0 || graphFileIndexStatus === 'partial') {
    return {
      phase: 'enrich',
      enrichment: {
        recommended: true,
        mode: 'bounded-stale-enrich',
        reason: 'Deterministic truth is present, but bounded stale-node enrichment should improve readability before action.',
        triggers,
      },
    };
  }

  return {
    phase: changedFiles > 0 || taskIntent === 'change' ? 'review' : 'develop',
    enrichment: {
      recommended: false,
      mode: 'none',
      reason: 'Deterministic context is already sufficient; proceed directly to planning or review.',
      triggers: [],
    },
  };
}

function recommendPrepareTaskTools(
  minimal: unknown,
  phase: PrepareTaskPhase,
  enrichmentMode: EnrichmentMode,
): Array<{ tool: string; reason: string }> {
  const minimalRecord = isPrepareTaskRecord(minimal) ? minimal : null;
  const base = Array.isArray(minimalRecord?.recommended_next_tools)
    ? (minimalRecord.recommended_next_tools as Array<unknown>).filter(isPrepareTaskRecord).map((tool) => ({
        tool: typeof tool.tool === 'string' ? tool.tool : 'unknown',
        reason: typeof tool.reason === 'string' ? tool.reason : '',
      }))
    : [];

  if (phase === 'review') {
    return [
      { tool: 'cotx_detect_changes', reason: 'Map the current change set to graph-backed symbols and processes first.' },
      { tool: 'cotx_review_change', reason: 'Review the current change set against doctrine and project boundaries.' },
      ...base,
    ];
  }

  if (phase === 'develop') {
    return [
      { tool: 'cotx_plan_change', reason: 'Turn the prepared context into a bounded implementation plan before editing.' },
      ...base,
    ];
  }

  if (phase !== 'enrich') return base;

  if (enrichmentMode === 'bounded-stale-enrich') {
    return [
      { tool: 'cotx_query', reason: 'Call with filter=stale and auto_enrich=true to refresh only the stale semantic nodes relevant to this task.' },
      ...base,
    ];
  }

  if (enrichmentMode === 'architecture-enrich') {
    return [
      { tool: 'cotx_map', reason: 'Read the architecture summary before selecting one perspective or component to enrich.' },
      { tool: 'cotx_query', reason: 'Search architecture nodes first, then enrich only the selected architecture scope.' },
      { tool: 'cotx_write', reason: 'Persist only evidence-backed enrichment fields after review; never create truth facts.' },
      ...base,
    ];
  }

  return [
    { tool: 'cotx_onboarding_context', reason: 'Review contradicted, stale-doc, graph-gap, and unknown findings before deciding whether to enrich or only document debt.' },
    { tool: 'cotx_query', reason: 'Use filter=stale and auto_enrich=true only for the bounded nodes that matter to the current task.' },
    ...base,
  ];
}

async function buildPrepareTask(
  projectRoot: string,
  input: { task?: string; focus?: string; changedFiles?: string[]; budget: OnboardingBudget },
): Promise<unknown> {
  // Freshness check + self-heal BEFORE any expensive context collection.
  // A successful auto-refresh ensures subsequent minimal/onboarding reads
  // see the updated graph.
  const preFreshness = detectFreshness(projectRoot);
  const autoRefresh = await maybeAutoRefresh(projectRoot, preFreshness);
  const postFreshness = autoRefresh.succeeded ? detectFreshness(projectRoot) : preFreshness;

  const minimal = await buildMinimalContext(projectRoot, input);
  const onboarding = collectOnboardingContext(projectRoot, { budget: input.budget });
  const phase = classifyPrepareTaskPhase(minimal, onboarding);

  const stale = staleAnnotation(postFreshness);

  return {
    task: input.task ?? null,
    focus: input.focus ?? null,
    budget: input.budget,
    phase: phase.phase,
    ...(autoRefresh.attempted || stale
      ? {
          index_freshness: {
            ...(autoRefresh.attempted
              ? {
                  auto_refreshed: {
                    succeeded: autoRefresh.succeeded,
                    trigger: autoRefresh.trigger,
                    files_updated: autoRefresh.files_updated,
                    duration_ms: autoRefresh.duration_ms,
                    ...(autoRefresh.error ? { error: autoRefresh.error } : {}),
                  },
                }
              : autoRefresh.skip_reason
                ? { auto_refresh_skipped: autoRefresh.skip_reason }
                : {}),
            ...(stale ? stale : {}),
          },
        }
      : {}),
    task_classification: isPrepareTaskRecord(minimal) ? minimal.task_classification ?? null : null,
    workspace: isPrepareTaskRecord(minimal) ? minimal.workspace ?? null : null,
    onboarding: {
      summary: onboarding.summary,
      top_hypotheses: onboarding.hypotheses.slice(0, input.budget === 'tiny' ? 3 : input.budget === 'deep' ? 10 : 6),
      consistency_preview: {
        confirmed: onboarding.consistency.confirmed.slice(0, 5),
        contradicted: onboarding.consistency.contradicted.slice(0, 5),
        'stale-doc': onboarding.consistency['stale-doc'].slice(0, 5),
        'graph-gap': onboarding.consistency['graph-gap'].slice(0, 5),
        unknown: onboarding.consistency.unknown.slice(0, 5),
      },
    },
    graph_health: {
      has_cotx: onboarding.summary.has_cotx,
      has_storage_v2_truth: onboarding.summary.has_storage_v2_truth,
      has_architecture_store: onboarding.summary.has_architecture_store,
      graph_file_index_status: onboarding.summary.graph_file_index_status,
      warnings: onboarding.summary.warnings,
      risk_flags: isPrepareTaskRecord(minimal) && Array.isArray(minimal.risk_flags) ? minimal.risk_flags : [],
    },
    enrichment_decision: phase.enrichment,
    recommended_next_tools: recommendPrepareTaskTools(minimal, phase.phase, phase.enrichment.mode),
    changed_files: isPrepareTaskRecord(minimal) ? minimal.changed_files ?? [] : [],
    token_budget: isPrepareTaskRecord(minimal) ? minimal.token_budget ?? null : null,
  };
}

function classifyMinimalContextTask(text: string): { intent: string; signals: string[] } {
  const normalized = text.toLowerCase();
  const signals: string[] = [];
  if (/\b(route|api|endpoint|handler|fetch)\b/.test(normalized)) signals.push('api');
  if (/\b(change|diff|impact|review|pr|merge)\b/.test(normalized)) signals.push('change');
  if (/\b(architecture|component|container|c4|workspace|map|diagram)\b/.test(normalized)) signals.push('architecture');
  if (/\b(tool|mcp|rpc)\b/.test(normalized)) signals.push('tool');
  const intent = signals.includes('api')
    ? 'api'
    : signals.includes('change')
      ? 'change'
      : signals.includes('architecture')
        ? 'architecture'
        : signals.includes('tool')
          ? 'tool'
          : 'general';
  return { intent, signals };
}

function recommendMinimalContextTools(hasCotx: boolean, hasArchitecture: boolean, intent: string): Array<{ tool: string; reason: string }> {
  const tools: Array<{ tool: string; reason: string }> = [
    { tool: 'cotx_onboarding_context', reason: 'Read targeted docs/manifests and validate document references against graph facts.' },
    { tool: 'cotx_source_roots', reason: 'Inspect deterministic source-root selection before trusting architecture grouping.' },
  ];
  if (!hasCotx) {
    tools.push({ tool: 'cotx_compile', reason: 'Compile before graph-backed symbol, route, and impact queries.' });
    return tools;
  }
  if (intent === 'api') {
    tools.push({ tool: 'cotx_route_map', reason: 'Inspect API routes, handlers, consumers, response keys, and middleware.' });
    tools.push({ tool: 'cotx_api_impact', reason: 'Use before changing a specific route or handler file.' });
  } else if (intent === 'change') {
    tools.push({ tool: 'cotx_detect_changes', reason: 'Map git diff hunks to typed graph symbols and affected processes.' });
    tools.push({ tool: 'cotx_review_change', reason: 'Review current changes against project doctrine.' });
  } else if (intent === 'architecture') {
    tools.push({ tool: 'cotx_map', reason: hasArchitecture ? 'Read the architecture summary and workspace layout.' : 'Confirm architecture data availability.' });
    if (hasArchitecture) tools.push({ tool: 'cotx_query', reason: 'Search architecture layer with layer=architecture for targeted components.' });
  } else {
    tools.push({ tool: 'cotx_query', reason: 'Search typed graph nodes for the task/focus terms.' });
    tools.push({ tool: 'cotx_context', reason: 'Inspect one selected graph node after search.' });
  }
  return tools;
}

export const COTX_TOOLS: ToolDefinition[] = [
  {
    name: 'cotx_compile',
    description: '[INDEX] Build or refresh the .cotx/ semantic map from the current working tree. Call FIRST in any new project. After file edits use mode=delta with files=[...] for seconds-scale updates. New git worktrees auto-seed from a sibling .cotx/ when available; seed_from=<path> can override the source. Returns stale_enrichments count; use cotx_query filter=stale to get enrichment tasks.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
        mode: {
          type: 'string',
          enum: ['full', 'delta'],
          default: 'full',
          description: 'Compilation mode',
        },
        enrich_policy: {
          type: 'string',
          enum: ['never', 'bootstrap-if-available', 'force-bootstrap', 'affected-if-available', 'stale-if-available', 'force-affected'],
          default: 'bootstrap-if-available',
          description: 'Enrichment policy. Full mode: never | bootstrap-if-available | force-bootstrap. Delta mode: never | affected-if-available | stale-if-available | force-affected.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to update (delta mode only)',
        },
        seed_from: {
          type: 'string',
          description: 'Absolute path of a sibling worktree whose .cotx/ should seed this project. Full-mode only. Delta-compiles files that differ between the two HEADs.',
        },
        force_full: {
          type: 'boolean',
          default: false,
          description: 'Bypass every incremental cache and take the legacy full compile path. For A/B comparison and debugging. Also honored via COTX_FORCE_FULL=1 env var.',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_query',
    description: '[READ] Search map nodes. Modes: keyword = BM25 over semantic artifacts (modules/concepts/contracts/flows) merged with typed-graph search over code symbols — works without any extra setup. focus = typed-graph search only. semantic = embedding cosine similarity over semantic artifacts (requires `cotx embed` one-time build; best for natural-language queries that lack exact symbol tokens). Also the on-demand LLM enrichment endpoint: filter=stale + layer=<concept|contract|flow> + auto_enrich=true runs a grounded agentic enrichment session. ROI: concept & flow = HIGH, contract = LOW. Results may be annotated with stale_against_head after branch switches — call cotx_prepare_task to refresh.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        query: { type: 'string', description: 'Search keyword or phrase' },
        layer: { type: 'string', enum: ['module', 'concept', 'contract', 'flow', 'concern', 'architecture'] },
        mode: { type: 'string', enum: ['keyword', 'focus', 'semantic'], default: 'keyword', description: 'Search mode: keyword (BM25), focus (PageRank), or semantic (embedding similarity)' },
        focus_node: { type: 'string', description: 'Personalization center for PageRank focus mode' },
        filter: { type: 'string', enum: ['stale'], description: 'Filter: stale returns nodes needing enrichment' },
        auto_enrich: { type: 'boolean', description: 'Auto-enrich stale nodes using configured LLM (requires filter=stale)' },
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional precise node id list to scope auto_enrich to exactly these nodes (requires filter=stale and auto_enrich=true). Intersected with the stale set; ignored for search modes.',
        },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 15 },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_context',
    description: '[READ] 360° view of a map node: details, dependencies, flows, concerns, annotations. If node is not found and you recently added it, run cotx_compile mode=delta files=[...] first.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
        node_id: {
          type: 'string',
          description: 'Node ID to inspect. Use architecture/<perspective-id> or architecture/<perspective-id>/<element-id> for architecture nodes.',
        },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['risk', 'complexity'] },
          description: 'Optional sections: risk, complexity',
        },
      },
      required: ['project_root', 'node_id'],
    },
  },
  {
    name: 'cotx_impact',
    description: '[READ] Blast radius analysis: what breaks if you change a node. Use cotx_api_impact instead for route/handler changes.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
        target: {
          type: 'string',
          description: 'Node ID or keyword to analyze',
        },
        direction: {
          type: 'string',
          enum: ['upstream', 'downstream'],
          default: 'upstream',
          description: 'Impact direction',
        },
      },
      required: ['project_root', 'target'],
    },
  },
  {
    name: 'cotx_map',
    description: '[READ] Generate prompt-friendly map summary in markdown. For interactive browser visualization use `cotx map --html` (one-off file) or `cotx daemon start` (persistent server). Run `cotx setup` for first-time configuration.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
        scope: {
          type: 'string',
          default: 'overview',
          description: 'overview, module:<id>, flow:<id>, or architecture',
        },
        depth: {
          type: 'number',
          minimum: 1,
          maximum: 3,
          default: 2,
          description: 'Detail level (1=minimal, 3=detailed)',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_write',
    description: '[WRITE] Persist enrichments (responsibility, description, diagrams, etc.) onto map nodes. Accepts a single write or an array for batch operations. Enrichments survive recompiles.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        writes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              node_id: { type: 'string' },
              field: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['node_id', 'field', 'content'],
          },
          description: 'Array of {node_id, field, content} objects, or omit for single write',
        },
        node_id: { type: 'string', description: 'Node ID (single write mode). Use architecture/<path> for architecture nodes; field must be: description, diagram, or data.' },
        field: { type: 'string', description: 'Field path (single write mode)' },
        content: { type: 'string', description: 'Content (single write mode)' },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_lint',
    description:
      '[REVIEW] Check map ↔ code consistency, report stale enrichments and broken references. Returns "No map found" if .cotx/ is absent — call cotx_compile first.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
        scope: {
          type: 'string',
          description: 'Scope to lint (module ID or empty for all)',
        },
        strict: {
          type: 'boolean',
          default: false,
          description: 'Exit with error on any issue',
        },
        rules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Rule categories: consistency, dead_code, architecture',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_diff',
    description: '[REVIEW] Semantic diff between two versions of the map (compared against a named snapshot).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
        snapshot: {
          type: 'string',
          description: 'Snapshot tag to compare against',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_doctrine',
    description: '[READ] Return the compiled project doctrine: principles, constraints, preferred patterns, and anti-patterns with evidence.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_cypher',
    description: '[GRAPH] Execute Cypher against the storage-v2 LadybugDB truth graph (read-only).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
        query: {
          type: 'string',
          description: 'Cypher query to execute against .cotx/v2/truth.lbug',
        },
      },
      required: ['project_root', 'query'],
    },
  },
  {
    name: 'cotx_decision_query',
    description: '[GRAPH] Query the storage-v2 CozoDB decision rule index. Supports canonical by concern and closure by closure id.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
        kind: {
          type: 'string',
          enum: ['canonical', 'closure'],
          description: 'Query kind: canonical or closure',
        },
        target: {
          type: 'string',
          description: 'Concern for canonical, or closure id for closure',
        },
      },
      required: ['project_root', 'kind', 'target'],
    },
  },
  {
    name: 'cotx_canonical_paths',
    description: '[GRAPH] Return compiled canonical paths and candidates with evidence and confidence.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Absolute path to project root',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_route_map',
    description: '[GRAPH] Show API route mappings: route nodes, handler files/functions, consumers, response keys, and middleware from the typed storage-v2 graph.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        route: { type: 'string', description: 'Optional route path or route node id filter' },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_shape_check',
    description: '[GRAPH] Check API route response keys against consumer accessed keys from the typed storage-v2 graph.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        route: { type: 'string', description: 'Optional route path or route node id filter' },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_api_impact',
    description: '[GRAPH] Pre-change impact report for an API route or handler file: handlers, consumers, response-shape mismatches, and risk.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        route: { type: 'string', description: 'Route path or route node id' },
        file: { type: 'string', description: 'Handler file path alternative to route' },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_tool_map',
    description: '[GRAPH] Show MCP/RPC tool definitions and their handler files/functions from the typed storage-v2 graph.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        tool: { type: 'string', description: 'Optional tool name or tool node id filter' },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_detect_changes',
    description: '[GRAPH] Map git diff hunks to typed graph CodeNode symbols, then report upstream impact and process participation.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        scope: { type: 'string', enum: ['unstaged', 'staged', 'all', 'compare'], default: 'unstaged', description: 'Diff scope' },
        base_ref: { type: 'string', description: 'Base ref for compare scope, default main' },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_plan_change',
    description: '[PLAN] Plan a project-coherent change path before editing code.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        target: { type: 'string', description: 'Target problem, symbol, module, or keyword' },
        intent: { type: 'string', description: 'Optional human intent to refine the plan' },
      },
      required: ['project_root', 'target'],
    },
  },
  {
    name: 'cotx_review_change',
    description: '[REVIEW] Review current changes against project doctrine to catch local-fix and half-refactor issues. Call before commit.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional explicit file list; otherwise git diff is used',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_enrichment_status',
    description: '[READ] Report enrichment coverage and freshness for this project. Returns per-layer counts (modules / concepts / contracts / flows enriched vs total) plus an overall status (empty | partial | complete | stale). Use this to decide whether enrichment is usable, partially usable, or needs a refresh compile. Enriched fields are best-effort; auto_description is the fallback and is always present.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_source_roots',
    description: '[READ] Return the deterministic source-root inventory that architecture compilation uses. Optionally run a non-authoritative agent/LLM advisory pass over workspace layout, README/docs, and bounded source reads when assist=true.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        budget: {
          type: 'string',
          enum: ['tiny', 'standard', 'deep'],
          default: 'standard',
          description: 'Budget for optional onboarding/advisory context',
        },
        assist: {
          type: 'boolean',
          default: false,
          description: 'When true and an LLM is configured, run an advisory agent review over the deterministic inventory',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_prepare_task',
    description: '[BOOTSTRAP] Call FIRST for any new task. Combines minimal context, onboarding context, graph health, enrichment recommendation, and recommended next tools into one deterministic result. Detects stale indexes (branch changed, working-tree dirty) and auto-refreshes via delta compile when drift ≤ 500 files.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        task: { type: 'string', description: 'Task or question the agent is trying to answer' },
        focus: { type: 'string', description: 'Optional focus term, file, symbol, route, module, or architecture component' },
        changed_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional changed files to include in the preparation context',
        },
        budget: {
          type: 'string',
          enum: ['tiny', 'standard', 'deep'],
          default: 'standard',
          description: 'Preparation budget',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_onboarding_context',
    description: '[BOOTSTRAP] Read-only deterministic onboarding context from README, agent instructions, docs, manifests, examples, existing .cotx, and architecture sidecars. Returns architecture hypotheses plus doc/graph consistency categories. Use graph_file_index_status to distinguish complete graph-gap evidence from partial or missing graph indexes.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        budget: {
          type: 'string',
          enum: ['tiny', 'standard', 'deep'],
          default: 'standard',
          description: 'Sampling budget for onboarding sources and consistency findings',
        },
      },
      required: ['project_root'],
    },
  },
  {
    name: 'cotx_minimal_context',
    description: '[BOOTSTRAP] Read-only deterministic starting context for an agent task. Combines workspace layout, candidate inputs, optional typed graph search, architecture hits, risk flags, and recommended next cotx tools without calling an LLM. Use it as a route map before broad source reads.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path to project root' },
        task: { type: 'string', description: 'Task or question the agent is trying to answer' },
        focus: { type: 'string', description: 'Optional focus term, file, symbol, route, or module' },
        changed_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional changed files to include in the starting context',
        },
        budget: {
          type: 'string',
          enum: ['tiny', 'standard', 'deep'],
          default: 'standard',
          description: 'Context budget',
        },
      },
      required: ['project_root'],
    },
  },
];

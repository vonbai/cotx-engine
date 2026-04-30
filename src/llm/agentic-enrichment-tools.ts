/**
 * Tools exposed to the agentic enrichment session.
 *
 * These complement read-only tools from pi-coding-agent (Read/Grep/Glob/ls/find).
 * The session orchestrator creates these bound to the current store so the
 * agent can write enrichments directly.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';
import { commandWrite } from '../commands/write.js';
import { CotxStore } from '../store/store.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import { createJsonAgentTool } from './agentic-repo-tools.js';

export type EnrichmentLayer = 'module' | 'concept' | 'contract' | 'flow' | 'architecture' | 'doctrine';

export interface EnrichmentWrite {
  node_id: string;
  layer: EnrichmentLayer;
  field: string;
  content: string;
}

export interface EnrichmentBatchResult {
  requested: number;
  written: number;
  skipped: Array<{ node_id: string; reason: string }>;
  budget_used: number;
  budget_remaining: number;
  budget_warning: boolean;
}

export interface EnrichmentFinalizeResult {
  acknowledged: true;
  total_written: number;
  total_batches: number;
  reason: string;
}

export interface EnrichmentToolsOptions {
  projectRoot: string;
  onToolCall: (name: string) => void;
  onBatchWrite: (written: EnrichmentWrite[], skipped: Array<{ node_id: string; reason: string }>) => void;
  onFinalize: (reason: string) => void;
  budgetCap?: number;
  budgetSoftWarn?: number;
}

interface EnrichmentToolsState {
  totalWritten: number;
  totalBatches: number;
  totalToolCalls: number;
  finalized: boolean;
}

export interface EnrichmentToolsBundle {
  tools: AgentTool<any>[];
  state: Readonly<EnrichmentToolsState>;
  getState: () => EnrichmentToolsState;
}

const FIELD_ALLOW = new Set([
  'enriched.responsibility',
  'enriched.definition',
  'enriched.guarantees',
  'enriched.error_paths',
  'enriched.description',
  'enriched.diagram',
  'enriched.data',
]);

const LAYER_DEFAULT_FIELD: Record<EnrichmentLayer, string> = {
  module: 'enriched.responsibility',
  concept: 'enriched.definition',
  contract: 'enriched.guarantees',
  flow: 'enriched.error_paths',
  architecture: 'enriched.description',
  doctrine: 'enriched.description',
};

export function createEnrichmentTools(options: EnrichmentToolsOptions): EnrichmentToolsBundle {
  const state: EnrichmentToolsState = {
    totalWritten: 0,
    totalBatches: 0,
    totalToolCalls: 0,
    finalized: false,
  };
  const cap = options.budgetCap ?? 300;
  const softWarn = options.budgetSoftWarn ?? 240;

  const writeTool = createJsonAgentTool(
    'write_enrichment',
    'Write Enrichment',
    `Write one enriched.* field onto a cognitive-graph node. ` +
      `**Emit MANY of these in parallel within a single assistant turn** — the execution layer runs them concurrently, so one turn with 60 parallel write_enrichment calls covers a whole layer in one round-trip instead of 60. ` +
      `Parameters: node_id (the graph node id), layer (module | concept | contract | flow | architecture), content (1-3 sentence grounded description). ` +
      `For architecture nodes, node_id may be "architecture/<perspective>" or "architecture/<perspective>/<element>". ` +
      `Field defaults: module→enriched.responsibility, concept→enriched.definition, contract→enriched.guarantees, flow→enriched.error_paths, architecture→enriched.description. ` +
      `Returns budget status.`,
    Type.Object({
      node_id: Type.String({ minLength: 1 }),
      layer: Type.Union([
        Type.Literal('module'),
        Type.Literal('concept'),
        Type.Literal('contract'),
        Type.Literal('flow'),
        Type.Literal('architecture'),
      ]),
      content: Type.String({ minLength: 1 }),
      field: Type.Optional(Type.String()),
    }),
    options.onToolCall,
    async (params: EnrichmentWrite) => {
      state.totalToolCalls += 1;
      state.totalBatches += 1;
      const field = params.field ?? LAYER_DEFAULT_FIELD[params.layer];
      if (!FIELD_ALLOW.has(field)) {
        options.onBatchWrite([], [{ node_id: params.node_id, reason: `field ${field} not allowed` }]);
        return { written: 0, error: `field ${field} not allowed` };
      }
      const normalizedNodeId = normalizeNodeId(params.layer, params.node_id);
      try {
        if (params.layer === 'architecture') {
          const archStore = new ArchitectureStore(options.projectRoot);
          if (!archStore.exists()) {
            options.onBatchWrite([], [{ node_id: params.node_id, reason: 'no architecture data' }]);
            return { written: 0, error: 'no architecture data' };
          }
          // archStore expects path WITHOUT the "architecture/" prefix, and field
          // name without the "enriched." prefix (it uses "description" / "diagram" / "data").
          const archPath = normalizedNodeId.slice('architecture/'.length);
          const fieldName = field.replace(/^enriched\./, '');
          archStore.writeField(archPath, fieldName, params.content);
          state.totalWritten += 1;
          options.onBatchWrite([{ ...params, field }], []);
          const budgetUsed = state.totalToolCalls;
          return {
            written: 1,
            node_id: params.node_id,
            field,
            budget_used: budgetUsed,
            budget_remaining: Math.max(0, cap - budgetUsed),
            budget_warning: budgetUsed >= softWarn,
          };
        }
        const result = await commandWrite(options.projectRoot, normalizedNodeId, field, params.content, {
          author: 'agent',
        });
        if (result.success) {
          state.totalWritten += 1;
          options.onBatchWrite([{ ...params, field }], []);
          const budgetUsed = state.totalToolCalls;
          return {
            written: 1,
            node_id: params.node_id,
            field,
            budget_used: budgetUsed,
            budget_remaining: Math.max(0, cap - budgetUsed),
            budget_warning: budgetUsed >= softWarn,
          };
        }
        options.onBatchWrite([], [{ node_id: params.node_id, reason: result.message }]);
        return { written: 0, error: result.message };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        options.onBatchWrite([], [{ node_id: params.node_id, reason: msg }]);
        return { written: 0, error: msg };
      }
    },
  );

  const contextTool = createJsonAgentTool(
    'cotx_context',
    'Cotx Node Context',
    'Return structural context for a graph node (module, concept, contract, flow, or architecture path). Use this to inspect skeleton data before drafting enrichment.',
    Type.Object({
      node_id: Type.String({ minLength: 1 }),
    }),
    options.onToolCall,
    (params: { node_id: string }) => {
      state.totalToolCalls += 1;
      const store = new CotxStore(options.projectRoot);
      if (!store.exists()) {
        return { error: 'No .cotx/ map found at projectRoot.' };
      }
      try {
        if (params.node_id.startsWith('architecture/')) {
          const archStore = new ArchitectureStore(options.projectRoot);
          if (!archStore.exists()) return { error: 'No architecture data.' };
          const rest = params.node_id.slice('architecture/'.length);
          const parts = rest.split('/');
          const perspectiveId = parts[0];
          if (parts.length === 1) {
            return {
              layer: 'architecture',
              perspective: archStore.readPerspective(perspectiveId),
              description: archStore.readDescription(perspectiveId),
              diagram: archStore.readDiagram(perspectiveId),
              children: archStore.listChildren(perspectiveId),
            };
          }
          const elementPath = parts.slice(1).join('/');
          try {
            const element = archStore.readElement(perspectiveId, elementPath);
            return {
              layer: 'architecture',
              element,
              description: archStore.readDescription(`${perspectiveId}/${elementPath}`),
              diagram: archStore.readDiagram(`${perspectiveId}/${elementPath}`),
              children: archStore.listChildren(`${perspectiveId}/${elementPath}`),
            };
          } catch (err) {
            return { error: `architecture element not found: ${params.node_id}` };
          }
        }
        // One bulk read across all 4 layers — previous code did 4 × listX
        // + per-layer readX, 8 LBug opens per lookup. Each enrichment
        // session emits tens of cotx_context calls, so this compounds.
        const { modules, concepts, contracts, flows } = store.loadAllSemanticArtifacts();
        const mod = modules.find((m) => m.id === params.node_id);
        if (mod) return { ...mod, layer: 'module' };
        const concept = concepts.find((c) => c.id === params.node_id);
        if (concept) return { ...concept, layer: 'concept' };
        const contract = contracts.find((c) => c.id === params.node_id);
        if (contract) return { ...contract, layer: 'contract' };
        const flow = flows.find((f) => f.id === params.node_id);
        if (flow) return { ...flow, layer: 'flow' };
        return { error: `Node not found: ${params.node_id}` };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  const finalizeTool = createJsonAgentTool(
    'cotx_finalize',
    'Finalize Enrichment Session',
    'Signal that this enrichment session is complete. Call this after your last batch write. Returns a summary of work done.',
    Type.Object({
      reason: Type.String({ minLength: 1 }),
    }),
    options.onToolCall,
    (params: { reason: string }) => {
      state.totalToolCalls += 1;
      state.finalized = true;
      options.onFinalize(params.reason);
      return {
        acknowledged: true,
        total_written: state.totalWritten,
        total_batches: state.totalBatches,
        reason: params.reason,
      } satisfies EnrichmentFinalizeResult;
    },
  );

  return {
    tools: [writeTool, contextTool, finalizeTool],
    state,
    getState: () => ({ ...state }),
  };
}

/**
 * Normalize architecture node IDs so `cotx_batch_write_enrichment` can accept
 * either `architecture/overall-architecture/cmd` or bare `cmd` plus layer.
 * For non-architecture layers, returns the node_id unchanged.
 */
function normalizeNodeId(layer: EnrichmentLayer, nodeId: string): string {
  if (layer !== 'architecture') return nodeId;
  return nodeId.startsWith('architecture/') ? nodeId : `architecture/${nodeId}`;
}

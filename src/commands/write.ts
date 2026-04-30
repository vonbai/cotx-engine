import { CotxStore } from '../store/store.js';
import { rebuildDerivedIndex } from '../store/derived-index.js';
import { CotxGraph } from '../query/graph-index.js';
import type {
  ModuleNode,
  ConceptNode,
  ContractNode,
  FlowNode,
  Annotation,
} from '../store/schema.js';

type LayerName = 'module' | 'concept' | 'contract' | 'flow';

type NodeWithEnrichedAndAnnotations = {
  id: string;
  struct_hash: string;
  enriched?: Record<string, unknown>;
  annotations?: Annotation[];
};

type FoundNode = { layer: LayerName; data: NodeWithEnrichedAndAnnotations };

// ── Zone protection ─────────────────────────────────────────────────────────

const DETERMINISTIC_FIELDS = new Set([
  'id',
  'files',
  'struct_hash',
  'canonical_entry',
  'depends_on',
  'depended_by',
  'provider',
  'consumer',
  'interface',
  'trigger',
  'steps',
  'states',
  'transitions',
  'aliases',
  'appears_in',
  'layer',
  'type',
  'owner_module',
  'state_field',
  'auto_description',
]);

type EnrichedShape = 'string' | 'string[]' | 'error_paths' | 'guards' | 'distinguished_from';

const ENRICHED_FIELD_SHAPES: Record<LayerName, Record<string, EnrichedShape>> = {
  module: {
    responsibility: 'string',
    key_patterns: 'string',
  },
  concept: {
    definition: 'string',
    distinguished_from: 'distinguished_from',
  },
  contract: {
    guarantees: 'string[]',
    invariants: 'string[]',
  },
  flow: {
    error_paths: 'error_paths',
    guards: 'guards',
    invariants: 'string[]',
  },
};

function parseStructuredArray(content: string): unknown[] {
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error('expected a JSON array');
  }
  return parsed;
}

function parseEnrichedValue(
  layer: LayerName,
  fieldName: string,
  content: string,
): unknown {
  const shape = ENRICHED_FIELD_SHAPES[layer]?.[fieldName] ?? 'string';

  switch (shape) {
    case 'string':
      return content;
    case 'string[]': {
      const parsed = parseStructuredArray(content);
      if (!parsed.every((item) => typeof item === 'string')) {
        throw new Error('expected an array of strings');
      }
      return parsed;
    }
    case 'error_paths': {
      const parsed = parseStructuredArray(content);
      if (
        !parsed.every(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).condition === 'string' &&
            typeof (item as Record<string, unknown>).behavior === 'string',
        )
      ) {
        throw new Error('expected [{condition, behavior}, ...]');
      }
      return parsed;
    }
    case 'guards': {
      const parsed = parseStructuredArray(content);
      if (
        !parsed.every(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).transition === 'string' &&
            typeof (item as Record<string, unknown>).condition === 'string',
        )
      ) {
        throw new Error('expected [{transition, condition}, ...]');
      }
      return parsed;
    }
    case 'distinguished_from': {
      const parsed = parseStructuredArray(content);
      if (
        !parsed.every(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).term === 'string' &&
            typeof (item as Record<string, unknown>).difference === 'string',
        )
      ) {
        throw new Error('expected [{term, difference}, ...]');
      }
      return parsed;
    }
  }
}

// ── Node lookup ──────────────────────────────────────────────────────────────

function findNodeAcrossLayers(store: CotxStore, nodeId: string): FoundNode | null {
  // One bulk read across the 4 layers instead of 4 sequential listX().includes
  // + per-layer readX. On large repos the prior N+1 pattern made every single
  // agent write spend 4 LBug opens just on layer discovery before the write
  // itself; aggregated across 100+ parallel enrichment writes that was the
  // dominant cost.
  const { modules, concepts, contracts, flows } = store.loadAllSemanticArtifacts();
  const mod = modules.find((m) => m.id === nodeId);
  if (mod) return { layer: 'module', data: mod as NodeWithEnrichedAndAnnotations };
  const concept = concepts.find((c) => c.id === nodeId);
  if (concept) return { layer: 'concept', data: concept as NodeWithEnrichedAndAnnotations };
  const contract = contracts.find((c) => c.id === nodeId);
  if (contract) return { layer: 'contract', data: contract as NodeWithEnrichedAndAnnotations };
  const flow = flows.find((f) => f.id === nodeId);
  if (flow) return { layer: 'flow', data: flow as NodeWithEnrichedAndAnnotations };
  return null;
}

// ── Write helpers ────────────────────────────────────────────────────────────

async function writeNodeToStore(
  store: CotxStore,
  layer: LayerName,
  data: NodeWithEnrichedAndAnnotations,
): Promise<void> {
  switch (layer) {
    case 'module':
      await store.writeModuleAsync(data as unknown as ModuleNode);
      break;
    case 'concept':
      await store.writeConceptAsync(data as unknown as ConceptNode);
      break;
    case 'contract':
      await store.writeContractAsync(data as unknown as ContractNode);
      break;
    case 'flow':
      await store.writeFlowAsync(data as unknown as FlowNode);
      break;
  }
}

async function writeEnriched(
  store: CotxStore,
  node: FoundNode,
  fieldName: string,
  content: string,
): Promise<{ success: boolean; message: string }> {
  if (DETERMINISTIC_FIELDS.has(fieldName)) {
    return {
      success: false,
      message: `Field "${fieldName}" is deterministic-only and cannot be written via enriched zone.`,
    };
  }

  const data = node.data;
  if (!data.enriched) {
    data.enriched = { source_hash: data.struct_hash, enriched_at: new Date().toISOString() };
  }
  try {
    data.enriched[fieldName] = parseEnrichedValue(node.layer, fieldName, content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Invalid enriched.${fieldName}: ${message}`,
    };
  }
  data.enriched['source_hash'] = data.struct_hash;
  data.enriched['enriched_at'] = new Date().toISOString();

  await writeNodeToStore(store, node.layer, data);
  // NOTE: derived index rebuild deferred to end-of-session. Rebuilding on
  // every write made the per-write cost O(n) in artifacts *and* opened
  // LadybugDB for read concurrently with other writers — a guaranteed lock
  // race under parallel enrichment tool calls. Callers (e.g. enrich-bg,
  // commandCompile, MCP write handlers) must call rebuildDerivedIndex() once
  // their write burst finishes.
  CotxGraph.invalidateCache();
  return { success: true, message: `Updated ${node.layer}/${data.id} enriched.${fieldName}` };
}

async function writeAnnotation(
  store: CotxStore,
  node: FoundNode,
  annotationType: string,
  content: string,
  options?: { author?: 'human' | 'agent' },
): Promise<{ success: boolean; message: string }> {
  const validTypes: Annotation['type'][] = ['constraint', 'intent', 'concern', 'question'];
  if (!validTypes.includes(annotationType as Annotation['type'])) {
    return {
      success: false,
      message: `Invalid annotation type: ${annotationType}. Use: ${validTypes.join(', ')}`,
    };
  }

  const data = node.data;
  if (!data.annotations) data.annotations = [];

  data.annotations.push({
    author: options?.author ?? 'human',
    type: annotationType as Annotation['type'],
    content,
    date: new Date().toISOString().split('T')[0],
  });

  await writeNodeToStore(store, node.layer, data);
  CotxGraph.invalidateCache();
  return {
    success: true,
    message: `Added ${annotationType} annotation to ${node.layer}/${data.id}`,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function commandWrite(
  projectRoot: string,
  nodeId: string,
  field: string,
  content: string,
  options?: { author?: 'human' | 'agent' },
): Promise<{ success: boolean; message: string }> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    return { success: false, message: 'No .cotx/ found. Run: cotx compile' };
  }

  const [zone, fieldName] = field.split('.', 2);
  if (!zone || !fieldName) {
    return {
      success: false,
      message: `Invalid field: ${field}. Use enriched.<field> or annotation.<type>`,
    };
  }

  const node = findNodeAcrossLayers(store, nodeId);
  if (!node) {
    return { success: false, message: `Node "${nodeId}" not found` };
  }

  let result: { success: boolean; message: string };
  if (zone === 'enriched') {
    result = await writeEnriched(store, node, fieldName, content);
  } else if (zone === 'annotation') {
    result = await writeAnnotation(store, node, fieldName, content, options);
  } else {
    return {
      success: false,
      message: `Unknown zone: ${zone}. Use enriched or annotation`,
    };
  }

  if (result.success) {
    store.appendLog({ operation: 'write', affected_nodes: [nodeId], summary: `${field} on ${nodeId}` });
  }

  return result;
}

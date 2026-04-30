/**
 * Normalization functions that convert raw cotx HTTP API payloads
 * (snake_case, server-shaped) into SDK ExplorerPerspective types (camelCase).
 */

import type {
  CotxLayerId,
  EvidenceAnchor,
  EvidenceStatus,
  ExplorerPerspective,
  ExplorerNode,
  ExplorerEdge,
  LayerSummary,
  PerspectiveStats,
  NodeStats,
} from '../types/explorer.js';
import {
  isCotxLayerId,
  labelForLayer,
  layerForPerspectiveId,
} from '../types/layers.js';

// ── Raw server types (what the HTTP API returns) ──────────────────────────

/** Raw architecture stats as returned by the cotx HTTP API (snake_case). */
export interface RawArchitectureStats {
  file_count: number;
  function_count: number;
  total_cyclomatic: number;
  max_cyclomatic: number;
  max_nesting_depth: number;
  risk_score: number;
}

/** Raw architecture element as returned by the cotx HTTP API. */
export interface RawArchitectureElement {
  id: string;
  path?: string;
  label: string;
  layer?: CotxLayerId;
  evidence?: EvidenceAnchor[];
  evidence_status?: EvidenceStatus;
  evidenceStatus?: EvidenceStatus;
  status_reason?: string | null;
  statusReason?: string | null;
  kind: 'group' | 'leaf';
  directory: string;
  children?: string[];
  files?: string[];
  exported_functions?: string[];
  contracts_provided?: string[];
  contracts_consumed?: string[];
  related_flows?: string[];
  stats: RawArchitectureStats;
  description?: string | null;
  diagram?: string | null;
}

/** Raw architecture edge as returned by the cotx HTTP API. */
export interface RawArchitectureEdge {
  from: string;
  to: string;
  label: string;
  type: string;
  weight: number;
}

/** Raw perspective data as returned by the cotx HTTP API. */
export interface RawPerspectiveData {
  id: string;
  label: string;
  layer?: CotxLayerId;
  evidence_status?: EvidenceStatus;
  evidenceStatus?: EvidenceStatus;
  status_reason?: string | null;
  statusReason?: string | null;
  summary?: string | null;
  layer_summary?: LayerSummary[];
  layerSummary?: LayerSummary[];
  components: RawArchitectureElement[];
  edges: RawArchitectureEdge[];
}

// ── Normalization ────────────────────────────────────────────────────────

/**
 * Normalize raw snake_case stats into camelCase NodeStats.
 */
export function normalizeNodeStats(raw: RawArchitectureStats): NodeStats {
  return {
    fileCount: raw.file_count,
    functionCount: raw.function_count,
    totalCyclomatic: raw.total_cyclomatic,
    maxCyclomatic: raw.max_cyclomatic,
    maxNestingDepth: raw.max_nesting_depth,
    riskScore: raw.risk_score,
  };
}

/**
 * Build a full node path for a component within a perspective.
 *
 * Top-level components get a path of just their id; nested children
 * get a full slash-delimited path from their parent.
 */
function buildNodePath(elementId: string, parentPath?: string): string {
  if (parentPath) {
    return `${parentPath}/${elementId}`;
  }
  return elementId;
}

/**
 * Derive a short label from a full id (last segment after `/`).
 */
function shortLabel(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1] ?? id;
}

/**
 * Build the breadcrumb array from a node path.
 */
function buildBreadcrumb(nodePath: string): string[] {
  return nodePath.split('/').filter(Boolean);
}

function normalizeEvidenceStatus(value: unknown): EvidenceStatus | undefined {
  if (
    value === 'grounded' ||
    value === 'stale' ||
    value === 'gap' ||
    value === 'unknown'
  ) {
    return value;
  }
  return undefined;
}

function normalizeLayer(value: unknown): CotxLayerId | undefined {
  return typeof value === 'string' && isCotxLayerId(value) ? value : undefined;
}

function normalizeEvidence(value: unknown): EvidenceAnchor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const anchors = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const ref = typeof record.ref === 'string'
      ? record.ref
      : typeof record.id === 'string'
        ? record.id
        : null;
    if (!ref) return [];
    const kind = typeof record.kind === 'string' ? record.kind : 'unknown';
    const anchor: EvidenceAnchor = {
      kind: (
        [
          'node',
          'relation',
          'file',
          'process',
          'route',
          'tool',
          'decision',
          'module',
          'contract',
          'flow',
          'architecture',
          'change',
          'doc',
          'unknown',
        ] as const
      ).includes(kind as EvidenceAnchor['kind'])
        ? kind as EvidenceAnchor['kind']
        : 'unknown',
      ref,
    };
    if (typeof record.filePath === 'string') anchor.filePath = record.filePath;
    if (typeof record.line === 'number') anchor.line = record.line;
    if (typeof record.detail === 'string') anchor.detail = record.detail;
    if (typeof record.score === 'number') anchor.score = record.score;
    return [anchor];
  });
  return anchors.length > 0 ? anchors : undefined;
}

function normalizeLayerSummary(value: unknown): LayerSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const summaries = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const layer = normalizeLayer(record.layer);
    if (!layer) return [];
    return [{
      layer,
      label: typeof record.label === 'string' ? record.label : labelForLayer(layer),
      perspectiveId: typeof record.perspectiveId === 'string'
        ? record.perspectiveId
        : typeof record.perspective_id === 'string'
          ? record.perspective_id
          : undefined,
      nodeCount: typeof record.nodeCount === 'number'
        ? record.nodeCount
        : typeof record.node_count === 'number'
          ? record.node_count
          : undefined,
      edgeCount: typeof record.edgeCount === 'number'
        ? record.edgeCount
        : typeof record.edge_count === 'number'
          ? record.edge_count
          : undefined,
      status: normalizeEvidenceStatus(record.status ?? record.evidence_status ?? record.evidenceStatus),
      summary: typeof record.summary === 'string' ? record.summary : undefined,
    } satisfies LayerSummary];
  });
  return summaries.length > 0 ? summaries : undefined;
}

/**
 * Normalize a raw architecture element into an ExplorerNode.
 *
 * @param raw - The raw element from the server
 * @param parentPath - If this is a nested element, the parent's full path
 */
export function normalizeNode(
  raw: RawArchitectureElement,
  parentPath?: string,
): ExplorerNode {
  const path = raw.path ?? buildNodePath(raw.id, parentPath);
  const node: ExplorerNode = {
    path,
    id: raw.id,
    label: raw.label,
    shortLabel: shortLabel(raw.id),
    breadcrumb: buildBreadcrumb(path),
    layer: normalizeLayer(raw.layer),
    evidenceStatus: normalizeEvidenceStatus(raw.evidence_status ?? raw.evidenceStatus),
    statusReason: raw.status_reason ?? raw.statusReason ?? null,
    evidence: normalizeEvidence(raw.evidence),
    directory: raw.directory,
    kind: raw.kind,
    stats: normalizeNodeStats(raw.stats),
  };

  if (raw.files) node.files = raw.files;
  if (raw.exported_functions) node.exportedFunctions = raw.exported_functions;
  if (raw.contracts_provided) node.contractsProvided = raw.contracts_provided;
  if (raw.contracts_consumed) node.contractsConsumed = raw.contracts_consumed;
  if (raw.related_flows) node.relatedFlows = raw.related_flows;
  if (raw.children) {
    node.children = raw.children.map((childId) =>
      childId.includes('/') ? childId : `${path}/${childId}`,
    );
  }
  if (raw.description !== undefined) node.description = raw.description;
  if (raw.diagram !== undefined) node.diagram = raw.diagram;

  return node;
}

/**
 * Normalize a raw architecture edge into an ExplorerEdge.
 * Generates a deterministic id from the edge's from/to/type.
 */
export function normalizeEdge(raw: RawArchitectureEdge, index: number): ExplorerEdge {
  return {
    id: `e-${raw.from}-${raw.to}-${index}`,
    from: raw.from,
    to: raw.to,
    type: raw.type,
    label: raw.label || undefined,
    weight: raw.weight,
  };
}

/**
 * Compute perspective-level stats from the normalized nodes and edges.
 */
function computePerspectiveStats(
  nodes: ExplorerNode[],
  edges: ExplorerEdge[],
): PerspectiveStats {
  let maxRiskScore = 0;
  for (const node of nodes) {
    if (node.stats.riskScore > maxRiskScore) {
      maxRiskScore = node.stats.riskScore;
    }
  }
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    maxRiskScore,
  };
}

/**
 * Normalize a complete raw perspective payload into an ExplorerPerspective.
 *
 * - Converts all snake_case fields to camelCase
 * - Builds full node paths (top-level elements get their id as path)
 * - Computes perspective-level stats from the node data
 *
 * @throws Error if the payload is missing required fields
 */
export function normalizePerspective(raw: unknown): ExplorerPerspective {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid perspective payload: expected an object');
  }

  const data = raw as Record<string, unknown>;

  if (typeof data.id !== 'string' || typeof data.label !== 'string') {
    throw new Error('Invalid perspective payload: missing id or label');
  }

  if (!Array.isArray(data.components)) {
    throw new Error('Invalid perspective payload: missing components array');
  }

  if (!Array.isArray(data.edges)) {
    throw new Error('Invalid perspective payload: missing edges array');
  }

  const rawComponents = data.components as RawArchitectureElement[];
  const rawEdges = data.edges as RawArchitectureEdge[];

  const nodes = rawComponents.map((comp) => normalizeNode(comp));
  const edges = rawEdges.map((edge, i) => normalizeEdge(edge, i));
  const stats = computePerspectiveStats(nodes, edges);
  const layer = normalizeLayer(data.layer) ?? layerForPerspectiveId(data.id as string);

  return {
    id: data.id as string,
    label: data.label as string,
    layer,
    evidenceStatus: normalizeEvidenceStatus(data.evidence_status ?? data.evidenceStatus),
    statusReason: (data.status_reason as string | null | undefined)
      ?? (data.statusReason as string | null | undefined)
      ?? null,
    summary: (data.summary as string | null | undefined) ?? null,
    layerSummary: normalizeLayerSummary(data.layer_summary ?? data.layerSummary),
    nodes,
    edges,
    stats,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import type {
  ModuleNode,
  ConceptNode,
  ContractNode,
  FlowNode,
  ConcernNode,
} from '../store/schema.js';
import type { CotxStore } from '../store/store.js';
import { BM25Index } from './bm25.js';
import { pageRank as computePageRank, type PageRankOptions } from './pagerank.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';

export interface CotxGraphNode {
  id: string;
  layer: 'module' | 'concept' | 'contract' | 'flow' | 'concern';
  data: ModuleNode | ConceptNode | ContractNode | FlowNode | ConcernNode;
}

export interface CotxGraphEdge {
  from: string;
  to: string;
  relation: string; // 'depends_on' | 'contract' | 'owns_concept' | 'step_in_flow' | 'affects'
}

export class CotxGraph {
  private nodes: Map<string, CotxGraphNode>;
  private outEdges: Map<string, CotxGraphEdge[]>; // from → edges
  private inEdges: Map<string, CotxGraphEdge[]>;  // to → edges
  private bm25Index: BM25Index | null = null;

  constructor() {
    this.nodes = new Map();
    this.outEdges = new Map();
    this.inEdges = new Map();
  }

  // ── Builder helpers ────────────────────────────────────────────────────────

  private addNode(node: CotxGraphNode): void {
    this.nodes.set(node.id, node);
  }

  private addEdge(edge: CotxGraphEdge): void {
    // Skip self-edges and edges with missing endpoints
    if (!edge.from || !edge.to || edge.from === edge.to) return;

    const out = this.outEdges.get(edge.from) ?? [];
    out.push(edge);
    this.outEdges.set(edge.from, out);

    const inArr = this.inEdges.get(edge.to) ?? [];
    inArr.push(edge);
    this.inEdges.set(edge.to, inArr);
  }

  // ── Cached factory (for MCP server — avoid per-call YAML reload) ────────

  private static cache = new Map<string, { graph: CotxGraph; timestamp: string }>();

  static invalidateCache(): void {
    this.cache.clear();
  }

  static fromStoreCached(store: CotxStore): CotxGraph {
    const meta = store.readMeta();
    const projectRoot = store.projectRoot;
    const entry = this.cache.get(projectRoot);
    if (entry && entry.timestamp === meta.compiled_at) {
      return entry.graph;
    }
    const graph = this.fromStore(store);
    this.cache.set(projectRoot, { graph, timestamp: meta.compiled_at });
    return graph;
  }

  // ── Factory ────────────────────────────────────────────────────────────────

  static fromStore(store: CotxStore): CotxGraph {
    const graph = this.fromStorageV2(store);

    // Load concerns
    for (const id of store.listConcerns()) {
      const concern = store.readConcern(id);
      graph.addNode({ id, layer: 'concern', data: concern });
      for (const mod of concern.affected_modules ?? []) {
        graph.addEdge({ from: id, to: mod, relation: 'affects' });
      }
    }

    // Load temporal coupling edges
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const couplingFile = path.join((store as any).cotxDir, 'graph', 'temporal-coupling.json');
      if (fs.existsSync(couplingFile)) {
        const lines = fs.readFileSync(couplingFile, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          const edge = JSON.parse(line) as { from: string; to: string };
          graph.addEdge({ from: edge.from, to: edge.to, relation: 'temporal_coupling' });
        }
      }
    } catch {
      // Temporal coupling edges are optional
    }

    return graph;
  }

  private static fromStorageV2(store: CotxStore): CotxGraph {
    const dbPath = path.join(store.projectRoot, '.cotx', 'v2', 'truth.lbug');
    const artifacts = readSemanticArtifactsSync(dbPath);

    const graph = new CotxGraph();
    for (const item of artifacts) {
      if (item.layer === 'module') {
        const mod = item.payload as ModuleNode;
        graph.addNode({ id: item.id, layer: 'module', data: mod });
        for (const dep of mod.depends_on ?? []) {
          graph.addEdge({ from: item.id, to: dep, relation: 'depends_on' });
        }
      } else if (item.layer === 'concept') {
        const concept = item.payload as ConceptNode;
        graph.addNode({ id: item.id, layer: 'concept', data: concept });
        if (concept.layer) {
          graph.addEdge({ from: concept.layer, to: item.id, relation: 'owns_concept' });
        }
      } else if (item.layer === 'contract') {
        const contract = item.payload as ContractNode;
        graph.addNode({ id: item.id, layer: 'contract', data: contract });
        graph.addEdge({ from: contract.consumer, to: contract.provider, relation: 'contract' });
      } else if (item.layer === 'flow') {
        const flow = item.payload as FlowNode;
        graph.addNode({ id: item.id, layer: 'flow', data: flow });
        for (const step of flow.steps ?? []) {
          graph.addEdge({ from: item.id, to: step.module, relation: 'step_in_flow' });
        }
      }
    }

    return graph;
  }

  // ── Basic lookups ──────────────────────────────────────────────────────────

  findNode(id: string): CotxGraphNode | undefined {
    return this.nodes.get(id);
  }

  allNodes(layer?: string): CotxGraphNode[] {
    const all = Array.from(this.nodes.values());
    if (layer === undefined) return all;
    return all.filter((n) => n.layer === layer);
  }

  // ── Relationship queries ───────────────────────────────────────────────────

  neighbors(id: string, direction: 'out' | 'in' | 'both'): CotxGraphEdge[] {
    const out = direction === 'in' ? [] : (this.outEdges.get(id) ?? []);
    const inArr = direction === 'out' ? [] : (this.inEdges.get(id) ?? []);
    return [...out, ...inArr];
  }

  // ── BFS traversal ─────────────────────────────────────────────────────────

  /**
   * Breadth-first traversal from startId.
   * Returns a map of depth → nodeIds[] (startId is NOT included in the result).
   */
  bfs(startId: string, direction: 'out' | 'in', maxDepth: number): Map<number, string[]> {
    const result = new Map<number, string[]>();
    const visited = new Set<string>([startId]);
    let frontier: string[] = [startId];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const edges =
          direction === 'out'
            ? (this.outEdges.get(nodeId) ?? [])
            : (this.inEdges.get(nodeId) ?? []);

        for (const edge of edges) {
          const neighbor = direction === 'out' ? edge.to : edge.from;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }

      if (nextFrontier.length > 0) {
        result.set(depth, nextFrontier);
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return result;
  }

  // ── Keyword search ─────────────────────────────────────────────────────────

  private buildBM25Index(): BM25Index {
    if (this.bm25Index) return this.bm25Index;

    const docs = [];
    for (const [id, node] of this.nodes) {
      const text = extractStrings(node.data).join(' ');
      docs.push({ id, text });
    }
    this.bm25Index = new BM25Index(docs);
    return this.bm25Index;
  }

  /**
   * BM25-ranked full-text search across all string fields in node.data.
   * Supports multi-term queries. Optionally filter by layer.
   */
  search(keyword: string, layer?: string, minScore = 0): CotxGraphNode[] {
    const index = this.buildBM25Index();
    const results = index.search(keyword, 50, minScore);

    return results
      .map((r) => this.nodes.get(r.id))
      .filter((n): n is CotxGraphNode => n !== undefined)
      .filter((n) => !layer || n.layer === layer);
  }

  /**
   * Same BM25 search as `search()` but preserves the score so callers can
   * merge-rank across multiple search backends.
   */
  searchWithScores(keyword: string, layer?: string, minScore = 0): Array<CotxGraphNode & { score: number }> {
    const index = this.buildBM25Index();
    const results = index.search(keyword, 50, minScore);
    const scored: Array<CotxGraphNode & { score: number }> = [];
    for (const r of results) {
      const node = this.nodes.get(r.id);
      if (!node) continue;
      if (layer && node.layer !== layer) continue;
      scored.push({ ...node, score: r.score });
    }
    return scored;
  }

  /**
   * Compute PageRank scores for all nodes.
   * If focusNodes are provided, computes personalized PageRank biased toward them.
   */
  pageRank(focusNodes?: string[], options?: PageRankOptions): Map<string, number> {
    const nodeIds = [...this.nodes.keys()];
    const outEdgesMap = new Map<string, string[]>();

    for (const id of nodeIds) {
      const edges = this.outEdges.get(id) ?? [];
      outEdgesMap.set(id, edges.map((e) => e.to));
    }

    return computePageRank(nodeIds, outEdgesMap, focusNodes, options);
  }

  /**
   * Return temporal coupling edges for a given node.
   * These are modules that historically change together.
   */
  temporalCoupling(nodeId: string): CotxGraphEdge[] {
    const all = this.neighbors(nodeId, 'both');
    return all.filter((e) => e.relation === 'temporal_coupling');
  }

  /**
   * Get all incoming edges for a node, grouped by nodeId.
   * Used by risk scorer for in-degree computation.
   */
  getInEdges(): Map<string, CotxGraphEdge[]> {
    return this.inEdges;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Recursively collect all string values from an object tree.
 */
function extractStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractStrings(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((v) =>
      extractStrings(v)
    );
  }
  return [];
}

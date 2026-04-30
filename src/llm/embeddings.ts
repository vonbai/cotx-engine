/**
 * Embedding-based semantic search index for cotx semantic map nodes.
 *
 * Builds a vector index of all nodes, stored at .cotx/embeddings.json.
 * Supports cosine similarity search for semantic queries.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from '../config.js';
import { createLlmClient } from './client.js';
import { CotxStore } from '../store/store.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';
import type { ModuleNode, ConceptNode, ContractNode, FlowNode } from '../store/schema.js';

const EMBEDDING_BATCH_SIZE = 20;
const DEFAULT_EMBEDDING_MODEL = 'openrouter/openai/text-embedding-3-small';

// ── Storage format ────────────────────────────────────────────────────────────

export interface EmbeddingEntry {
  id: string;
  layer: string;
  vector: number[];
  /** struct_hash of the source node when this embedding was generated; used
   *  as cache key on incremental rebuilds. Older indexes without this field
   *  are treated as stale (re-embedded on next run). */
  struct_hash?: string;
}

export interface EmbeddingIndexData {
  model: string;
  built_at: string;
  entries: EmbeddingEntry[];
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface EmbeddingIndex {
  search(queryVector: number[], limit?: number): Array<{ id: string; layer: string; score: number }>;
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ── Text builders per node type ───────────────────────────────────────────────

function moduleText(node: ModuleNode): string {
  const enriched = node.enriched as Record<string, unknown> | undefined;
  const responsibility =
    enriched?.responsibility as string | undefined ??
    enriched?.auto_description as string | undefined ??
    '';
  const files = (node.files ?? []).slice(0, 3).join(', ');
  return `${node.id} module: ${responsibility} Files: ${files}`;
}

function conceptText(node: ConceptNode): string {
  const definition = node.enriched?.definition ?? (node.aliases ?? []).join(', ');
  const appearsIn = (node.appears_in ?? []).slice(0, 3).join(', ');
  return `${node.id} concept: ${definition} Appears in: ${appearsIn}`;
}

function contractText(node: ContractNode): string {
  const iface = (node.interface ?? []).slice(0, 5).join(', ');
  return `${node.id} contract: ${node.provider} → ${node.consumer} Interface: ${iface}`;
}

function flowText(node: FlowNode): string {
  const steps = (node.steps ?? [])
    .slice(0, 5)
    .map((s) => `${s.module}.${s.function}`)
    .join(' → ');
  return `${node.id} flow: trigger=${node.trigger ?? ''} Steps: ${steps}`;
}

// ── Node collection ───────────────────────────────────────────────────────────

interface NodeEntry {
  id: string;
  layer: string;
  text: string;
  struct_hash: string;
}

function collectAllNodes(projectRoot: string): NodeEntry[] {
  // Bulk-read each layer in one LBug pass rather than N per-node opens;
  // matches the pattern used by buildEnrichmentContext.
  const dbPath = path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
  const entries: NodeEntry[] = [];

  for (const a of readSemanticArtifactsSync(dbPath, 'module')) {
    const n = a.payload as ModuleNode;
    entries.push({ id: a.id, layer: 'module', text: moduleText(n), struct_hash: n.struct_hash ?? '' });
  }
  for (const a of readSemanticArtifactsSync(dbPath, 'concept')) {
    const n = a.payload as ConceptNode;
    entries.push({ id: a.id, layer: 'concept', text: conceptText(n), struct_hash: n.struct_hash ?? '' });
  }
  for (const a of readSemanticArtifactsSync(dbPath, 'contract')) {
    const n = a.payload as ContractNode;
    entries.push({ id: a.id, layer: 'contract', text: contractText(n), struct_hash: n.struct_hash ?? '' });
  }
  for (const a of readSemanticArtifactsSync(dbPath, 'flow')) {
    const n = a.payload as FlowNode;
    entries.push({ id: a.id, layer: 'flow', text: flowText(n), struct_hash: n.struct_hash ?? '' });
  }

  return entries;
}

// ── Build index ───────────────────────────────────────────────────────────────

/**
 * Build or refresh the embedding index. Incremental by default: reuses
 * existing vectors whose `(layer, id, struct_hash, model)` matches the
 * current state, and only hits the embedding API for new or changed
 * nodes. Pass `options.force=true` to re-embed everything.
 *
 * Returns counts for logging: total = current node count,
 * embedded = vectors freshly computed by the LLM, cached = reused,
 * removed = orphan entries dropped.
 */
export async function buildEmbeddingIndex(
  projectRoot: string,
  options?: { log?: (msg: string) => void; force?: boolean },
): Promise<{ total: number; embedded: number; cached: number; removed: number }> {
  const log = options?.log ?? (() => { /* noop */ });

  const config = readConfig();
  if (!config.llm) {
    throw new Error('No LLM config found. Run `cotx config set-llm` to configure an LLM.');
  }
  if (!config.llm.embedding_model) {
    throw new Error('No embedding_model configured. Add embedding_model to your LLM config.');
  }

  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    throw new Error('No .cotx/ directory found. Run `cotx compile` first.');
  }

  const nodes = collectAllNodes(projectRoot);
  const total = nodes.length;
  if (total === 0) {
    log('No nodes found to embed.');
    return { total: 0, embedded: 0, cached: 0, removed: 0 };
  }

  // Load existing index for cache hits. If the embedding model changed,
  // all entries are stale — skip the cache.
  const outputPath = path.join(projectRoot, '.cotx', 'embeddings.json');
  const targetModel = config.llm.embedding_model ?? DEFAULT_EMBEDDING_MODEL;
  const cacheByKey = new Map<string, EmbeddingEntry>();
  let previousCount = 0;
  if (!options?.force && fs.existsSync(outputPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as EmbeddingIndexData;
      previousCount = prev.entries?.length ?? 0;
      if (prev.model === targetModel) {
        for (const e of prev.entries ?? []) {
          if (!e.struct_hash) continue; // old-format entry → always re-embed
          cacheByKey.set(`${e.layer}\0${e.id}\0${e.struct_hash}`, e);
        }
      } else {
        log(`Embedding model changed (${prev.model} → ${targetModel}); ignoring prior index.`);
      }
    } catch {
      log('Existing index unreadable; rebuilding from scratch.');
    }
  }

  // Partition: hit (reuse) vs miss (needs API call).
  const reused: EmbeddingEntry[] = [];
  const misses: NodeEntry[] = [];
  for (const n of nodes) {
    const key = `${n.layer}\0${n.id}\0${n.struct_hash}`;
    const hit = cacheByKey.get(key);
    if (hit) {
      reused.push({ id: n.id, layer: n.layer, vector: hit.vector, struct_hash: n.struct_hash });
    } else {
      misses.push(n);
    }
  }
  const removed = Math.max(0, previousCount - reused.length);

  log(`Incremental: ${reused.length} cached hits, ${misses.length} to embed, ${removed} stale entries dropped.`);

  const client = createLlmClient(config.llm);
  const fresh: EmbeddingEntry[] = [];
  for (let i = 0; i < misses.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = misses.slice(i, i + EMBEDDING_BATCH_SIZE);
    const texts = batch.map((n) => n.text);
    log(`  Batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}/${Math.ceil(misses.length / EMBEDDING_BATCH_SIZE)}: ${batch.length} nodes`);
    const vectors = await client.embed(texts);
    for (let j = 0; j < batch.length; j++) {
      fresh.push({ id: batch[j].id, layer: batch[j].layer, vector: vectors[j], struct_hash: batch[j].struct_hash });
    }
  }

  const indexData: EmbeddingIndexData = {
    model: targetModel,
    built_at: new Date().toISOString(),
    entries: [...reused, ...fresh],
  };
  fs.writeFileSync(outputPath, JSON.stringify(indexData, null, 2), 'utf-8');

  log(`Embedding index written to ${outputPath} (${indexData.entries.length} vectors: ${reused.length} reused, ${fresh.length} fresh).`);

  return { total, embedded: fresh.length, cached: reused.length, removed };
}

// ── Load index ────────────────────────────────────────────────────────────────

class InMemoryEmbeddingIndex implements EmbeddingIndex {
  private readonly entries: EmbeddingEntry[];

  constructor(entries: EmbeddingEntry[]) {
    this.entries = entries;
  }

  search(queryVector: number[], limit = 10): Array<{ id: string; layer: string; score: number }> {
    const scored = this.entries.map((entry) => ({
      id: entry.id,
      layer: entry.layer,
      score: cosineSimilarity(queryVector, entry.vector),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }
}

/**
 * Load a cached embedding index from .cotx/embeddings.json.
 * Returns null if index doesn't exist.
 */
export function loadEmbeddingIndex(projectRoot: string): EmbeddingIndex | null {
  const indexPath = path.join(projectRoot, '.cotx', 'embeddings.json');
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  const raw = fs.readFileSync(indexPath, 'utf-8');
  const data = JSON.parse(raw) as EmbeddingIndexData;

  return new InMemoryEmbeddingIndex(data.entries);
}

// ── Semantic search ───────────────────────────────────────────────────────────

/**
 * Embed a query string and search the index.
 * Convenience function that combines client.embed + index.search.
 */
export async function semanticSearch(
  projectRoot: string,
  query: string,
  limit = 10,
  options?: { layer?: string },
): Promise<Array<{ id: string; layer: string; score: number }>> {
  const index = loadEmbeddingIndex(projectRoot);
  if (!index) {
    throw new Error('No embedding index found. Run `cotx embed` to build one.');
  }

  const config = readConfig();
  if (!config.llm) {
    throw new Error('No LLM config found. Run `cotx config set-llm` to configure an LLM.');
  }

  const client = createLlmClient(config.llm);
  const [queryVector] = await client.embed([query]);
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    throw new Error('No .cotx/ directory found. Run `cotx compile` first.');
  }

  const liveNodes = new Set<string>();
  for (const id of store.listModules()) liveNodes.add(`module\0${id}`);
  for (const id of store.listConcepts()) liveNodes.add(`concept\0${id}`);
  for (const id of store.listContracts()) liveNodes.add(`contract\0${id}`);
  for (const id of store.listFlows()) liveNodes.add(`flow\0${id}`);

  const rawResults = index.search(queryVector, Number.MAX_SAFE_INTEGER);
  return rawResults
    .filter((result) => liveNodes.has(`${result.layer}\0${result.id}`))
    .filter((result) => !options?.layer || result.layer === options.layer)
    .slice(0, limit);
}

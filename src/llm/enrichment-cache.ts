/**
 * Phase B: per-node enrichment response cache.
 *
 * Keyed on (node_id, struct_hash, enricher_version, field). A hit means the
 * same node at the same structural state has already been enriched by the
 * same prompt/model combo — no need to ask the LLM again.
 *
 * Storage: node:sqlite at `.cotx/cache/enrichment.db`. Uses only the subset
 * of the API stable across Node 22's experimental sqlite module.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface EnrichmentCacheEntry {
  node_id: string;
  struct_hash: string;
  enricher_version: string;
  field: string;
  content: string;
  created_at: string;
}

export interface EnrichmentCacheStats {
  hits: number;
  misses: number;
  puts: number;
  entries: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS enrichment_cache (
  node_id TEXT NOT NULL,
  struct_hash TEXT NOT NULL,
  enricher_version TEXT NOT NULL,
  field TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(node_id, struct_hash, enricher_version, field)
);
CREATE INDEX IF NOT EXISTS idx_enrich_cache_node ON enrichment_cache(node_id);
CREATE INDEX IF NOT EXISTS idx_enrich_cache_version ON enrichment_cache(enricher_version);
`;

export class EnrichmentCache {
  private readonly dbPath: string;
  private readonly version: string;
  private db: DatabaseSync | null = null;
  private stats: EnrichmentCacheStats = { hits: 0, misses: 0, puts: 0, entries: 0 };

  constructor(projectRoot: string, enricherVersion: string) {
    const cacheDir = path.join(projectRoot, '.cotx', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    this.dbPath = path.join(cacheDir, 'enrichment.db');
    this.version = enricherVersion;
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(SCHEMA);
    return this.db;
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      this.db = null;
    }
  }

  /**
   * Look up a cached enrichment. Returns `null` on miss. Bumps the
   * hit/miss counters for observability.
   */
  get(nodeId: string, structHash: string, field: string): EnrichmentCacheEntry | null {
    if (!structHash) {
      this.stats.misses += 1;
      return null;
    }
    const stmt = this.open().prepare(
      'SELECT node_id, struct_hash, enricher_version, field, content, created_at ' +
        'FROM enrichment_cache WHERE node_id = ? AND struct_hash = ? AND enricher_version = ? AND field = ?',
    );
    const row = stmt.get(nodeId, structHash, this.version, field) as
      | EnrichmentCacheEntry
      | undefined;
    if (row) {
      this.stats.hits += 1;
      return row;
    }
    this.stats.misses += 1;
    return null;
  }

  /** Upsert an enrichment into the cache. */
  put(nodeId: string, structHash: string, field: string, content: string): void {
    if (!structHash || !content) return;
    const stmt = this.open().prepare(
      'INSERT INTO enrichment_cache (node_id, struct_hash, enricher_version, field, content, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(node_id, struct_hash, enricher_version, field) DO UPDATE SET ' +
        '  content = excluded.content, created_at = excluded.created_at',
    );
    stmt.run(nodeId, structHash, this.version, field, content, new Date().toISOString());
    this.stats.puts += 1;
  }

  /** Total cached entries for the current enricher_version. Lazy count. */
  countEntries(): number {
    const row = this.open()
      .prepare('SELECT COUNT(*) AS n FROM enrichment_cache WHERE enricher_version = ?')
      .get(this.version) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Reset counters (does not touch persisted data). */
  getStats(): EnrichmentCacheStats {
    return { ...this.stats, entries: this.countEntries() };
  }
}

/**
 * Build a stable enricher version string. Cache is invalidated automatically
 * whenever any component in this string changes (prompt text, model id,
 * cache schema version).
 */
export function buildEnricherVersion(
  promptHashes: Record<string, string>,
  modelId: string,
  schemaVersion: number,
): string {
  const hash = createHash('sha256');
  for (const key of Object.keys(promptHashes).sort()) {
    hash.update(`${key}:${promptHashes[key]}`);
  }
  hash.update(`model:${modelId}`);
  hash.update(`schema:${schemaVersion}`);
  return hash.digest('hex').slice(0, 16);
}

/** Convenience: hash a prompt string. */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

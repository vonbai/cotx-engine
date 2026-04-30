/**
 * Phase D: incremental compile cache.
 *
 * Keyed on file content hash. Lets subsequent `cotx compile` runs skip
 * Tree-sitter parsing for files whose content is unchanged. Companion
 * tables (export_map / implementor_map / route_registry / fetch_calls)
 * cache cross-file indexes so the resolution phases can be incremental too.
 *
 * Storage: node:sqlite at `.cotx/cache/incremental.db`. Zero new deps.
 *
 * Invalidation: cache_meta row engine_version (the cotx-engine semver +
 * language provider hash + schema version) is written on first use. On
 * mismatch the whole DB is wiped — safer than trying to selectively
 * invalidate entries whose semantics may have shifted across engine
 * revisions.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FileCacheEntry {
  path: string;
  content_hash: string;
  mtime_ms: number;
  parse_payload: string;
}

export interface ExportsEntry {
  file_path: string;
  symbol_name: string;
}

export interface ImplementorEntry {
  interface_id: string;
  class_id: string;
}

export interface RouteEntry {
  file_path: string;
  url: string;
  handler_id: string;
}

export interface FetchCallEntry {
  file_path: string;
  url: string;
  confidence: number | null;
}

export interface IncrementalCacheStats {
  hits: number;
  misses: number;
  files: number;
  wiped: boolean;
}

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_cache (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  parse_payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_cache_hash ON file_cache(content_hash);

CREATE TABLE IF NOT EXISTS export_map (
  file_path TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  PRIMARY KEY (file_path, symbol_name)
);

CREATE TABLE IF NOT EXISTS implementor_map (
  interface_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  PRIMARY KEY (interface_id, class_id)
);

CREATE TABLE IF NOT EXISTS route_registry (
  file_path TEXT NOT NULL,
  url TEXT NOT NULL,
  handler_id TEXT NOT NULL,
  PRIMARY KEY (file_path, url)
);

CREATE TABLE IF NOT EXISTS fetch_calls (
  file_path TEXT NOT NULL,
  url TEXT NOT NULL,
  confidence REAL,
  PRIMARY KEY (file_path, url)
);

CREATE TABLE IF NOT EXISTS cache_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class IncrementalCache {
  private readonly dbPath: string;
  private readonly engineVersion: string;
  private db: DatabaseSync | null = null;
  private stats: IncrementalCacheStats = { hits: 0, misses: 0, files: 0, wiped: false };

  constructor(projectRoot: string, engineVersion: string) {
    const cacheDir = path.join(projectRoot, '.cotx', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    this.dbPath = path.join(cacheDir, 'incremental.db');
    this.engineVersion = engineVersion;
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(SCHEMA_SQL);
    this.verifyOrWipeSchema();
    return this.db;
  }

  /**
   * Check cache_meta for engine_version + schema_version. If mismatch, wipe
   * every table (safer than partial invalidation) and re-stamp meta.
   */
  private verifyOrWipeSchema(): void {
    const db = this.db!;
    const currentEngine = db.prepare('SELECT value FROM cache_meta WHERE key = ?').get('engine_version') as
      | { value: string } | undefined;
    const currentSchema = db.prepare('SELECT value FROM cache_meta WHERE key = ?').get('schema_version') as
      | { value: string } | undefined;

    if (
      currentEngine?.value === this.engineVersion &&
      currentSchema?.value === String(SCHEMA_VERSION)
    ) {
      return; // Valid cache, reuse as-is.
    }

    // Version mismatch or first run: wipe every table.
    const tables = ['file_cache', 'export_map', 'implementor_map', 'route_registry', 'fetch_calls'];
    for (const t of tables) db.exec(`DELETE FROM ${t}`);
    db.exec('DELETE FROM cache_meta');

    const stamp = db.prepare('INSERT INTO cache_meta (key, value) VALUES (?, ?)');
    stamp.run('engine_version', this.engineVersion);
    stamp.run('schema_version', String(SCHEMA_VERSION));
    stamp.run('wiped_at', new Date().toISOString());
    this.stats.wiped = true;
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

  // ── File-level parse cache ────────────────────────────────────────────────

  /** Look up by path; returns entry only if content_hash matches. */
  getFileByHash(filePath: string, contentHash: string): FileCacheEntry | null {
    const row = this.open()
      .prepare('SELECT path, content_hash, mtime_ms, parse_payload FROM file_cache WHERE path = ?')
      .get(filePath) as FileCacheEntry | undefined;
    if (!row || row.content_hash !== contentHash) {
      this.stats.misses += 1;
      return null;
    }
    this.stats.hits += 1;
    return row;
  }

  /** Look up by content_hash alone (e.g. when a file is renamed). */
  getAnyByHash(contentHash: string): FileCacheEntry | null {
    const row = this.open()
      .prepare('SELECT path, content_hash, mtime_ms, parse_payload FROM file_cache WHERE content_hash = ? LIMIT 1')
      .get(contentHash) as FileCacheEntry | undefined;
    return row ?? null;
  }

  /** Upsert a file's parse result into the cache. */
  putFile(entry: FileCacheEntry): void {
    this.open()
      .prepare(
        'INSERT INTO file_cache (path, content_hash, mtime_ms, parse_payload) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, mtime_ms = excluded.mtime_ms, parse_payload = excluded.parse_payload',
      )
      .run(entry.path, entry.content_hash, entry.mtime_ms, entry.parse_payload);
  }

  /** Delete a file's cache entry (e.g. when the file is deleted on disk). */
  deleteFile(filePath: string): void {
    this.open().prepare('DELETE FROM file_cache WHERE path = ?').run(filePath);
    // Cascade: also clear per-file companion tables.
    this.open().prepare('DELETE FROM export_map WHERE file_path = ?').run(filePath);
    this.open().prepare('DELETE FROM route_registry WHERE file_path = ?').run(filePath);
    this.open().prepare('DELETE FROM fetch_calls WHERE file_path = ?').run(filePath);
  }

  // ── Exports map ───────────────────────────────────────────────────────────

  getExports(filePath: string): string[] {
    const rows = this.open()
      .prepare('SELECT symbol_name FROM export_map WHERE file_path = ?')
      .all(filePath) as Array<{ symbol_name: string }>;
    return rows.map((r) => r.symbol_name);
  }

  setExports(filePath: string, symbols: string[]): void {
    const db = this.open();
    db.prepare('DELETE FROM export_map WHERE file_path = ?').run(filePath);
    if (symbols.length === 0) return;
    const insert = db.prepare('INSERT INTO export_map (file_path, symbol_name) VALUES (?, ?)');
    for (const s of symbols) insert.run(filePath, s);
  }

  // ── Implementor map ──────────────────────────────────────────────────────

  getAllImplementors(): ImplementorEntry[] {
    return this.open()
      .prepare('SELECT interface_id, class_id FROM implementor_map')
      .all() as unknown as ImplementorEntry[];
  }

  replaceImplementors(entries: ImplementorEntry[]): void {
    const db = this.open();
    db.exec('DELETE FROM implementor_map');
    if (entries.length === 0) return;
    const insert = db.prepare('INSERT INTO implementor_map (interface_id, class_id) VALUES (?, ?)');
    for (const e of entries) insert.run(e.interface_id, e.class_id);
  }

  // ── Route registry ───────────────────────────────────────────────────────

  getAllRoutes(): RouteEntry[] {
    return this.open()
      .prepare('SELECT file_path, url, handler_id FROM route_registry')
      .all() as unknown as RouteEntry[];
  }

  setRoutesForFile(filePath: string, routes: Array<Omit<RouteEntry, 'file_path'>>): void {
    const db = this.open();
    db.prepare('DELETE FROM route_registry WHERE file_path = ?').run(filePath);
    if (routes.length === 0) return;
    const insert = db.prepare('INSERT INTO route_registry (file_path, url, handler_id) VALUES (?, ?, ?)');
    for (const r of routes) insert.run(filePath, r.url, r.handler_id);
  }

  // ── Fetch calls ──────────────────────────────────────────────────────────

  getAllFetchCalls(): FetchCallEntry[] {
    return this.open()
      .prepare('SELECT file_path, url, confidence FROM fetch_calls')
      .all() as unknown as FetchCallEntry[];
  }

  setFetchCallsForFile(filePath: string, calls: Array<Omit<FetchCallEntry, 'file_path'>>): void {
    const db = this.open();
    db.prepare('DELETE FROM fetch_calls WHERE file_path = ?').run(filePath);
    if (calls.length === 0) return;
    const insert = db.prepare('INSERT INTO fetch_calls (file_path, url, confidence) VALUES (?, ?, ?)');
    for (const c of calls) insert.run(filePath, c.url, c.confidence);
  }

  // ── Misc ────────────────────────────────────────────────────────────────

  /** Remove cache entries for files no longer present on disk. */
  pruneMissingFiles(existingPaths: Set<string>): number {
    const db = this.open();
    const rows = db.prepare('SELECT path FROM file_cache').all() as Array<{ path: string }>;
    let removed = 0;
    for (const { path: p } of rows) {
      if (!existingPaths.has(p)) {
        this.deleteFile(p);
        removed += 1;
      }
    }
    return removed;
  }

  countFiles(): number {
    const row = this.open().prepare('SELECT COUNT(*) AS n FROM file_cache').get() as
      | { n: number } | undefined;
    return row?.n ?? 0;
  }

  getStats(): IncrementalCacheStats {
    return { ...this.stats, files: this.countFiles() };
  }
}

/**
 * Compute a content hash for a file buffer. SHA-256 truncated to 40 chars.
 */
export function hashContent(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 40);
}

/**
 * Build the engine_version stamp used to invalidate the cache on upgrades.
 * Includes the cotx-engine semver plus the language-provider signature so
 * adding / removing a tree-sitter grammar also invalidates the cache.
 */
export function buildEngineVersion(cotxEngineVersion: string, languageProviderHash: string): string {
  const hash = createHash('sha256');
  hash.update(`cotx:${cotxEngineVersion}`);
  hash.update(`lang:${languageProviderHash}`);
  hash.update(`schema:${SCHEMA_VERSION}`);
  return hash.digest('hex').slice(0, 16);
}

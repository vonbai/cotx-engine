/**
 * Phase D step 2: File-level parse cache integration.
 *
 * The core Tree-sitter parse phase is per-file and self-contained. This
 * module does three things:
 *
 *  1. Classifies a batch of files into (cached hits) vs (misses needing
 *     fresh parse), based on content-hash lookup in IncrementalCache.
 *  2. On cache hit: re-applies the cached nodes / symbols / relationships
 *     to the live KnowledgeGraph + SymbolTable, identical to what the
 *     worker path does on line 117-150 of parsing-processor.ts.
 *  3. After fresh parsing: splits the worker's merged output back into
 *     per-file payloads and persists each one keyed on content_hash.
 *
 * This makes compile() parse only changed files on subsequent runs. The
 * cached payload is a JSON-serialized PerFileParseData which contains
 * every field of ParseWorkerResult scoped to one file.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { KnowledgeGraph } from '../graph/types.js';
import type { NodeLabel } from '../shared/graph-types.js';
import type { SymbolTable } from './symbol-table.js';
import type {
  ExtractedAssignment,
  ExtractedCall,
  ExtractedDecoratorRoute,
  ExtractedFetchCall,
  ExtractedHeritage,
  ExtractedImport,
  ExtractedORMQuery,
  ExtractedRoute,
  ExtractedToolDef,
  FileConstructorBindings,
  FileTypeEnvBindings,
  ParsedNode,
  ParsedRelationship,
  ParsedSymbol,
  ParseWorkerResult,
} from './workers/parse-worker.js';
import type { IncrementalCache, FileCacheEntry } from '../../compiler/incremental-cache.js';

/**
 * Per-file slice of a ParseWorkerResult. This is what we cache.
 */
export interface PerFileParseData {
  filePath: string;
  nodes: ParsedNode[];
  symbols: ParsedSymbol[];
  relationships: ParsedRelationship[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  assignments: ExtractedAssignment[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  fetchCalls: ExtractedFetchCall[];
  decoratorRoutes: ExtractedDecoratorRoute[];
  toolDefs: ExtractedToolDef[];
  ormQueries: ExtractedORMQuery[];
  constructorBindings: FileConstructorBindings[];
  typeEnvBindings: FileTypeEnvBindings[];
}

export interface CacheSplitResult {
  /** Files whose cached parse results can be reused verbatim. */
  hits: PerFileParseData[];
  /** Files needing fresh parse (+ their content hashes, for post-parse caching). */
  misses: Array<{ path: string; content: string; contentHash: string }>;
}

/**
 * Look up each file's content hash in the cache. Hits return the cached
 * PerFileParseData (already deserialized). Misses carry the content hash
 * forward so we can persist the fresh result later.
 */
export function splitCachedVsFresh(
  cache: IncrementalCache,
  files: Array<{ path: string; content: string }>,
): CacheSplitResult {
  const hits: PerFileParseData[] = [];
  const misses: CacheSplitResult['misses'] = [];

  for (const file of files) {
    const contentHash = hashFileContent(file.content);
    const entry: FileCacheEntry | null = cache.getFileByHash(file.path, contentHash);
    if (!entry) {
      misses.push({ path: file.path, content: file.content, contentHash });
      continue;
    }
    try {
      const data = JSON.parse(entry.parse_payload) as PerFileParseData;
      // Guard against shape drift: if required arrays are missing, treat as miss.
      if (Array.isArray(data?.nodes) && Array.isArray(data?.symbols)) {
        hits.push(data);
      } else {
        misses.push({ path: file.path, content: file.content, contentHash });
      }
    } catch {
      // Payload corruption — treat as miss.
      misses.push({ path: file.path, content: file.content, contentHash });
    }
  }

  return { hits, misses };
}

/**
 * Apply a batch of cached per-file parse data to the live graph / symbol
 * table. Mirrors the mutation logic in processParsingWithWorkers.
 */
export function applyCachedResults(
  graph: KnowledgeGraph,
  symbolTable: SymbolTable,
  hits: PerFileParseData[],
): void {
  for (const data of hits) {
    for (const node of data.nodes) {
      graph.addNode({
        id: node.id,
        label: node.label as NodeLabel,
        properties: node.properties,
      });
    }
    for (const rel of data.relationships) {
      graph.addRelationship(rel);
    }
    for (const sym of data.symbols) {
      symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type, {
        parameterCount: sym.parameterCount,
        requiredParameterCount: sym.requiredParameterCount,
        parameterTypes: sym.parameterTypes,
        returnType: sym.returnType,
        declaredType: sym.declaredType,
        ownerId: sym.ownerId,
      });
    }
  }
}

/**
 * Split a merged ParseWorkerResult back into per-file payloads. Each item
 * in any array carries a filePath which tells us which bucket it belongs to.
 * Items without a filePath are skipped (rare but possible for synthetic
 * nodes).
 */
/**
 * Build a global node-id → filePath map from every worker's result in a
 * chunk. Pass to splitResultByFile so cross-worker relationships aren't
 * dropped.
 */
export function buildGlobalNodeFileMap(results: ParseWorkerResult[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of results) {
    for (const node of r.nodes) {
      const fp = (node.properties?.filePath as string | undefined) ?? null;
      if (fp) map.set(node.id, fp);
    }
  }
  return map;
}

export function splitResultByFile(
  result: ParseWorkerResult,
  /**
   * Optional global node→file map built from ALL worker results. Use this
   * when splitting results from a multi-worker batch — a relationship whose
   * `sourceId` belongs to a node produced by a different worker would
   * otherwise be silently dropped, because per-result nodes can't resolve
   * cross-worker source ids. On dolt this was losing ~26% of relations.
   */
  globalNodeFileById?: Map<string, string>,
): Map<string, PerFileParseData> {
  const map = new Map<string, PerFileParseData>();
  const get = (filePath: string): PerFileParseData => {
    let bucket = map.get(filePath);
    if (!bucket) {
      bucket = {
        filePath,
        nodes: [],
        symbols: [],
        relationships: [],
        imports: [],
        calls: [],
        assignments: [],
        heritage: [],
        routes: [],
        fetchCalls: [],
        decoratorRoutes: [],
        toolDefs: [],
        ormQueries: [],
        constructorBindings: [],
        typeEnvBindings: [],
      };
      map.set(filePath, bucket);
    }
    return bucket;
  };

  for (const node of result.nodes) {
    const fp = (node.properties?.filePath as string | undefined) ?? null;
    if (!fp) continue;
    get(fp).nodes.push(node);
  }
  for (const sym of result.symbols) {
    if (!sym.filePath) continue;
    get(sym.filePath).symbols.push(sym);
  }
  // Relationships don't store filePath directly; infer via sourceId's owning
  // file. Prefer the global node map when provided (covers cross-worker
  // source refs), else fall back to this result's own nodes.
  const nodeFileById = globalNodeFileById ?? new Map<string, string>();
  if (!globalNodeFileById) {
    for (const node of result.nodes) {
      const fp = (node.properties?.filePath as string | undefined) ?? null;
      if (fp) nodeFileById.set(node.id, fp);
    }
  }
  for (const rel of result.relationships) {
    // Prefer source's file; fall back to target's file. DEFINES relationships
    // source from a File node that wasn't part of the worker's output (File
    // nodes are created by structure-processor before parsing), so their
    // sourceId isn't in nodeFileById. Using the target (the defined symbol,
    // which does have filePath) attributes the relationship correctly.
    const fp = nodeFileById.get(rel.sourceId) ?? nodeFileById.get(rel.targetId);
    if (!fp) continue;
    get(fp).relationships.push(rel);
  }
  for (const item of result.imports) {
    if (item.filePath) get(item.filePath).imports.push(item);
  }
  for (const item of result.calls) {
    if (item.filePath) get(item.filePath).calls.push(item);
  }
  for (const item of result.assignments) {
    if (item.filePath) get(item.filePath).assignments.push(item);
  }
  for (const item of result.heritage) {
    if (item.filePath) get(item.filePath).heritage.push(item);
  }
  for (const item of result.routes) {
    if (item.filePath) get(item.filePath).routes.push(item);
  }
  for (const item of result.fetchCalls) {
    if (item.filePath) get(item.filePath).fetchCalls.push(item);
  }
  for (const item of result.decoratorRoutes) {
    if (item.filePath) get(item.filePath).decoratorRoutes.push(item);
  }
  for (const item of result.toolDefs) {
    if (item.filePath) get(item.filePath).toolDefs.push(item);
  }
  for (const item of result.ormQueries ?? []) {
    if (item.filePath) get(item.filePath).ormQueries.push(item);
  }
  for (const item of result.constructorBindings) {
    if (item.filePath) get(item.filePath).constructorBindings.push(item);
  }
  for (const item of result.typeEnvBindings) {
    if (item.filePath) get(item.filePath).typeEnvBindings.push(item);
  }

  return map;
}

/**
 * Persist each file's parse data to cache. Called after fresh parsing.
 * Takes the mtime via fs.statSync so we can short-circuit hash checks on
 * subsequent runs when mtime is unchanged.
 */
export function persistParsedFiles(
  cache: IncrementalCache,
  perFile: Map<string, PerFileParseData>,
  contentHashByPath: Map<string, string>,
): number {
  let persisted = 0;
  for (const [filePath, data] of perFile) {
    const contentHash = contentHashByPath.get(filePath);
    if (!contentHash) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      // absolute vs relative path; fall back to 0
    }
    cache.putFile({
      path: filePath,
      content_hash: contentHash,
      mtime_ms: mtimeMs,
      parse_payload: JSON.stringify(data),
    });
    persisted += 1;
  }
  return persisted;
}

/** SHA-256 truncated to 40 chars, matching IncrementalCache.hashContent. */
export function hashFileContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 40);
}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import lbug, { type LbugValue, type QueryResult } from '@ladybugdb/core';
import { jsonString, quoteCypher } from './escaping.js';
import type { GraphFacts, SemanticArtifactFact } from './types.js';
import { withCrossProcessLock } from './cross-process-lock.js';

type Row = Record<string, LbugValue>;
type SemanticLayer = SemanticArtifactFact['layer'];

const DELETED_LAYER = '__deleted__';
const SEMANTIC_LAYERS = new Set<SemanticLayer>([
  'module',
  'concept',
  'contract',
  'flow',
  'concern',
  'concern_family',
  'canonical_path',
  'symmetry_edge',
  'closure_set',
  'abstraction_opportunity',
  'decision_override',
]);
const CODE_NODE_LABELS = [
  'Project',
  'Package',
  'Module',
  'Folder',
  'File',
  'Class',
  'Function',
  'Method',
  'Variable',
  'Interface',
  'Enum',
  'Decorator',
  'Import',
  'Type',
  'CodeElement',
  'Community',
  'Process',
  'Struct',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Section',
  'Route',
  'Tool',
];
const TYPED_NODE_LABELS = CODE_NODE_LABELS;
const TYPED_NODE_LABEL_SET = new Set(TYPED_NODE_LABELS);

export interface GraphTruthStoreOptions {
  dbPath: string;
  readOnly?: boolean;
}

export interface CodeNodeContextResult {
  id: string;
  label: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  properties: Record<string, unknown>;
  outgoing: Array<{ to: string; label: string; name: string; filePath: string; type: string; confidence: number; reason: string; step: number }>;
  incoming: Array<{ from: string; label: string; name: string; filePath: string; type: string; confidence: number; reason: string; step: number }>;
  processes: Array<{ id: string; label: string; step: number }>;
}

export interface RouteMapResult {
  id: string;
  path: string;
  method: string;
  filePath: string;
  responseKeys: string[];
  middleware: string[];
  handlers: Array<{ id: string; label: string; name: string; filePath: string }>;
  consumers: Array<{ id: string; label: string; name: string; filePath: string; accessedKeys: string[]; confidence: 'high' | 'low' }>;
}

export interface ToolMapResult {
  id: string;
  name: string;
  filePath: string;
  description: string;
  handlers: Array<{ id: string; label: string; name: string; filePath: string }>;
}

export interface CodeSearchResult {
  id: string;
  label: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
}

export function semanticArtifactKey(layer: SemanticLayer, id: string): string {
  return `${layer}:${encodeURIComponent(id)}`;
}

// LadybugDB's open takes an exclusive file lock. Reads that race a writer
// fail with "Could not set lock on file". This is a bounded sync retry —
// short (≤8 attempts, ≤40ms total) because (1) the real serialization lives
// in the write queue, (2) the async queue itself is what should prevent
// contention. If we land here, something else is concurrent; propagate
// rather than block the event loop indefinitely.
function withLockRetry<T>(label: string, fn: () => T): T {
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retriable = /Could not set lock|already open|IO exception|lock|busy/i.test(msg);
      if (!retriable || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }
      // Brief busy-wait (≤5ms) to let the holder complete. Longer than this
      // and we should just fail — indicates upstream didn't serialize.
      const sleepMs = Math.min(5, 1 + attempt);
      const wakeAt = Date.now() + sleepMs;
      while (Date.now() < wakeAt) {
        // busy-wait (single-thread JS: cannot yield)
      }
    }
  }
  throw new Error(`${label}: unreachable`);
}

export function readSemanticArtifactsSync(dbPath: string, layer?: SemanticLayer): SemanticArtifactFact[] {
  if (!fs.existsSync(dbPath)) return [];
  return withLockRetry(`read ${layer ?? 'all'}`, () => {
    const db = new lbug.Database(dbPath, 0, true, true);
    const conn = new lbug.Connection(db);
    try {
      const where = layer ? `WHERE a.layer = '${quoteCypher(layer)}'` : '';
      const result = conn.querySync(
        `MATCH (a:SemanticArtifact) ${where} RETURN a.id AS id, a.layer AS layer, a.structHash AS structHash, a.payload AS payload ORDER BY id`,
      ) as QueryResult;
      return getAllAndCloseSync(result)
        .filter((row) => SEMANTIC_LAYERS.has(row.layer as SemanticLayer))
        .map((row) => ({
          id: String(row.id),
          layer: row.layer as SemanticArtifactFact['layer'],
          structHash: String(row.structHash ?? ''),
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        }));
    } finally {
      try { conn.closeSync(); } catch {}
      try { db.closeSync(); } catch {}
    }
  });
}

export function readSemanticArtifactSync(dbPath: string, layer: SemanticLayer, id: string): SemanticArtifactFact | null {
  if (!fs.existsSync(dbPath)) return null;
  return withLockRetry(`read ${layer}/${id}`, () => {
    const db = new lbug.Database(dbPath, 0, true, true);
    const conn = new lbug.Connection(db);
    try {
      const key = semanticArtifactKey(layer, id);
      const result = conn.querySync(
        `MATCH (a:SemanticArtifact {key:'${quoteCypher(key)}'}) WHERE a.layer = '${quoteCypher(layer)}' RETURN a.id AS id, a.layer AS layer, a.structHash AS structHash, a.payload AS payload`,
      ) as QueryResult;
      const row = getAllAndCloseSync(result)[0];
      if (!row) return null;
      return {
        id: String(row.id),
        layer: row.layer as SemanticLayer,
        structHash: String(row.structHash ?? ''),
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      };
    } finally {
      try { conn.closeSync(); } catch {}
      try { db.closeSync(); } catch {}
    }
  });
}

// Core writer: opens LBug, does one upsert, closes. Wrapped in lock-retry
// because even without concurrent writers a read on another connection can
// still race the open window.
export function writeSemanticArtifactSync(dbPath: string, artifact: SemanticArtifactFact): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  withLockRetry(`write ${artifact.layer}/${artifact.id}`, () => {
    const db = new lbug.Database(dbPath);
    const conn = new lbug.Connection(db);
    try {
      ensureSemanticArtifactSchemaSync(conn);
      upsertSemanticArtifactOnConn(conn, artifact);
    } finally {
      try { conn.closeSync(); } catch {}
      try { db.closeSync(); } catch {}
    }
  });
}

/**
 * Batch upsert: opens LBug ONCE, writes N artifacts, closes ONCE. Dramatically
 * reduces lock-hold + syscall overhead relative to N separate
 * writeSemanticArtifactSync calls. Used by the async queue to drain bursts
 * of parallel writes from enrichment sessions.
 */
export function writeSemanticArtifactsBatchSync(dbPath: string, artifacts: SemanticArtifactFact[]): void {
  if (artifacts.length === 0) return;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  withLockRetry(`batch ${artifacts.length}`, () => {
    const db = new lbug.Database(dbPath);
    const conn = new lbug.Connection(db);
    try {
      ensureSemanticArtifactSchemaSync(conn);
      for (const artifact of artifacts) {
        upsertSemanticArtifactOnConn(conn, artifact);
      }
    } finally {
      try { conn.closeSync(); } catch {}
      try { db.closeSync(); } catch {}
    }
  });
}

function upsertSemanticArtifactOnConn(
  conn: InstanceType<typeof lbug.Connection>,
  artifact: SemanticArtifactFact,
): void {
  const key = semanticArtifactKey(artifact.layer, artifact.id);
  const rows = (conn.querySync(
    `MATCH (a:SemanticArtifact {key:'${quoteCypher(key)}'}) RETURN a.key AS key`,
  ) as QueryResult);
  const existingRows = getAllAndCloseSync(rows);
  const id = quoteCypher(artifact.id);
  const layer = quoteCypher(artifact.layer);
  const structHash = quoteCypher(artifact.structHash);
  const payload = quoteCypher(jsonString(artifact.payload));
  if (existingRows.length > 0) {
    closeQueryResultSync(conn.querySync(
      `MATCH (a:SemanticArtifact {key:'${quoteCypher(key)}'}) SET a.id = '${id}', a.layer = '${layer}', a.structHash = '${structHash}', a.payload = '${payload}'`,
    ) as QueryResult);
  } else {
    closeQueryResultSync(conn.querySync(
      `CREATE (:SemanticArtifact {key: '${quoteCypher(key)}', id: '${id}', layer: '${layer}', structHash: '${structHash}', payload: '${payload}'})`,
    ) as QueryResult);
  }
}

// Async write queue that **batches** arriving artifacts into a single LBug
// open/close. Multiple parallel writes enqueued within the same microtask
// window are coalesced and flushed via writeSemanticArtifactsBatchSync.
// Benefits: (1) only one exclusive-lock window per burst, (2) amortizes
// the ~5ms open/close cost across N writes.

interface PendingWrite {
  dbPath: string;
  prepare: () => SemanticArtifactFact | null;
  resolve: () => void;
  reject: (err: unknown) => void;
}

let pendingWrites: PendingWrite[] = [];
let drainScheduled = false;

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  // setImmediate lets every queued microtask (all parallel tool-call awaits)
  // land in pendingWrites before we flush — this is what produces the batch.
  setImmediate(() => {
    drainScheduled = false;
    void flushPending();
  });
}

async function flushPending(): Promise<void> {
  if (pendingWrites.length === 0) return;
  const batch = pendingWrites;
  pendingWrites = [];
  // Group by dbPath (in practice always one project = one path).
  const byPath = new Map<string, PendingWrite[]>();
  for (const item of batch) {
    const list = byPath.get(item.dbPath) ?? [];
    list.push(item);
    byPath.set(item.dbPath, list);
  }
  for (const [dbPath, items] of byPath) {
    const artifacts: SemanticArtifactFact[] = [];
    const artifactOwners: PendingWrite[] = [];
    for (const item of items) {
      try {
        const a = item.prepare();
        if (a === null) {
          // Nothing to write for this one; resolve immediately (skipped diff).
          item.resolve();
        } else {
          artifacts.push(a);
          artifactOwners.push(item);
        }
      } catch (err) {
        item.reject(err);
      }
    }
    if (artifacts.length === 0) continue;
    // Cross-process advisory lock: stops a concurrent `cotx compile` (or
    // another worker) in a separate shell from racing the LBug file open.
    // Intra-process serialization is already handled by this queue; the
    // flock sits one layer below that for inter-process safety.
    try {
      await withCrossProcessLock(dbPath, () => {
        writeSemanticArtifactsBatchSync(dbPath, artifacts);
      });
      for (const owner of artifactOwners) owner.resolve();
    } catch (err) {
      for (const owner of artifactOwners) owner.reject(err);
    }
  }
  // If more writes arrived while we were flushing, keep draining.
  if (pendingWrites.length > 0) scheduleDrain();
}

/**
 * Two modes:
 * - Pass `artifact` directly and no prepare: writes that exact artifact.
 * - Pass `artifact=null` and `prepare`: `prepare` is invoked inside the
 *   batched flush and may do reads + return either an artifact to write
 *   or null to skip.
 */
export function writeSemanticArtifact(
  dbPath: string,
  artifact: SemanticArtifactFact | null,
  prepare?: () => SemanticArtifactFact | null,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    pendingWrites.push({
      dbPath,
      prepare: prepare ?? (() => artifact),
      resolve,
      reject,
    });
    scheduleDrain();
  });
}

export function deleteSemanticArtifactSync(dbPath: string, layer: SemanticLayer, id: string): void {
  if (!fs.existsSync(dbPath)) return;
  const db = new lbug.Database(dbPath);
  const conn = new lbug.Connection(db);
  try {
    const key = semanticArtifactKey(layer, id);
    closeQueryResultSync(conn.querySync(
      `MATCH (a:SemanticArtifact {key:'${quoteCypher(key)}'}) SET a.layer = '${DELETED_LAYER}', a.payload = ''`,
    ) as QueryResult);
  } finally {
    try { conn.closeSync(); } catch {}
    try { db.closeSync(); } catch {}
  }
}

export class GraphTruthStore {
  private readonly dbPath: string;
  private readonly readOnly: boolean;
  private db: InstanceType<typeof lbug.Database> | null = null;
  private conn: InstanceType<typeof lbug.Connection> | null = null;

  constructor(options: GraphTruthStoreOptions) {
    this.dbPath = options.dbPath;
    this.readOnly = options.readOnly ?? false;
  }

  async open(): Promise<void> {
    if (this.conn) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    try {
      this.db = new lbug.Database(this.dbPath, 0, true, this.readOnly);
      this.conn = new lbug.Connection(this.db);
      if (!this.readOnly) {
        await this.ensureSchema();
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.conn?.close();
    } finally {
      this.conn = null;
    }
    try {
      await this.db?.close();
    } finally {
      this.db = null;
    }
  }

  async query(cypher: string): Promise<Row[]> {
    if (!this.conn) throw new Error('GraphTruthStore is not open');
    const result = await this.conn.query(cypher);
    if (Array.isArray(result)) {
      const rows = await Promise.all(result.map((item) => this.rowsFromResult(item)));
      return rows.flat();
    }
    return this.rowsFromResult(result);
  }

  async writeFacts(facts: GraphFacts): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-graph-truth-copy-'));
    const codeNodes = facts.codeNodes ?? [];
    const codeRelations = facts.codeRelations ?? [];
    try {
      await this.copyRows(
        dir,
        'code-nodes.csv',
        ['id', 'label', 'name', 'filePath', 'startLine', 'endLine', 'isExported', 'properties'],
        codeNodes.map((item) => [item.id, item.label, item.name, item.filePath, item.startLine, item.endLine, item.isExported, item.properties]),
        'COPY CodeNode(id, label, name, filePath, startLine, endLine, isExported, properties) FROM',
      );
      await this.ensureTypedCodeNodeSchemas(codeNodes);
      await this.copyTypedCodeNodes(dir, codeNodes);
      const labelById = new Map(codeNodes.map((item) => [item.id, item.label]));
      await this.ensureTypedCodeRelationSchema(codeRelations, labelById);
      await this.copyTypedCodeRelations(dir, codeRelations, labelById);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async writeSemanticArtifacts(artifacts: SemanticArtifactFact[]): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-semantic-artifact-copy-'));
    try {
      await this.copyRows(
        dir,
        'semantic-artifacts.csv',
        ['key', 'id', 'layer', 'structHash', 'payload'],
        artifacts.map((item) => [semanticArtifactKey(item.layer, item.id), item.id, item.layer, item.structHash, jsonString(item.payload)]),
        'COPY SemanticArtifact(key, id, layer, structHash, payload) FROM',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── Phase D step 7 groundwork: per-fact upsert / delete API ──────────────
  // These are additional methods intended for the incremental write path
  // (keep .lbug across runs, only touch changed facts). writeFacts still
  // uses COPY for the full-compile path behind --force-full.

  /**
   * Upsert a single CodeNode by id. MATCH+SET on existence, CREATE otherwise.
   * Slow per-fact; callers should batch via upsertCodeNodes when possible.
   */
  async upsertCodeNode(fact: NonNullable<GraphFacts['codeNodes']>[number]): Promise<void> {
    const conn = this.requireConn();
    const props = [
      `label: '${quoteCypher(fact.label)}'`,
      `name: '${quoteCypher(fact.name)}'`,
      `filePath: '${quoteCypher(fact.filePath)}'`,
      `startLine: ${Number(fact.startLine) || 0}`,
      `endLine: ${Number(fact.endLine) || 0}`,
      `isExported: ${Boolean(fact.isExported)}`,
      `properties: '${quoteCypher(fact.properties)}'`,
    ].join(', ');
    const existsResult = conn.querySync(
      `MATCH (n:CodeNode {id: '${quoteCypher(fact.id)}'}) RETURN n.id AS id`,
    ) as QueryResult;
    const existing = getAllAndCloseSync(existsResult);
    if (existing.length > 0) {
      closeQueryResultSync(conn.querySync(
        `MATCH (n:CodeNode {id: '${quoteCypher(fact.id)}'}) SET n.${props.split(', ').join(', n.')}`,
      ) as QueryResult);
    } else {
      closeQueryResultSync(conn.querySync(
        `CREATE (:CodeNode {id: '${quoteCypher(fact.id)}', ${props}})`,
      ) as QueryResult);
    }
  }

  /** Delete a CodeNode + all CodeRelations referencing it. */
  async deleteCodeNodeById(id: string): Promise<void> {
    const conn = this.requireConn();
    closeQueryResultSync(conn.querySync(
      `MATCH (n:CodeNode {id: '${quoteCypher(id)}'})-[r:CodeRelation]-() DELETE r`,
    ) as QueryResult);
    closeQueryResultSync(conn.querySync(
      `MATCH (n:CodeNode {id: '${quoteCypher(id)}'}) DELETE n`,
    ) as QueryResult);
  }

  /** Delete all CodeNodes (and their relations) that live in the given file. */
  async deleteCodeNodesByFilePath(filePath: string): Promise<void> {
    const conn = this.requireConn();
    closeQueryResultSync(conn.querySync(
      `MATCH (n:CodeNode {filePath: '${quoteCypher(filePath)}'})-[r:CodeRelation]-() DELETE r`,
    ) as QueryResult);
    closeQueryResultSync(conn.querySync(
      `MATCH (n:CodeNode {filePath: '${quoteCypher(filePath)}'}) DELETE n`,
    ) as QueryResult);
  }

  /**
   * GC scan: remove CodeRelations whose endpoints no longer exist.
   * LadybugDB has no ON DELETE CASCADE, so deleting CodeNodes individually
   * can leave dangling relations. Run this after a batch of deletes.
   */
  async gcDanglingRelations(): Promise<number> {
    const conn = this.requireConn();
    const countResult = conn.querySync(
      'MATCH ()-[r:CodeRelation]->() WHERE NOT EXISTS { MATCH (n:CodeNode {id: r.from}) } OR NOT EXISTS { MATCH (n:CodeNode {id: r.to}) } RETURN COUNT(r) AS n',
    ) as QueryResult;
    const rows = getAllAndCloseSync(countResult);
    const n = Number(rows[0]?.n ?? 0);
    closeQueryResultSync(conn.querySync(
      'MATCH ()-[r:CodeRelation]->() WHERE NOT EXISTS { MATCH (n:CodeNode {id: r.from}) } OR NOT EXISTS { MATCH (n:CodeNode {id: r.to}) } DELETE r',
    ) as QueryResult);
    return n;
  }

  private requireConn(): { querySync: (q: string) => unknown } {
    const conn = (this as unknown as { conn?: { querySync: (q: string) => unknown } }).conn;
    if (!conn) throw new Error('GraphTruthStore not opened');
    return conn;
  }

  async listSemanticArtifacts(layer?: SemanticArtifactFact['layer']): Promise<SemanticArtifactFact[]> {
    const where = layer ? `WHERE a.layer = '${quoteCypher(layer)}'` : '';
    const rows = await this.query(
      `MATCH (a:SemanticArtifact) ${where} RETURN a.id AS id, a.layer AS layer, a.structHash AS structHash, a.payload AS payload ORDER BY id`,
    );
    return rows.map((row) => ({
      id: String(row.id),
      layer: row.layer as SemanticArtifactFact['layer'],
      structHash: String(row.structHash ?? ''),
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    }));
  }

  async codeNodeContext(nodeId: string): Promise<CodeNodeContextResult | null> {
    const rows = await this.query(
      `MATCH (n:CodeNode {id:'${quoteCypher(nodeId)}'}) RETURN n.id AS id, n.label AS label, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.isExported AS isExported, n.properties AS properties`,
    );
    const node = rows[0];
    if (!node) return null;

    const outgoing = await this.query(
      `MATCH (n {id:'${quoteCypher(nodeId)}'})-[r:CodeRelation]->(t), (m:CodeNode {id:t.id}) RETURN t.id AS id, m.label AS label, m.name AS name, m.filePath AS filePath, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step ORDER BY type, id`,
    );
    const incoming = await this.query(
      `MATCH (s)-[r:CodeRelation]->(n {id:'${quoteCypher(nodeId)}'}), (m:CodeNode {id:s.id}) RETURN s.id AS id, m.label AS label, m.name AS name, m.filePath AS filePath, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step ORDER BY type, id`,
    );
    const processes = await this.query(
      `MATCH (n {id:'${quoteCypher(nodeId)}'})-[r:CodeRelation {type:'STEP_IN_PROCESS'}]->(p), (m:CodeNode {id:p.id}) RETURN p.id AS id, m.name AS name, r.step AS step ORDER BY step, id`,
    );

    return {
      id: String(node.id),
      label: String(node.label ?? ''),
      name: String(node.name ?? ''),
      filePath: String(node.filePath ?? ''),
      startLine: Number(node.startLine ?? 0),
      endLine: Number(node.endLine ?? 0),
      isExported: Boolean(node.isExported ?? false),
      properties: parseJsonObject(node.properties),
      outgoing: outgoing.map((row) => ({
        to: String(row.id),
        label: String(row.label ?? ''),
        name: String(row.name ?? ''),
        filePath: String(row.filePath ?? ''),
        type: String(row.type ?? ''),
        confidence: Number(row.confidence ?? 0),
        reason: String(row.reason ?? ''),
        step: Number(row.step ?? 0),
      })),
      incoming: incoming.map((row) => ({
        from: String(row.id),
        label: String(row.label ?? ''),
        name: String(row.name ?? ''),
        filePath: String(row.filePath ?? ''),
        type: String(row.type ?? ''),
        confidence: Number(row.confidence ?? 0),
        reason: String(row.reason ?? ''),
        step: Number(row.step ?? 0),
      })),
      processes: processes.map((row) => ({
        id: String(row.id),
        label: String(row.name ?? row.id ?? ''),
        step: Number(row.step ?? 0),
      })),
    };
  }

  async codeProcessesForNodes(nodeIds: string[]): Promise<Array<{ nodeId: string; id: string; label: string; step: number }>> {
    const uniqueIds = [...new Set(nodeIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const rows = await this.query(
      `MATCH (n)-[r:CodeRelation {type:'STEP_IN_PROCESS'}]->(p), (m:CodeNode {id:p.id}) WHERE n.id IN [${quoteCypherList(uniqueIds)}] RETURN n.id AS nodeId, p.id AS id, m.name AS name, r.step AS step ORDER BY nodeId, step, id`,
    );
    return rows.map((row) => ({
      nodeId: String(row.nodeId ?? ''),
      id: String(row.id ?? ''),
      label: String(row.name ?? row.id ?? ''),
      step: Number(row.step ?? 0),
    }));
  }

  async codeImpact(nodeId: string, direction: 'upstream' | 'downstream', maxDepth = 3, relationTypes?: string[]): Promise<string[]> {
    return this.codeImpactMany([nodeId], direction, maxDepth, relationTypes);
  }

  async codeImpactMany(nodeIds: string[], direction: 'upstream' | 'downstream', maxDepth = 3, relationTypes?: string[]): Promise<string[]> {
    const uniqueIds = [...new Set(nodeIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const allowed = relationTypes && relationTypes.length > 0 ? new Set(relationTypes) : null;
    const seen = new Set<string>(uniqueIds);
    const impacted = new Set<string>();
    let frontier = uniqueIds;

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      const rows = direction === 'downstream'
        ? await this.query(
            `MATCH (n)-[r:CodeRelation]->(t) WHERE n.id IN [${quoteCypherList(frontier)}] RETURN DISTINCT t.id AS id, r.type AS type ORDER BY id`,
          )
        : await this.query(
            `MATCH (s)-[r:CodeRelation]->(n) WHERE n.id IN [${quoteCypherList(frontier)}] RETURN DISTINCT s.id AS id, r.type AS type ORDER BY id`,
          );
      for (const row of rows) {
        if (allowed && !allowed.has(String(row.type ?? ''))) continue;
        const id = String(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        impacted.add(id);
        next.push(id);
      }
      frontier = next;
    }

    return [...impacted].sort();
  }

  async routeMap(route?: string): Promise<RouteMapResult[]> {
    const where = route ? `WHERE r.name = '${quoteCypher(route)}' OR r.id = '${quoteCypher(route)}'` : '';
    const routes = await this.query(
      `MATCH (r:CodeNode {label:'Route'}) ${where} RETURN r.id AS id, r.name AS name, r.filePath AS filePath, r.properties AS properties ORDER BY name, id`,
    );
    const result: RouteMapResult[] = [];
    for (const row of routes) {
      const id = String(row.id);
      const props = parseJsonObject(row.properties);
      const handlers = await this.query(
        `MATCH (h)-[rel:CodeRelation {type:'HANDLES_ROUTE'}]->(r {id:'${quoteCypher(id)}'}), (m:CodeNode {id:h.id}) RETURN h.id AS id, m.label AS label, m.name AS name, m.filePath AS filePath ORDER BY m.filePath, m.name`,
      );
      const consumers = await this.query(
        `MATCH (c)-[rel:CodeRelation {type:'FETCHES'}]->(r {id:'${quoteCypher(id)}'}), (m:CodeNode {id:c.id}) RETURN c.id AS id, m.label AS label, m.name AS name, m.filePath AS filePath, rel.reason AS reason, rel.confidence AS confidence ORDER BY m.filePath, m.name`,
      );
      result.push({
        id,
        path: String(props.path ?? row.name ?? id),
        method: String(props.method ?? inferMethodFromRoute(String(row.name ?? id))),
        filePath: String(row.filePath ?? ''),
        responseKeys: arrayProp(props.responseKeys),
        middleware: arrayProp(props.middleware),
        handlers: handlers.map((item) => ({
          id: String(item.id),
          label: String(item.label ?? ''),
          name: String(item.name ?? ''),
          filePath: String(item.filePath ?? ''),
        })),
        consumers: consumers.map((item) => ({
          id: String(item.id),
          label: String(item.label ?? ''),
          name: String(item.name ?? ''),
          filePath: String(item.filePath ?? ''),
          accessedKeys: accessedKeysFromReason(String(item.reason ?? '')),
          confidence: Number(item.confidence ?? 0) >= 0.8 ? 'high' : 'low',
        })),
      });
    }
    return result;
  }

  async shapeCheck(route?: string): Promise<Array<RouteMapResult & { missingKeys: string[]; status: 'OK' | 'MISMATCH' }>> {
    const routes = await this.routeMap(route);
    return routes
      .filter((item) => item.responseKeys.length > 0 && item.consumers.length > 0)
      .map((item) => {
        const response = new Set(item.responseKeys);
        const missingKeys = [...new Set(item.consumers.flatMap((consumer) => consumer.accessedKeys.filter((key) => !response.has(key))))].sort();
        return { ...item, missingKeys, status: missingKeys.length > 0 ? 'MISMATCH' : 'OK' };
      });
  }

  async toolMap(tool?: string): Promise<ToolMapResult[]> {
    const where = tool ? `WHERE t.name = '${quoteCypher(tool)}' OR t.id = '${quoteCypher(tool)}'` : '';
    const tools = await this.query(
      `MATCH (t:CodeNode {label:'Tool'}) ${where} RETURN t.id AS id, t.name AS name, t.filePath AS filePath, t.properties AS properties ORDER BY name, id`,
    );
    const result: ToolMapResult[] = [];
    for (const row of tools) {
      const id = String(row.id);
      const props = parseJsonObject(row.properties);
      const handlers = await this.query(
        `MATCH (h)-[rel:CodeRelation {type:'HANDLES_TOOL'}]->(t {id:'${quoteCypher(id)}'}), (m:CodeNode {id:h.id}) RETURN h.id AS id, m.label AS label, m.name AS name, m.filePath AS filePath ORDER BY m.filePath, m.name`,
      );
      result.push({
        id,
        name: String(row.name ?? id),
        filePath: String(row.filePath ?? ''),
        description: String(props.description ?? ''),
        handlers: handlers.map((item) => ({
          id: String(item.id),
          label: String(item.label ?? ''),
          name: String(item.name ?? ''),
          filePath: String(item.filePath ?? ''),
        })),
      });
    }
    return result;
  }

  async searchCodeNodes(query: string | undefined, label: string | undefined, limit = 15): Promise<CodeSearchResult[]> {
    const clauses: string[] = [];
    if (label) clauses.push(`n.label = '${quoteCypher(label)}'`);
    const trimmed = query?.trim();
    if (trimmed) {
      const q = quoteCypher(trimmed);
      clauses.push(`(n.name CONTAINS '${q}' OR n.filePath CONTAINS '${q}' OR n.id CONTAINS '${q}')`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.query(
      `MATCH (n:CodeNode) ${where} RETURN n.id AS id, n.label AS label, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine LIMIT ${Math.max(1, limit * 4)}`,
    );
    return rows
      .map((row) => ({
        id: String(row.id),
        label: String(row.label ?? ''),
        name: String(row.name ?? ''),
        filePath: String(row.filePath ?? ''),
        startLine: Number(row.startLine ?? 0),
        endLine: Number(row.endLine ?? 0),
        score: scoreCodeSearchRow(trimmed, row),
      }))
      .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath) || left.name.localeCompare(right.name))
      .slice(0, limit);
  }

  private async ensureSchema(): Promise<void> {
    const statements = [
      'CREATE NODE TABLE CodeNode(id STRING, label STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, properties STRING, PRIMARY KEY(id))',
      'CREATE NODE TABLE SemanticArtifact(key STRING, id STRING, layer STRING, structHash STRING, payload STRING, PRIMARY KEY(key))',
    ];
    for (const statement of statements) {
      try {
        await this.query(statement);
      } catch (error) {
        if (!String(error).includes('already exists')) throw error;
      }
    }
  }

  private async rowsFromResult(result: QueryResult): Promise<Row[]> {
    try {
      return await result.getAll();
    } finally {
      try { result.close(); } catch {}
    }
  }

  private async copyRows(
    dir: string,
    filename: string,
    header: string[],
    rows: unknown[][],
    copyPrefix: string,
    copyOptions = '(HEADER=true, ESCAPE=\'"\', DELIM=\',\', QUOTE=\'"\', PARALLEL=false, auto_detect=false)',
  ): Promise<void> {
    if (rows.length === 0) return;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(
      filePath,
      `${header.join(',')}\n${rows.map((row) => row.map(csvValue).join(',')).join('\n')}\n`,
      'utf-8',
    );
    await this.query(`${copyPrefix} "${filePath.replaceAll('\\', '/')}" ${copyOptions}`);
  }

  private async copyTypedCodeNodes(dir: string, codeNodes: NonNullable<GraphFacts['codeNodes']>): Promise<void> {
    const byLabel = new Map<string, typeof codeNodes>();
    for (const node of codeNodes) {
      if (!TYPED_NODE_LABEL_SET.has(node.label)) continue;
      const existing = byLabel.get(node.label) ?? [];
      existing.push(node);
      byLabel.set(node.label, existing);
    }
    for (const [label, nodes] of byLabel) {
      await this.copyRows(
        dir,
        `code-node-${label}.csv`,
        ['id', 'name', 'filePath', 'startLine', 'endLine', 'isExported', 'properties'],
        nodes.map((item) => [item.id, item.name, item.filePath, item.startLine, item.endLine, item.isExported, item.properties]),
        `COPY ${tableName(label)}(id, name, filePath, startLine, endLine, isExported, properties) FROM`,
      );
    }
  }

  private async ensureTypedCodeNodeSchemas(codeNodes: NonNullable<GraphFacts['codeNodes']>): Promise<void> {
    const labels = [...new Set(codeNodes.map((node) => node.label).filter((label) => TYPED_NODE_LABEL_SET.has(label)))];
    for (const label of labels) {
      try {
        await this.query(`CREATE NODE TABLE ${tableName(label)}(id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, properties STRING, PRIMARY KEY(id))`);
      } catch (error) {
        if (!String(error).includes('already exists')) throw error;
      }
    }
  }

  private async copyTypedCodeRelations(
    dir: string,
    relations: NonNullable<GraphFacts['codeRelations']>,
    labelById: Map<string, string>,
  ): Promise<void> {
    const byPair = new Map<string, typeof relations>();
    for (const relation of relations) {
      const fromLabel = labelById.get(relation.from);
      const toLabel = labelById.get(relation.to);
      if (!fromLabel || !toLabel || !TYPED_NODE_LABEL_SET.has(fromLabel) || !TYPED_NODE_LABEL_SET.has(toLabel)) continue;
      const key = `${fromLabel}\0${toLabel}`;
      const existing = byPair.get(key) ?? [];
      existing.push(relation);
      byPair.set(key, existing);
    }
    for (const [key, relationsForPair] of byPair) {
      const [fromLabel, toLabel] = key.split('\0');
      await this.copyRows(
        dir,
        `code-relation-${fromLabel}-${toLabel}.csv`,
        ['from', 'to', 'type', 'confidence', 'reason', 'step'],
        relationsForPair.map((item) => [item.from, item.to, item.type, item.confidence, item.reason, item.step]),
        'COPY CodeRelation FROM',
        `(from="${fromLabel}", to="${toLabel}", HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`,
      );
    }
  }

  private async ensureTypedCodeRelationSchema(
    relations: NonNullable<GraphFacts['codeRelations']>,
    labelById: Map<string, string>,
  ): Promise<void> {
    const pairs = [...new Set(relations.flatMap((relation) => {
      const fromLabel = labelById.get(relation.from);
      const toLabel = labelById.get(relation.to);
      if (!fromLabel || !toLabel || !TYPED_NODE_LABEL_SET.has(fromLabel) || !TYPED_NODE_LABEL_SET.has(toLabel)) return [];
      return [`FROM ${tableName(fromLabel)} TO ${tableName(toLabel)}`];
    }))];
    if (pairs.length === 0) return;
    try {
      await this.query(`CREATE REL TABLE CodeRelation(${pairs.join(', ')}, type STRING, confidence DOUBLE, reason STRING, step INT64)`);
    } catch (error) {
      if (!String(error).includes('already exists')) throw error;
    }
  }
}

function ensureSemanticArtifactSchemaSync(conn: InstanceType<typeof lbug.Connection>): void {
  try {
    closeQueryResultSync(conn.querySync('CREATE NODE TABLE SemanticArtifact(key STRING, id STRING, layer STRING, structHash STRING, payload STRING, PRIMARY KEY(key))') as QueryResult);
  } catch (error) {
    if (!String(error).includes('already exists')) throw error;
  }
}

function getAllAndCloseSync(result: QueryResult): Record<string, LbugValue>[] {
  try {
    return result.getAllSync();
  } finally {
    closeQueryResultSync(result);
  }
}

function closeQueryResultSync(result: QueryResult): void {
  try { result.close(); } catch {}
}

function tableName(label: string): string {
  return `\`${label.replaceAll('`', '``')}\``;
}

function csvValue(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function quoteCypherList(values: string[]): string {
  return values.map((value) => `'${quoteCypher(value)}'`).join(', ');
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function arrayProp(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function inferMethodFromRoute(value: string): string {
  const match = value.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i);
  return match ? match[1].toUpperCase() : '';
}

function accessedKeysFromReason(reason: string): string[] {
  const match = reason.match(/keys:([^|]+)/);
  if (!match) return [];
  return match[1].split(',').map((item) => item.trim()).filter(Boolean).sort();
}

function scoreCodeSearchRow(query: string | undefined, row: Record<string, LbugValue>): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const id = String(row.id ?? '').toLowerCase();
  const name = String(row.name ?? '').toLowerCase();
  const filePath = String(row.filePath ?? '').toLowerCase();
  if (name === q || id === q) return 1;
  if (name.includes(q)) return 0.85;
  if (id.includes(q)) return 0.75;
  if (filePath.includes(q)) return 0.55;
  return 0.1;
}

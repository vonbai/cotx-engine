import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createHash } from 'node:crypto';
import {
  deleteSemanticArtifactSync,
  readSemanticArtifactSync,
  readSemanticArtifactsSync,
  writeSemanticArtifact,
  writeSemanticArtifactSync,
} from '../store-v2/graph-truth-store.js';
import type { SemanticArtifactFact } from '../store-v2/types.js';
import type { WorkspaceLayoutScan } from '../compiler/workspace-scan.js';
import type {
  ModuleNode,
  ConceptNode,
  ContractNode,
  FlowNode,
  ConcernNode,
  CotxMeta,
  CotxIndex,
  Annotation,
  ChangeSummary,
  DoctrineData,
  ChangePlanData,
  ChangeReviewData,
  ConcernFamily,
  CanonicalPath,
  SymmetryEdge,
  ClosureSet,
  AbstractionOpportunity,
  DecisionOverride,
} from './schema.js';

const COTX_VERSION = '0.1';
type SemanticLayerDir = 'modules' | 'concepts' | 'contracts' | 'flows' | 'concerns';
type SemanticLayer = SemanticArtifactFact['layer'];
type SemanticNode = (ModuleNode | ConceptNode | ContractNode | FlowNode) & {
  annotations?: Annotation[];
  enriched?: Record<string, unknown>;
};

const SEMANTIC_LAYER_BY_DIR: Record<SemanticLayerDir, SemanticLayer> = {
  modules: 'module',
  concepts: 'concept',
  contracts: 'contract',
  flows: 'flow',
  concerns: 'concern',
};

function isSemanticLayerDir(layer: string): layer is SemanticLayerDir {
  return layer === 'modules' || layer === 'concepts' || layer === 'contracts' || layer === 'flows' || layer === 'concerns';
}

/**
 * Phase D step 10: deep-ish equality check for semantic node payloads to
 * decide whether a write can be skipped. Uses canonical JSON so key-order
 * differences don't trigger spurious writes. Not a strict deep-equal — good
 * enough for the "did anything actually change" question.
 */
function semanticPayloadsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

export class CotxStore {
  private readonly root: string;
  private readonly cotxDir: string;

  constructor(projectRoot: string) {
    this.root = projectRoot;
    this.cotxDir = path.join(projectRoot, '.cotx');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  init(projectName: string): void {
    const dirs = [
      this.cotxDir,
      path.join(this.cotxDir, 'v2'),
      path.join(this.cotxDir, 'graph'),
      path.join(this.cotxDir, 'change-summary'),
      path.join(this.cotxDir, 'doctrine'),
      path.join(this.cotxDir, 'plans'),
      path.join(this.cotxDir, 'reviews'),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const meta: CotxMeta = {
      version: COTX_VERSION,
      project: projectName,
      compiled_at: new Date().toISOString(),
      module_resolution: 'medium',
      stats: { concepts: 0, modules: 0, contracts: 0, flows: 0, concerns: 0 },
    };
    this.writeMeta(meta);
  }

  exists(): boolean {
    return fs.existsSync(this.cotxDir);
  }

  get projectRoot(): string {
    return this.root;
  }

  // ── Meta ───────────────────────────────────────────────────────────────────

  readMeta(): CotxMeta {
    const file = path.join(this.cotxDir, 'meta.yaml');
    const raw = fs.readFileSync(file, 'utf-8');
    return yaml.load(raw) as CotxMeta;
  }

  private writeMeta(meta: CotxMeta): void {
    const file = path.join(this.cotxDir, 'meta.yaml');
    fs.writeFileSync(file, yaml.dump(meta, { lineWidth: -1 }), 'utf-8');
  }

  updateMeta(updates: Partial<CotxMeta>): void {
    const existing = this.readMeta();
    const merged: CotxMeta = { ...existing, ...updates };
    // Deep-merge stats if both sides have it
    if (updates.stats && existing.stats) {
      merged.stats = { ...existing.stats, ...updates.stats };
    }
    this.writeMeta(merged);
  }

  // ── Modules ────────────────────────────────────────────────────────────────

  /** Convert a node ID to a safe filename stem using URL encoding. */
  private idToFilename(id: string): string {
    return encodeURIComponent(id);
  }

  /** Convert a safe filename stem back to a node ID. */
  private filenameToId(filename: string): string {
    return decodeURIComponent(filename);
  }

  /** Public access to filename encoding for index generation. */
  safeFilename(id: string): string {
    return this.idToFilename(id);
  }

  decodeStoredId(filename: string): string {
    return this.filenameToId(filename.replace(/\.yaml$/, ''));
  }

  private semanticDbPath(): string {
    return path.join(this.cotxDir, 'v2', 'truth.lbug');
  }

  // ── Workspace Layout ──────────────────────────────────────────────────────

  writeWorkspaceLayout(layout: WorkspaceLayoutScan): void {
    fs.writeFileSync(
      path.join(this.cotxDir, 'workspace-layout.json'),
      JSON.stringify(layout, null, 2),
      'utf-8',
    );
  }

  readWorkspaceLayout(): WorkspaceLayoutScan | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.cotxDir, 'workspace-layout.json'), 'utf-8')) as WorkspaceLayoutScan;
    } catch {
      return null;
    }
  }

  private readSemanticNode<T extends SemanticNode>(layer: SemanticLayer, id: string): T {
    const artifact = readSemanticArtifactSync(this.semanticDbPath(), layer, id);
    if (!artifact) {
      const error = new Error(`ENOENT: no semantic artifact ${layer}/${id}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return artifact.payload as T;
  }

  private listSemanticNodes(layer: SemanticLayer): string[] {
    return readSemanticArtifactsSync(this.semanticDbPath(), layer).map((artifact) => artifact.id);
  }

  private prepareSemanticWrite<T extends SemanticNode>(
    layer: SemanticLayer,
    data: T,
  ): SemanticArtifactFact | null {
    const existingArtifact = readSemanticArtifactSync(this.semanticDbPath(), layer, data.id);
    const existing = existingArtifact?.payload as T | undefined;
    const annotations: Annotation[] | undefined = data.annotations ?? existing?.annotations;
    const enriched = data.enriched ?? existing?.enriched;
    const toWrite: T = { ...data, annotations, enriched };
    if (!toWrite.annotations) delete toWrite.annotations;
    if (!toWrite.enriched) delete toWrite.enriched;

    // Phase D step 10: differential write. Skip when nothing changed.
    if (
      existingArtifact &&
      existingArtifact.structHash === toWrite.struct_hash &&
      semanticPayloadsEqual(existing, toWrite)
    ) {
      return null;
    }

    return {
      layer,
      id: toWrite.id,
      structHash: toWrite.struct_hash,
      payload: toWrite,
    };
  }

  private writeSemanticNode<T extends SemanticNode>(layer: SemanticLayer, data: T): void {
    const artifact = this.prepareSemanticWrite(layer, data);
    if (!artifact) return;
    writeSemanticArtifactSync(this.semanticDbPath(), artifact);
  }

  /**
   * Async variant of writeSemanticNode: enqueues the ENTIRE read-merge-write
   * sequence through the process-local serialized queue. Keeping the diff
   * check inside the queue matters because it opens LadybugDB for read —
   * concurrent reads against an in-progress write also trip the exclusive
   * lock. Serializing read+write together makes the whole path lock-safe.
   */
  writeSemanticNodeAsync<T extends SemanticNode>(layer: SemanticLayer, data: T): Promise<void> {
    const dbPath = this.semanticDbPath();
    return writeSemanticArtifact(dbPath, null, () => {
      // Runs inside the queue; safe to read + write synchronously.
      return this.prepareSemanticWrite(layer, data);
    });
  }

  deleteSemanticNode(layer: SemanticLayer, id: string): void {
    deleteSemanticArtifactSync(this.semanticDbPath(), layer, id);
  }

  private writeArtifactNode<T extends { id: string }>(layer: SemanticLayer, data: T): void {
    writeSemanticArtifactSync(this.semanticDbPath(), {
      layer,
      id: data.id,
      structHash: this.artifactStructHash(data),
      payload: data,
    });
  }

  private readArtifactNode<T>(layer: SemanticLayer, id: string): T {
    const artifact = readSemanticArtifactSync(this.semanticDbPath(), layer, id);
    if (!artifact) {
      const error = new Error(`ENOENT: no artifact ${layer}/${id}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return artifact.payload as T;
  }

  private listArtifactNodes(layer: SemanticLayer): string[] {
    return readSemanticArtifactsSync(this.semanticDbPath(), layer).map((artifact) => artifact.id);
  }

  private artifactStructHash(data: unknown): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  writeModule(mod: ModuleNode): void {
    this.writeSemanticNode('module', mod);
  }

  writeModuleAsync(mod: ModuleNode): Promise<void> {
    return this.writeSemanticNodeAsync('module', mod);
  }

  writeConceptAsync(concept: ConceptNode): Promise<void> {
    return this.writeSemanticNodeAsync('concept', concept);
  }

  writeContractAsync(contract: ContractNode): Promise<void> {
    return this.writeSemanticNodeAsync('contract', contract);
  }

  writeFlowAsync(flow: FlowNode): Promise<void> {
    return this.writeSemanticNodeAsync('flow', flow);
  }

  readModule(id: string): ModuleNode {
    return this.readSemanticNode<ModuleNode>('module', id);
  }

  listModules(): string[] {
    return this.listSemanticNodes('module');
  }

  /**
   * Bulk-read every semantic artifact in one pass per layer — four LBug
   * queries instead of one-open-per-node. Callers that need more than 1
   * or 2 semantic nodes should prefer this over listX().map(readX).
   *
   * LadybugDB takes an exclusive file lock on each open, so a thousand
   * per-node reads compound into seconds-to-minutes and trip the async
   * write queue into lock contention. One bulk read per layer is the
   * canonical fix and matches the pattern we use in enrichment context,
   * delta detection, and embedding builds.
   */
  loadAllSemanticArtifacts(): {
    modules: ModuleNode[];
    concepts: ConceptNode[];
    contracts: ContractNode[];
    flows: FlowNode[];
  } {
    const dbPath = this.semanticDbPath();
    return {
      modules: readSemanticArtifactsSync(dbPath, 'module').map((a) => a.payload as ModuleNode),
      concepts: readSemanticArtifactsSync(dbPath, 'concept').map((a) => a.payload as ConceptNode),
      contracts: readSemanticArtifactsSync(dbPath, 'contract').map((a) => a.payload as ContractNode),
      flows: readSemanticArtifactsSync(dbPath, 'flow').map((a) => a.payload as FlowNode),
    };
  }

  // ── Concepts ───────────────────────────────────────────────────────────────

  writeConcept(concept: ConceptNode): void {
    this.writeSemanticNode('concept', concept);
  }

  readConcept(id: string): ConceptNode {
    return this.readSemanticNode<ConceptNode>('concept', id);
  }

  listConcepts(): string[] {
    return this.listSemanticNodes('concept');
  }

  // ── Contracts ──────────────────────────────────────────────────────────────

  writeContract(contract: ContractNode): void {
    this.writeSemanticNode('contract', contract);
  }

  readContract(id: string): ContractNode {
    return this.readSemanticNode<ContractNode>('contract', id);
  }

  listContracts(): string[] {
    return this.listSemanticNodes('contract');
  }

  // ── Flows ──────────────────────────────────────────────────────────────────

  writeFlow(flow: FlowNode): void {
    this.writeSemanticNode('flow', flow);
  }

  readFlow(id: string): FlowNode {
    return this.readSemanticNode<FlowNode>('flow', id);
  }

  listFlows(): string[] {
    return this.listSemanticNodes('flow');
  }

  // ── Concerns ───────────────────────────────────────────────────────────────

  writeConcern(concern: ConcernNode): void {
    this.writeArtifactNode('concern', concern);
  }

  readConcern(id: string): ConcernNode {
    return this.readArtifactNode('concern', id);
  }

  listConcerns(): string[] {
    return this.listArtifactNodes('concern');
  }

  // ── Decision Plane Truth Artifacts ────────────────────────────────────────

  writeConcernFamily(data: ConcernFamily): void {
    this.writeArtifactNode('concern_family', data);
  }

  readConcernFamily(id: string): ConcernFamily {
    return this.readArtifactNode('concern_family', id);
  }

  listConcernFamilies(): string[] {
    return this.listArtifactNodes('concern_family');
  }

  writeCanonicalPath(data: CanonicalPath): void {
    this.writeArtifactNode('canonical_path', data);
  }

  readCanonicalPath(id: string): CanonicalPath {
    return this.readArtifactNode('canonical_path', id);
  }

  listCanonicalPaths(): string[] {
    return this.listArtifactNodes('canonical_path');
  }

  writeSymmetryEdge(data: SymmetryEdge): void {
    this.writeArtifactNode('symmetry_edge', data);
  }

  readSymmetryEdge(id: string): SymmetryEdge {
    return this.readArtifactNode('symmetry_edge', id);
  }

  listSymmetryEdges(): string[] {
    return this.listArtifactNodes('symmetry_edge');
  }

  writeClosureSet(data: ClosureSet): void {
    this.writeArtifactNode('closure_set', data);
  }

  readClosureSet(id: string): ClosureSet {
    return this.readArtifactNode('closure_set', id);
  }

  listClosureSets(): string[] {
    return this.listArtifactNodes('closure_set');
  }

  writeAbstractionOpportunity(data: AbstractionOpportunity): void {
    this.writeArtifactNode('abstraction_opportunity', data);
  }

  readAbstractionOpportunity(id: string): AbstractionOpportunity {
    return this.readArtifactNode('abstraction_opportunity', id);
  }

  listAbstractionOpportunities(): string[] {
    return this.listArtifactNodes('abstraction_opportunity');
  }

  writeDecisionOverride(data: DecisionOverride): void {
    this.writeArtifactNode('decision_override', data);
  }

  readDecisionOverride(id: string): DecisionOverride {
    return this.readArtifactNode('decision_override', id);
  }

  listDecisionOverrides(): string[] {
    return this.listArtifactNodes('decision_override');
  }

  // ── Garbage collection ────────────────────────────────────────────────────

  /**
   * Delete YAML files in a layer directory that are not in the valid ID set.
   * Called after each compile phase to remove nodes that no longer exist.
   */
  pruneStale(layer: string, validIds: Set<string>): void {
    if (isSemanticLayerDir(layer)) {
      const semanticLayer = SEMANTIC_LAYER_BY_DIR[layer];
      for (const id of this.listSemanticNodes(semanticLayer)) {
        if (!validIds.has(id)) {
          deleteSemanticArtifactSync(this.semanticDbPath(), semanticLayer, id);
        }
      }
      return;
    }

    const dir = path.join(this.cotxDir, layer);
    if (!fs.existsSync(dir)) return;

    const validFilenames = new Set([...validIds].map((id) => `${this.idToFilename(id)}.yaml`));

    for (const filename of fs.readdirSync(dir)) {
      if (filename.endsWith('.yaml') && !validFilenames.has(filename)) {
        fs.unlinkSync(path.join(dir, filename));
      }
    }
  }

  // ── Graph files ────────────────────────────────────────────────────────────

  writeGraphFile(filename: string, lines: string[]): void {
    const file = path.join(this.cotxDir, 'graph', filename);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  }

  // ── Index ──────────────────────────────────────────────────────────────────

  writeIndex(index: CotxIndex): void {
    const file = path.join(this.cotxDir, 'index.json');
    fs.writeFileSync(file, JSON.stringify(index, null, 2), 'utf-8');
  }

  readIndex(): CotxIndex {
    const file = path.join(this.cotxDir, 'index.json');
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as CotxIndex;
  }

  // ── Operation Log ──────────────────────────────────────────────────────────

  appendLog(entry: { operation: string; affected_nodes?: string[]; summary: string }): void {
    const logPath = path.join(this.cotxDir, 'log.jsonl');
    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  }

  // ── Change Summary ────────────────────────────────────────────────────────

  writeLatestChangeSummary(summary: ChangeSummary): void {
    const dir = path.join(this.cotxDir, 'change-summary');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(summary, null, 2), 'utf-8');
  }

  readLatestChangeSummary(): ChangeSummary | null {
    try {
      const raw = fs.readFileSync(path.join(this.cotxDir, 'change-summary', 'latest.json'), 'utf-8');
      return JSON.parse(raw) as ChangeSummary;
    } catch {
      return null;
    }
  }

  appendChangeSummary(summary: ChangeSummary): void {
    const dir = path.join(this.cotxDir, 'change-summary');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(summary) + '\n', 'utf-8');
  }

  // ── Doctrine / Plan / Review ─────────────────────────────────────────────

  writeDoctrine(data: DoctrineData): void {
    const dir = path.join(this.cotxDir, 'doctrine');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compiled.yaml'), yaml.dump(data, { lineWidth: -1 }), 'utf-8');
  }

  readDoctrine(): DoctrineData | null {
    try {
      const raw = fs.readFileSync(path.join(this.cotxDir, 'doctrine', 'compiled.yaml'), 'utf-8');
      return yaml.load(raw) as DoctrineData;
    } catch {
      return null;
    }
  }

  writeLatestPlan(data: ChangePlanData): void {
    const dir = path.join(this.cotxDir, 'plans');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'latest.yaml'), yaml.dump(data, { lineWidth: -1 }), 'utf-8');
  }

  readLatestPlan(): ChangePlanData | null {
    try {
      const raw = fs.readFileSync(path.join(this.cotxDir, 'plans', 'latest.yaml'), 'utf-8');
      return yaml.load(raw) as ChangePlanData;
    } catch {
      return null;
    }
  }

  appendPlan(data: ChangePlanData): void {
    const dir = path.join(this.cotxDir, 'plans');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(data) + '\n', 'utf-8');
  }

  writeLatestReview(data: ChangeReviewData): void {
    const dir = path.join(this.cotxDir, 'reviews');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'latest.yaml'), yaml.dump(data, { lineWidth: -1 }), 'utf-8');
  }

  readLatestReview(): ChangeReviewData | null {
    try {
      const raw = fs.readFileSync(path.join(this.cotxDir, 'reviews', 'latest.yaml'), 'utf-8');
      return yaml.load(raw) as ChangeReviewData;
    } catch {
      return null;
    }
  }

  appendReview(data: ChangeReviewData): void {
    const dir = path.join(this.cotxDir, 'reviews');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(data) + '\n', 'utf-8');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

}

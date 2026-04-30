import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { createIgnoreFilter } from '../config/ignore-service.js';
import type { GraphNode } from '../core/export/json-exporter.js';
import { DecisionRuleIndex } from './decision-rule-index.js';
import { GraphTruthStore } from './graph-truth-store.js';
import { projectStorageV2Facts, type StorageV2ProjectionInput } from './projections.js';

export interface StorageV2WriteResult {
  graph: {
    nodes: number;
    relations: number;
  };
  semanticArtifacts: {
    modules: number;
    concepts: number;
    contracts: number;
    flows: number;
  };
  decisions: {
    canonical: number;
    symmetry: number;
    closures: number;
    closureMembers: number;
    abstractions: number;
  };
}

const SUPPLEMENTAL_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.rb',
  '.swift',
  '.dart',
  '.vue',
  '.svelte',
]);

export async function writeStorageV2(projectRoot: string, input: StorageV2ProjectionInput): Promise<StorageV2WriteResult> {
  const mark = storageProfiler();
  const projection = projectStorageV2Facts({
    ...input,
    nodes: await withSupplementalSourceFileNodes(projectRoot, input.nodes),
  });
  mark('project storage v2 facts');
  const v2Dir = path.join(projectRoot, '.cotx', 'v2');
  fs.mkdirSync(v2Dir, { recursive: true });

  // Phase D step 7 integration (pragmatic): hash the entire projection and
  // skip reset+COPY entirely when the hash matches the previous write. This
  // handles the common case where nothing semantic has changed (re-running
  // compile on the same working tree) without rewriting the store API.
  //
  // When facts DO change, the short-circuit is missed and we take the legacy
  // reset+COPY path, which is still the fastest option for large writes.
  // True per-fact upsert (using the API from step 7 groundwork) would let us
  // touch only changed rows; wiring it needs the dirty-set plumbing to tell
  // us which facts differ. Future step.
  const projectionHash = hashProjection(projection);
  const hashFile = path.join(v2Dir, '.projection-hash');
  const skipWrite =
    process.env.COTX_FORCE_FULL !== '1' &&
    fs.existsSync(hashFile) &&
    (() => {
      try {
        return fs.readFileSync(hashFile, 'utf-8').trim() === projectionHash;
      } catch {
        return false;
      }
    })() &&
    fs.existsSync(path.join(v2Dir, 'truth.lbug')) &&
    fs.existsSync(path.join(v2Dir, 'rules.db'));

  if (skipWrite) {
    mark('storage v2 projection unchanged — skipping write');
    return {
      graph: {
        nodes: projection.graph.codeNodes.length,
        relations: projection.graph.codeRelations.length,
      },
      semanticArtifacts: {
        modules: projection.semanticArtifacts.filter((item) => item.layer === 'module').length,
        concepts: projection.semanticArtifacts.filter((item) => item.layer === 'concept').length,
        contracts: projection.semanticArtifacts.filter((item) => item.layer === 'contract').length,
        flows: projection.semanticArtifacts.filter((item) => item.layer === 'flow').length,
      },
      decisions: {
        canonical: projection.decisions.canonical.length,
        symmetry: projection.decisions.symmetry.length,
        closures: projection.decisions.closures.length,
        closureMembers: projection.decisions.closureMembers.length,
        abstractions: projection.decisions.abstractions.length,
      },
    };
  }

  resetLadybug(path.join(v2Dir, 'truth.lbug'));
  resetFile(path.join(v2Dir, 'rules.db'));
  clearLegacyYamlArtifacts(projectRoot);
  mark('reset storage v2 files');

  const graphStore = new GraphTruthStore({ dbPath: path.join(v2Dir, 'truth.lbug') });
  await graphStore.open();
  mark('open graph truth store');
  try {
    await graphStore.writeFacts(projection.graph);
    mark('write graph facts');
    await graphStore.writeSemanticArtifacts(projection.semanticArtifacts);
    mark('write semantic artifacts');
  } finally {
    await graphStore.close();
  }
  mark('close graph truth store');

  const ruleIndex = new DecisionRuleIndex({ dbPath: path.join(v2Dir, 'rules.db') });
  await ruleIndex.open();
  mark('open decision rule index');
  try {
    await ruleIndex.writeFacts(projection.decisions);
    mark('write decision rule facts');
  } finally {
    ruleIndex.close();
  }
  mark('close decision rule index');

  // Persist the projection hash so the next compile with identical facts can
  // short-circuit via the skipWrite branch above.
  try {
    fs.writeFileSync(hashFile, projectionHash, 'utf-8');
  } catch {
    // best-effort; stale hash just means we'll rewrite next time
  }

  return {
    graph: {
      nodes: projection.graph.codeNodes.length,
      relations: projection.graph.codeRelations.length,
    },
    semanticArtifacts: {
      modules: projection.semanticArtifacts.filter((item) => item.layer === 'module').length,
      concepts: projection.semanticArtifacts.filter((item) => item.layer === 'concept').length,
      contracts: projection.semanticArtifacts.filter((item) => item.layer === 'contract').length,
      flows: projection.semanticArtifacts.filter((item) => item.layer === 'flow').length,
    },
    decisions: {
      canonical: projection.decisions.canonical.length,
      symmetry: projection.decisions.symmetry.length,
      closures: projection.decisions.closures.length,
      closureMembers: projection.decisions.closureMembers.length,
      abstractions: projection.decisions.abstractions.length,
    },
  };
}

/**
 * Hash the projected facts for Phase D step 7: a stable fingerprint that's
 * identical iff every fact is identical (by id + structural payload). Used
 * to short-circuit storage writes when nothing semantic has changed.
 */
function hashProjection(projection: ReturnType<typeof projectStorageV2Facts>): string {
  const hash = createHash('sha256');
  // Hash each fact category in a sorted, canonical form.
  hashSortedById(hash, projection.graph.codeNodes, 'code-nodes');
  // Relations have composite keys (from, to, type); serialize each.
  const rels = [...projection.graph.codeRelations].sort((a, b) => {
    const k1 = `${a.from}\0${a.to}\0${a.type}`;
    const k2 = `${b.from}\0${b.to}\0${b.type}`;
    return k1.localeCompare(k2);
  });
  hash.update('code-relations\n');
  for (const r of rels) {
    hash.update(`${r.from}\0${r.to}\0${r.type}\0${r.confidence}\0${r.reason ?? ''}\0${r.step ?? ''}\n`);
  }
  hashSortedById(hash, projection.semanticArtifacts, 'semantic-artifacts');
  hashSortedById(hash, projection.decisions.canonical, 'canonical');
  hashSortedById(hash, projection.decisions.symmetry, 'symmetry');
  hashSortedById(hash, projection.decisions.closures, 'closures');
  hashSortedById(hash, projection.decisions.closureMembers, 'closure-members');
  hashSortedById(hash, projection.decisions.abstractions, 'abstractions');
  return hash.digest('hex').slice(0, 32);
}

function hashSortedById(
  hash: import('node:crypto').Hash,
  items: readonly unknown[],
  label: string,
): void {
  hash.update(`${label}\n`);
  const sorted = [...items].sort((a, b) => {
    const ka = (a as { id?: string; key?: string }).id ?? (a as { key?: string }).key ?? '';
    const kb = (b as { id?: string; key?: string }).id ?? (b as { key?: string }).key ?? '';
    return String(ka).localeCompare(String(kb));
  });
  for (const item of sorted) {
    hash.update(canonicalJson(item));
    hash.update('\n');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') +
    '}'
  );
}

function storageProfiler(): (label: string) => void {
  if (!process.env.COTX_PROFILE) return () => {};
  let last = Date.now();
  return (label: string): void => {
    const now = Date.now();
    console.log(`  [profile:storage-v2] ${label}: ${((now - last) / 1000).toFixed(3)}s`);
    last = now;
  };
}

function resetLadybug(dbPath: string): void {
  resetFile(dbPath);
  resetFile(`${dbPath}.wal`);
  resetFile(`${dbPath}.lock`);
}

function resetFile(filePath: string): void {
  fs.rmSync(filePath, { recursive: true, force: true });
}

function clearLegacyYamlArtifacts(projectRoot: string): void {
  const cotxDir = path.join(projectRoot, '.cotx');
  for (const layer of [
    'modules',
    'concepts',
    'contracts',
    'flows',
    'concerns',
    'concern-families',
    'canonical-paths',
    'symmetry',
    'closures',
    'abstractions',
    'decision-overrides',
  ]) {
    fs.rmSync(path.join(cotxDir, layer), { recursive: true, force: true });
  }
}

async function withSupplementalSourceFileNodes(projectRoot: string, nodes: GraphNode[]): Promise<GraphNode[]> {
  const existingFilePaths = new Set<string>();
  const existingNodeIds = new Set<string>();
  for (const node of nodes) {
    existingNodeIds.add(node.id);
    const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
    if (filePath) existingFilePaths.add(filePath);
  }

  const supplemental: GraphNode[] = [];
  for (const filePath of await listSupplementalSourceFiles(projectRoot)) {
    if (existingFilePaths.has(filePath)) continue;
    const id = `File:${filePath}`;
    if (existingNodeIds.has(id)) continue;
    supplemental.push({
      id,
      label: 'File',
      properties: {
        name: path.basename(filePath),
        filePath,
      },
    });
  }

  if (supplemental.length === 0) return nodes;
  return [...nodes, ...supplemental];
}

function isSupplementalSourceFile(filePath: string): boolean {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return SUPPLEMENTAL_SOURCE_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

async function listSupplementalSourceFiles(projectRoot: string): Promise<string[]> {
  const ignoreFilter = await createIgnoreFilter(projectRoot, { noGitignore: true });
  const files = await glob('**/*', {
    cwd: projectRoot,
    nodir: true,
    dot: false,
    ignore: ignoreFilter,
  });
  return files
    .map((filePath) => filePath.replace(/\\/g, '/'))
    .filter(isSupplementalSourceFile);
}

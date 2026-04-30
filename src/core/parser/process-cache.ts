/**
 * Phase D step 9: BFS processes local recompute.
 *
 * processProcesses walks the CALLS graph from every entry point and traces
 * potential execution flows. The output is a pure function of:
 *   - the CALLS edges (sourceId / targetId / confidence)
 *   - the community memberships (which nodes belong to which community)
 *   - the detection config (maxProcesses, minSteps)
 *
 * We hash these inputs. If the hash matches a previous compile's, we reuse
 * the cached ProcessDetectionResult instead of re-running BFS.
 *
 * Cache storage: `.cotx/cache/process-cache.json`. Not sqlite since the
 * payload is small (a few hundred KB at most) and read all-at-once.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeGraph } from '../graph/types.js';
import type { CommunityMembership } from './community-processor.js';
import type {
  ProcessDetectionConfig,
  ProcessDetectionResult,
} from './process-processor.js';

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILENAME = 'process-cache.json';

interface ProcessCacheFile {
  schema_version: number;
  inputs_hash: string;
  result: ProcessDetectionResult;
}

/**
 * Compute a stable hash of the inputs that drive process detection. Any
 * change that would alter the trace set changes this hash.
 */
export function computeProcessInputsHash(
  graph: KnowledgeGraph,
  memberships: CommunityMembership[],
  config: Partial<ProcessDetectionConfig>,
): string {
  const hasher = createHash('sha256');

  // CALLS edges — sort by (source, target) for stability across compiles.
  const edges: Array<[string, string, number]> = [];
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    edges.push([rel.sourceId, rel.targetId, rel.confidence]);
  }
  edges.sort((a, b) => {
    const c = a[0].localeCompare(b[0]);
    return c !== 0 ? c : a[1].localeCompare(b[1]);
  });
  for (const [s, t, c] of edges) {
    hasher.update(`${s}\0${t}\0${c.toFixed(3)}\n`);
  }

  // Memberships — sort by nodeId.
  const memPairs = memberships
    .map((m) => [m.nodeId, m.communityId] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]));
  for (const [n, c] of memPairs) {
    hasher.update(`m:${n}\0${c}\n`);
  }

  // Config knobs that can change the output.
  hasher.update(`cfg:${config.maxProcesses ?? 'd'}:${config.minSteps ?? 'd'}`);

  return hasher.digest('hex').slice(0, 32);
}

export function loadCachedProcesses(
  projectRoot: string,
  inputsHash: string,
): ProcessDetectionResult | null {
  const cachePath = path.join(projectRoot, '.cotx', 'cache', CACHE_FILENAME);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const entry = JSON.parse(raw) as ProcessCacheFile;
    if (entry.schema_version !== CACHE_SCHEMA_VERSION) return null;
    if (entry.inputs_hash !== inputsHash) return null;
    // Minimal shape check.
    if (!Array.isArray(entry.result?.processes) || !Array.isArray(entry.result?.steps)) {
      return null;
    }
    return entry.result;
  } catch {
    return null;
  }
}

export function saveCachedProcesses(
  projectRoot: string,
  inputsHash: string,
  result: ProcessDetectionResult,
): void {
  const cacheDir = path.join(projectRoot, '.cotx', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, CACHE_FILENAME);
  const entry: ProcessCacheFile = {
    schema_version: CACHE_SCHEMA_VERSION,
    inputs_hash: inputsHash,
    result,
  };
  // Atomic write: tmp + rename.
  const tmp = `${cachePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
  fs.renameSync(tmp, cachePath);
}

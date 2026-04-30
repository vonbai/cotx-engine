/**
 * Churn Analyzer
 *
 * Reads all snapshots in .cotx/snapshots/, compares struct_hash per module
 * across consecutive snapshots. Computes:
 *   - change_count: how many snapshots show this module changed
 *   - last_changed: timestamp of most recent change
 *   - stability: 'stable' | 'active' | 'volatile'
 *   - temporal_coupling: pairs of modules that co-change in >40% of snapshots
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { ModuleNode, ChurnMetrics } from '../store/schema.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';

export interface TemporalCouplingEdge {
  from: string;
  to: string;
  cochangeRatio: number;  // 0.0-1.0
  cochangeCount: number;
}

interface SnapshotData {
  tag: string;
  compiled_at: string;
  modules: Map<string, string>;  // module_id → struct_hash
}

const TEMPORAL_COUPLING_THRESHOLD = 0.4;  // 40% co-change ratio

/**
 * Read a single snapshot's module data.
 */
function readSnapshot(snapshotDir: string, tag: string): SnapshotData | null {
  const snapshotPath = path.join(snapshotDir, tag);
  const semanticDb = path.join(snapshotPath, 'v2', 'truth.lbug');
  const metaFile = path.join(snapshotDir, tag, 'meta.yaml');

  if (!fs.existsSync(semanticDb)) return null;

  let compiledAt = '';
  try {
    const meta = yaml.load(fs.readFileSync(metaFile, 'utf-8')) as Record<string, unknown>;
    compiledAt = (meta.compiled_at as string) ?? '';
  } catch {
    // If meta is missing, use directory mtime
    compiledAt = fs.statSync(semanticDb).mtime.toISOString();
  }

  const modules = new Map<string, string>();
  for (const artifact of readSemanticArtifactsSync(semanticDb, 'module')) {
    if (artifact.id && artifact.structHash) modules.set(artifact.id, artifact.structHash);
  }

  return { tag, compiled_at: compiledAt, modules };
}

/**
 * Main entry point: analyze churn across all snapshots.
 *
 * @param projectRoot - absolute path to project root
 * @param modules - current compiled modules (will be mutated with churn field)
 * @returns temporal coupling edges to be added to the graph
 */
export function analyzeChurn(
  projectRoot: string,
  modules: ModuleNode[],
): TemporalCouplingEdge[] {
  const snapshotsDir = path.join(projectRoot, '.cotx', 'snapshots');
  if (!fs.existsSync(snapshotsDir)) return [];

  // Read all snapshots
  const tags = fs.readdirSync(snapshotsDir).filter((tag) => {
    const stat = fs.statSync(path.join(snapshotsDir, tag));
    return stat.isDirectory();
  });

  if (tags.length === 0) return [];

  const snapshots: SnapshotData[] = [];
  for (const tag of tags) {
    const data = readSnapshot(snapshotsDir, tag);
    if (data) snapshots.push(data);
  }

  // Sort snapshots by compiled_at
  snapshots.sort((a, b) => a.compiled_at.localeCompare(b.compiled_at));

  // Also include current state as the latest "snapshot"
  const currentModules = new Map<string, string>();
  for (const mod of modules) {
    currentModules.set(mod.id, mod.struct_hash);
  }
  const currentSnapshot: SnapshotData = {
    tag: '_current',
    compiled_at: new Date().toISOString(),
    modules: currentModules,
  };
  snapshots.push(currentSnapshot);

  if (snapshots.length < 2) return [];

  // Step 1: Compute per-module change counts by comparing consecutive snapshots
  const changeCount = new Map<string, number>();
  const lastChanged = new Map<string, string>();
  // Track which modules changed in each transition (for temporal coupling)
  const transitionChanges: Set<string>[] = [];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    const changed = new Set<string>();

    // Check all module IDs that exist in either snapshot
    const allIds = new Set([...prev.modules.keys(), ...curr.modules.keys()]);

    for (const id of allIds) {
      const prevHash = prev.modules.get(id);
      const currHash = curr.modules.get(id);

      if (prevHash !== currHash) {
        // Module was added, removed, or modified
        changed.add(id);
        changeCount.set(id, (changeCount.get(id) ?? 0) + 1);
        lastChanged.set(id, curr.compiled_at);
      }
    }

    transitionChanges.push(changed);
  }

  // Step 2: Assign churn to modules
  const totalTransitions = snapshots.length - 1;

  for (const mod of modules) {
    const count = changeCount.get(mod.id);
    if (count === undefined) continue;

    const ratio = count / totalTransitions;
    let stability: ChurnMetrics['stability'];
    if (ratio <= 0.2) stability = 'stable';
    else if (ratio <= 0.5) stability = 'active';
    else stability = 'volatile';

    mod.churn = {
      change_count: count,
      last_changed: lastChanged.get(mod.id) ?? '',
      stability,
    };
  }

  // Step 3: Compute temporal coupling
  const couplingEdges: TemporalCouplingEdge[] = [];
  const moduleIds = modules.map((m) => m.id);

  // For each pair of modules, count how many transitions they co-changed
  // and how many transitions either changed
  for (let i = 0; i < moduleIds.length; i++) {
    for (let j = i + 1; j < moduleIds.length; j++) {
      const a = moduleIds[i];
      const b = moduleIds[j];

      let coChangeCount = 0;
      let eitherChangeCount = 0;

      for (const changed of transitionChanges) {
        const aChanged = changed.has(a);
        const bChanged = changed.has(b);
        if (aChanged || bChanged) {
          eitherChangeCount++;
          if (aChanged && bChanged) coChangeCount++;
        }
      }

      if (eitherChangeCount > 0) {
        const ratio = coChangeCount / eitherChangeCount;
        if (ratio >= TEMPORAL_COUPLING_THRESHOLD && coChangeCount >= 2) {
          couplingEdges.push({
            from: a,
            to: b,
            cochangeRatio: parseFloat(ratio.toFixed(2)),
            cochangeCount: coChangeCount,
          });
        }
      }
    }
  }

  return couplingEdges;
}

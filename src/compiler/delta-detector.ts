import path from 'node:path';
import type { CotxStore } from '../store/store.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';
import type { ModuleNode, ContractNode, FlowNode } from '../store/schema.js';

export interface DeltaResult {
  changedFiles: string[];
  affectedModules: string[];
  affectedContracts: string[];
  affectedFlows: string[];
}

export function detectDelta(store: CotxStore, changedFiles: string[]): DeltaResult {
  // Previously: N+1 per-node store.readModule / readContract / readFlow
  // inside .some() blocks. On a repo with 1000+ semantic nodes that was
  // thousands of LBug open/close cycles per call, enough to time out
  // cotx_review_change / cotx_lint at 120s when the project is large or
  // another writer is holding the exclusive lock. One bulk read per
  // layer fixes it.
  const dbPath = path.join(store.projectRoot, '.cotx', 'v2', 'truth.lbug');
  const changedSet = new Set(changedFiles);
  const affectedModules = new Set<string>();

  for (const a of readSemanticArtifactsSync(dbPath, 'module')) {
    const m = a.payload as ModuleNode;
    if ((m.files ?? []).some((f) => changedSet.has(f))) {
      affectedModules.add(a.id);
    }
  }

  const affectedContracts = new Set<string>();
  for (const a of readSemanticArtifactsSync(dbPath, 'contract')) {
    const c = a.payload as ContractNode;
    if (affectedModules.has(c.provider) || affectedModules.has(c.consumer)) {
      affectedContracts.add(a.id);
    }
  }

  const affectedFlows = new Set<string>();
  for (const a of readSemanticArtifactsSync(dbPath, 'flow')) {
    const f = a.payload as FlowNode;
    if ((f.steps ?? []).some((s) => affectedModules.has(s.module))) {
      affectedFlows.add(a.id);
    }
  }

  return {
    changedFiles,
    affectedModules: [...affectedModules].sort(),
    affectedContracts: [...affectedContracts].sort(),
    affectedFlows: [...affectedFlows].sort(),
  };
}

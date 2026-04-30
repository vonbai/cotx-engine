import path from 'node:path';
import type { CotxStore } from '../store/store.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';

export interface StaleResult {
  staleEnrichments: Array<{ nodeId: string; layer: string; source_hash: string; struct_hash: string }>;
  staleAnnotations: Array<{ nodeId: string; layer: string; annotationIndex: number; reason: string }>;
  summary: { totalStale: number; enrichments: number; annotations: number };
}

export function detectStale(store: CotxStore): StaleResult {
  const staleEnrichments: StaleResult['staleEnrichments'] = [];
  const staleAnnotations: StaleResult['staleAnnotations'] = [];

  const artifacts = readSemanticArtifactsSync(path.join(store.projectRoot, '.cotx', 'v2', 'truth.lbug'))
    .filter((item) =>
      item.layer === 'module' ||
      item.layer === 'concept' ||
      item.layer === 'contract' ||
      item.layer === 'flow',
    );

  for (const artifact of artifacts) {
    const node = artifact.payload as {
      struct_hash: string;
      enriched?: { source_hash?: string };
      annotations?: Array<{ stale?: boolean; stale_reason?: string }>;
    };

    const needsEnrichment =
      !node.enriched ||
      node.enriched.source_hash !== node.struct_hash;
    if (needsEnrichment) {
      staleEnrichments.push({
        nodeId: artifact.id,
        layer: artifact.layer,
        source_hash: node.enriched?.source_hash ?? '',
        struct_hash: node.struct_hash,
      });
    }

    if (node.annotations) {
      for (let i = 0; i < node.annotations.length; i++) {
        if (node.annotations[i].stale) {
          staleAnnotations.push({
            nodeId: artifact.id,
            layer: artifact.layer,
            annotationIndex: i,
            reason: node.annotations[i].stale_reason || 'struct_hash changed',
          });
        }
      }
    }
  }

  return {
    staleEnrichments,
    staleAnnotations,
    summary: {
      totalStale: staleEnrichments.length + staleAnnotations.length,
      enrichments: staleEnrichments.length,
      annotations: staleAnnotations.length,
    },
  };
}

// Mark annotations stale on nodes whose struct_hash changed
export function markStaleAnnotations(
  store: CotxStore,
  changedNodeIds: Set<string>,
  reason: string,
): number {
  let count = 0;
  // One bulk read per compile; stale detection used to do listX + readX
  // per-node, which meant every compile paid N+1 LBug opens just for this
  // pre-annotation pass.
  const { modules, concepts, contracts, flows } = store.loadAllSemanticArtifacts();

  function processNodes<T extends { id: string; annotations?: Array<{ stale?: boolean; stale_reason?: string }> }>(
    nodes: T[],
    write: (data: T) => void,
  ): void {
    for (const node of nodes) {
      if (!changedNodeIds.has(node.id)) continue;
      if (!node.annotations || node.annotations.length === 0) continue;
      let modified = false;
      for (const ann of node.annotations) {
        if (!ann.stale) {
          ann.stale = true;
          ann.stale_reason = reason;
          modified = true;
          count++;
        }
      }
      if (modified) write(node);
    }
  }

  processNodes(modules, (d) => store.writeModule(d));
  processNodes(concepts, (d) => store.writeConcept(d));
  processNodes(contracts, (d) => store.writeContract(d));
  processNodes(flows, (d) => store.writeFlow(d));

  return count;
}

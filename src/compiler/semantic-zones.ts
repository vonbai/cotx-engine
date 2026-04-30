import path from 'node:path';
import type { Annotation, ConceptNode, ContractNode, ConcernNode, DecisionOverride, FlowNode, ModuleNode } from '../store/schema.js';
import type { CotxStore } from '../store/store.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';

type SemanticNode = ModuleNode | ConceptNode | ContractNode | FlowNode;

export interface PreviousSemanticLayers {
  modules: ModuleNode[];
  concepts: ConceptNode[];
  contracts: ContractNode[];
  flows: FlowNode[];
  concerns: ConcernNode[];
  decisionOverrides: DecisionOverride[];
}

export function readPreviousSemanticLayers(store: CotxStore): PreviousSemanticLayers {
  const artifacts = readSemanticArtifactsSync(path.join(store.projectRoot, '.cotx', 'v2', 'truth.lbug'));
  return {
    modules: artifacts.filter((item) => item.layer === 'module').map((item) => item.payload as ModuleNode),
    concepts: artifacts.filter((item) => item.layer === 'concept').map((item) => item.payload as ConceptNode),
    contracts: artifacts.filter((item) => item.layer === 'contract').map((item) => item.payload as ContractNode),
    flows: artifacts.filter((item) => item.layer === 'flow').map((item) => item.payload as FlowNode),
    concerns: artifacts.filter((item) => item.layer === 'concern').map((item) => item.payload as ConcernNode),
    decisionOverrides: artifacts.filter((item) => item.layer === 'decision_override').map((item) => item.payload as DecisionOverride),
  };
}

export function structHashMap<T extends SemanticNode>(nodes: T[]): Map<string, string> {
  return new Map(nodes.map((node) => [node.id, node.struct_hash]));
}

export function preserveSemanticZones<T extends SemanticNode>(nextNodes: T[], previousNodes: T[]): void {
  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  for (const next of nextNodes) {
    const previous = previousById.get(next.id);
    if (!previous) continue;
    next.enriched ??= previous.enriched;
    next.annotations ??= previous.annotations;
  }
}

export function collectChangedIds<T extends SemanticNode>(
  previousHashes: Map<string, string>,
  nextNodes: T[],
  changedIds: Set<string>,
): void {
  for (const node of nextNodes) {
    if (previousHashes.get(node.id) !== node.struct_hash) changedIds.add(node.id);
  }
}

export function markStaleAnnotationsInNodes<T extends SemanticNode>(
  nodes: T[],
  changedIds: Set<string>,
  reason: string,
): number {
  let count = 0;
  for (const node of nodes) {
    if (!changedIds.has(node.id)) continue;
    const annotations = node.annotations as Annotation[] | undefined;
    if (!annotations || annotations.length === 0) continue;
    for (const annotation of annotations) {
      if (annotation.stale) continue;
      annotation.stale = true;
      annotation.stale_reason = reason;
      count++;
    }
  }
  return count;
}

import type { GraphEdge, GraphNode, ProcessData } from '../core/export/json-exporter.js';
import type {
  AbstractionOpportunity,
  CanonicalPath,
  ClosureSet,
  ConceptNode,
  ContractNode,
  ConcernFamily,
  ConcernNode,
  DecisionOverride,
  FlowNode,
  ModuleNode,
  SymmetryEdge,
} from '../store/schema.js';
import { structHash } from '../lib/hash.js';
import { projectDecisionFacts } from './decision-projection.js';
import type { DecisionRuleFacts, GraphFacts, SemanticArtifactFact } from './types.js';

export interface StorageV2ProjectionInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  processes: ProcessData[];
  modules: ModuleNode[];
  concepts: ConceptNode[];
  contracts: ContractNode[];
  flows: FlowNode[];
  concerns: ConcernNode[];
  decisionOverrides: DecisionOverride[];
  concernFamilies: ConcernFamily[];
  canonicalPaths: CanonicalPath[];
  symmetryEdges: SymmetryEdge[];
  closureSets: ClosureSet[];
  abstractionOpportunities: AbstractionOpportunity[];
}

export interface StorageV2Projection {
  graph: GraphFacts;
  semanticArtifacts: SemanticArtifactFact[];
  decisions: DecisionRuleFacts;
}

export function projectStorageV2Facts(input: StorageV2ProjectionInput): StorageV2Projection {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));

  const graph: GraphFacts = {
    codeNodes: input.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      name: stringProp(node, 'name') ?? node.id,
      filePath: stringProp(node, 'filePath') ?? '',
      startLine: numberProp(node, 'startLine'),
      endLine: numberProp(node, 'endLine'),
      isExported: booleanProp(node, 'isExported'),
      properties: JSON.stringify(node.properties),
    })),
    codeRelations: input.edges
      .filter((edge) => nodeById.has(edge.sourceId) && nodeById.has(edge.targetId))
      .map((edge) => ({
        from: edge.sourceId,
        to: edge.targetId,
        type: edge.type,
        confidence: edge.confidence,
        reason: edge.reason ?? '',
        step: edge.step ?? 0,
      }))
  };

  return {
    graph,
    semanticArtifacts: [
      ...input.modules.map((item) => artifact('module', item.id, item.struct_hash, item)),
      ...input.concepts.map((item) => artifact('concept', item.id, item.struct_hash, item)),
      ...input.contracts.map((item) => artifact('contract', item.id, item.struct_hash, item)),
      ...input.flows.map((item) => artifact('flow', item.id, item.struct_hash, item)),
      ...input.concerns.map((item) => artifact('concern', item.id, structHash(item as unknown as Record<string, unknown>), item)),
      ...input.decisionOverrides.map((item) => artifact('decision_override', item.id, structHash(item as unknown as Record<string, unknown>), item)),
      ...input.concernFamilies.map((item) => artifact('concern_family', item.id, structHash(item as unknown as Record<string, unknown>), item)),
      ...input.canonicalPaths.map((item) => artifact('canonical_path', item.id, structHash(item as unknown as Record<string, unknown>), item)),
      ...input.symmetryEdges.map((item) => artifact('symmetry_edge', item.id, structHash(item as unknown as Record<string, unknown>), item)),
      ...input.closureSets.map((item) => artifact('closure_set', item.id, structHash(item as unknown as Record<string, unknown>), item)),
      ...input.abstractionOpportunities.map((item) => artifact('abstraction_opportunity', item.id, structHash(item as unknown as Record<string, unknown>), item)),
    ],
    decisions: projectDecisionFacts({
      canonicalPaths: input.canonicalPaths,
      symmetryEdges: input.symmetryEdges,
      closureSets: input.closureSets,
      abstractionOpportunities: input.abstractionOpportunities,
    }),
  };
}

function artifact(layer: SemanticArtifactFact['layer'], id: string, structHash: string, payload: unknown): SemanticArtifactFact {
  return { layer, id, structHash, payload };
}

function stringProp(node: GraphNode, key: string): string | undefined {
  const value = node.properties[key];
  return typeof value === 'string' ? value : undefined;
}

function numberProp(node: GraphNode, key: string): number {
  const value = node.properties[key];
  return typeof value === 'number' ? value : 0;
}

function booleanProp(node: GraphNode, key: string): boolean {
  const value = node.properties[key];
  return typeof value === 'boolean' ? value : false;
}

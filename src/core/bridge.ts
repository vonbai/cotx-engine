/**
 * Bridge: internal parser types → cotx export types
 *
 * Converts KnowledgeGraph + CommunityDetectionResult + ProcessDetectionResult
 * into the flat export types used by the store layer (GraphNode[], GraphEdge[],
 * CommunityData[], ProcessData[]).
 */

import type { KnowledgeGraph } from './graph/types.js';
import type {
  GraphNode as ExportNode,
  GraphEdge,
  CommunityData,
  ProcessData,
} from './export/json-exporter.js';
import type { CommunityDetectionResult } from './parser/community-processor.js';
import type { ProcessDetectionResult } from './parser/process-processor.js';

export function bridgeNodes(graph: KnowledgeGraph): ExportNode[] {
  const result: ExportNode[] = [];
  for (const node of graph.iterNodes()) {
    result.push({
      id: node.id,
      label: node.label,
      properties: node.properties as Record<string, unknown>,
    });
  }
  return result;
}

export function bridgeEdges(graph: KnowledgeGraph): GraphEdge[] {
  const result: GraphEdge[] = [];
  for (const rel of graph.iterRelationships()) {
    result.push({
      sourceId: rel.sourceId,
      targetId: rel.targetId,
      type: rel.type,
      confidence: rel.confidence,
      reason: rel.reason,
      step: rel.step,
    });
  }
  return result;
}

export function bridgeCommunities(
  result: CommunityDetectionResult | undefined,
): CommunityData[] {
  if (!result) return [];
  return result.communities.map((c) => ({
    id: c.id,
    label: c.label || c.heuristicLabel || '',
    symbolCount: c.symbolCount,
    cohesion: c.cohesion,
    members: result.memberships
      .filter((m) => m.communityId === c.id)
      .map((m) => m.nodeId),
  }));
}

export function bridgeProcesses(
  result: ProcessDetectionResult | undefined,
): ProcessData[] {
  if (!result) return [];
  return result.processes.map((p) => ({
    id: p.id,
    label: p.label || p.heuristicLabel || '',
    processType: p.processType,
    stepCount: p.stepCount,
    communities: p.communities || [],
    entryPointId: p.entryPointId,
    terminalId: p.terminalId,
    steps: result.steps
      .filter((s) => s.processId === p.id)
      .sort((a, b) => a.step - b.step)
      .map((s) => ({ nodeId: s.nodeId, step: s.step })),
  }));
}

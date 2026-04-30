export interface GraphNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
  reason?: string;
  step?: number;
}

export interface CommunityData {
  id: string;
  label: string;
  symbolCount: number;
  cohesion: number;
  members: string[];
}

export interface ProcessData {
  id: string;
  label: string;
  processType: string;
  stepCount: number;
  communities: string[];
  entryPointId: string;
  terminalId: string;
  steps: Array<{ nodeId: string; step: number }>;
}

export interface JsonLinesExport {
  nodes: string[];
  edges: string[];
}

export function exportGraphToJsonLines(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): JsonLinesExport {
  return {
    nodes: graph.nodes.map((n) => JSON.stringify(n)),
    edges: graph.edges.map((e) => JSON.stringify(e)),
  };
}

export function exportCommunitiesToJsonLines(communities: CommunityData[]): string[] {
  return communities.map((c) => JSON.stringify(c));
}

export function exportProcessesToJsonLines(processes: ProcessData[]): string[] {
  return processes.map((p) => JSON.stringify(p));
}

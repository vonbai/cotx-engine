export type ExplorerPerspectiveId = string;
export type ExplorerNodePath = string;
export type ExplorerEdgeId = string;

export type CotxLayerId =
  | 'code-graph'
  | 'modules'
  | 'concepts'
  | 'contracts'
  | 'flows'
  | 'routes'
  | 'tools'
  | 'processes'
  | 'decision-facts'
  | 'architecture'
  | 'change-impact';

export type EvidenceStatus = 'grounded' | 'stale' | 'gap' | 'unknown';

export interface EvidenceAnchor {
  kind:
    | 'node'
    | 'relation'
    | 'file'
    | 'process'
    | 'route'
    | 'tool'
    | 'decision'
    | 'module'
    | 'contract'
    | 'flow'
    | 'architecture'
    | 'change'
    | 'doc'
    | 'unknown';
  ref: string;
  filePath?: string;
  line?: number;
  detail?: string;
  score?: number;
}

export interface LayerSummary {
  layer: CotxLayerId;
  label: string;
  perspectiveId?: ExplorerPerspectiveId;
  nodeCount?: number;
  edgeCount?: number;
  status?: EvidenceStatus;
  summary?: string;
}

export interface PerspectiveStats {
  nodeCount: number;
  edgeCount: number;
  maxRiskScore: number;
}

export interface NodeStats {
  fileCount: number;
  functionCount: number;
  totalCyclomatic: number;
  maxCyclomatic: number;
  maxNestingDepth: number;
  riskScore: number;
}

export interface ExplorerPerspective {
  id: ExplorerPerspectiveId;
  label: string;
  layer?: CotxLayerId;
  evidenceStatus?: EvidenceStatus;
  statusReason?: string | null;
  summary?: string | null;
  layerSummary?: LayerSummary[];
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  stats: PerspectiveStats;
}

export interface ExplorerNode {
  path: ExplorerNodePath;
  id: string;
  label: string;
  shortLabel: string;
  breadcrumb: string[];
  layer?: CotxLayerId;
  evidenceStatus?: EvidenceStatus;
  statusReason?: string | null;
  evidence?: EvidenceAnchor[];
  directory: string;
  kind: 'leaf' | 'group';
  stats: NodeStats;
  files?: string[];
  exportedFunctions?: string[];
  contractsProvided?: string[];
  contractsConsumed?: string[];
  relatedFlows?: string[];
  children?: ExplorerNodePath[];
  description?: string | null;
  diagram?: string | null;
}

export interface ExplorerEdge {
  id: ExplorerEdgeId;
  from: ExplorerNodePath;
  to: ExplorerNodePath;
  type: string;
  label?: string;
  weight: number;
}

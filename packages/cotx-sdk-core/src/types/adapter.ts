import type {
  CotxLayerId,
  EvidenceStatus,
  ExplorerPerspective,
  ExplorerNode,
  ExplorerNodePath,
} from './explorer.js';

export interface ProjectMeta {
  id: string;
  compiledAt: string;
  workspaceLayout?: WorkspaceLayoutSummary;
}

export interface WorkspaceLayoutSummary {
  repoBoundaries: number;
  packageBoundaries: number;
  assetDirectories: number;
  assetPaths: string[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  compiledAt: string;
  workspaceLayout?: WorkspaceLayoutSummary;
  stats: {
    modules: number;
    concepts: number;
    contracts: number;
    flows: number;
    concerns: number;
  };
  defaultPerspective: string;
}

export interface PerspectiveSummary {
  id: string;
  label: string;
  layer?: CotxLayerId;
  status?: EvidenceStatus;
  summary?: string;
  nodeCount: number;
  edgeCount: number;
}

export interface ImpactData {
  root: ExplorerNodePath;
  affected: string[];
  risk?: 'LOW' | 'MEDIUM' | 'HIGH';
  status?: EvidenceStatus;
  statusReason?: string | null;
  targetPaths?: string[];
}

export interface DiffData {
  changedNodes: ExplorerNodePath[];
}

export interface SearchResults {
  matches: ExplorerNodePath[];
}

export interface CotxDataAdapter {
  listProjects?(): Promise<ProjectSummary[]>;
  getProjectMeta(projectId: string): Promise<ProjectMeta>;
  listPerspectives(projectId: string): Promise<PerspectiveSummary[]>;
  getPerspective(projectId: string, perspectiveId: string): Promise<ExplorerPerspective>;
  getNode(projectId: string, perspectiveId: string, nodePath: string): Promise<ExplorerNode>;
  getImpact?(projectId: string, perspectiveId: string, nodePath: string): Promise<ImpactData>;
  getDiff?(projectId: string, baseRef: string): Promise<DiffData>;
  search?(projectId: string, query: string): Promise<SearchResults>;
}

import type { ExplorerPerspectiveId, ExplorerNodePath } from '../types/explorer.js';

export interface SavedViewRef {
  id: string;
  label: string;
  state: string;
}

export interface CompareState {
  leftNodePath: ExplorerNodePath | null;
  rightNodePath: ExplorerNodePath | null;
  mode: 'node' | 'snapshot';
}

export interface WorkbenchState {
  projectId: string;
  perspectiveId: ExplorerPerspectiveId;
  focusedNodePath: ExplorerNodePath | null;
  graphSelection: {
    anchorNodePath: ExplorerNodePath | null;
    neighborhoodDepth: 0 | 1 | 2;
  };
  filters: {
    query: string;
    edgeTypes: string[];
    riskRange: [number, number] | null;
    showEdgeLabels: 'none' | 'focus' | 'all';
    showNodeMeta: 'minimal' | 'balanced' | 'dense';
  };
  tree: {
    collapsedPaths: string[];
    navVisible: boolean;
    navWidth: number;
  };
  inspector: {
    visible: boolean;
    tab: 'summary' | 'evidence' | 'files' | 'relations' | 'flows' | 'contracts' | 'diagram';
  };
  viewport: {
    zoom: number;
    panX: number;
    panY: number;
    pinnedNodes: Record<ExplorerNodePath, { x: number; y: number }>;
  };
  savedViews: SavedViewRef[];
  compare?: CompareState | null;
}

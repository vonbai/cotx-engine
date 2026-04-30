import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ExplorerPerspective,
  ExplorerNode,
  ExplorerEdge,
  EvidenceAnchor,
  LayerSummary,
  PerspectiveStats,
  NodeStats,
  WorkbenchState,
  SavedViewRef,
  CompareState,
  CotxDataAdapter,
  ProjectMeta,
  WorkspaceLayoutSummary,
  PerspectiveSummary,
  ImpactData,
  DiffData,
  SearchResults,
  ProjectSummary,
  WriteIntent,
  RefactorIntent,
  AgentIntent,
  ToolIntent,
  PersistViewIntent,
  CompareIntent,
  WorkbenchIntents,
} from 'cotx-sdk-core';

describe('explorer types', () => {
  it('PerspectiveStats compiles', () => {
    const stats: PerspectiveStats = { nodeCount: 1, edgeCount: 2, maxRiskScore: 3 };
    expect(stats.nodeCount).toBe(1);
  });

  it('NodeStats compiles', () => {
    const stats: NodeStats = {
      fileCount: 1, functionCount: 2, totalCyclomatic: 3,
      maxCyclomatic: 4, maxNestingDepth: 5, riskScore: 6,
    };
    expect(stats.riskScore).toBe(6);
  });

  it('ExplorerNode compiles with all fields', () => {
    const evidence: EvidenceAnchor[] = [
      { kind: 'file', ref: 'a.ts', filePath: 'a.ts', line: 1 },
    ];
    const node: ExplorerNode = {
      path: 'mod/a', id: 'a', label: 'Module A', shortLabel: 'A',
      breadcrumb: ['mod', 'a'], directory: 'src/mod',
      layer: 'architecture', evidenceStatus: 'grounded', evidence,
      kind: 'leaf',
      stats: { fileCount: 1, functionCount: 2, totalCyclomatic: 3, maxCyclomatic: 4, maxNestingDepth: 5, riskScore: 6 },
      files: ['a.ts'], exportedFunctions: ['fn'], contractsProvided: ['c1'],
      contractsConsumed: ['c2'], relatedFlows: ['f1'], children: ['mod/a/sub'],
      description: 'desc', diagram: '```mermaid```',
    };
    expect(node.kind).toBe('leaf');
  });

  it('ExplorerEdge compiles', () => {
    const edge: ExplorerEdge = { id: 'e1', from: 'a', to: 'b', type: 'depends', weight: 1 };
    expect(edge.type).toBe('depends');
  });

  it('ExplorerPerspective compiles', () => {
    const layerSummary: LayerSummary[] = [
      { layer: 'architecture', label: 'Architecture', status: 'grounded', nodeCount: 1 },
    ];
    const p: ExplorerPerspective = {
      id: 'arch', label: 'Architecture', nodes: [], edges: [],
      layer: 'architecture', evidenceStatus: 'grounded', layerSummary,
      stats: { nodeCount: 0, edgeCount: 0, maxRiskScore: 0 },
    };
    expect(p.id).toBe('arch');
  });
});

describe('state types', () => {
  it('WorkbenchState.tree.collapsedPaths is string[]', () => {
    const state: WorkbenchState = {
      projectId: 'p', perspectiveId: 'arch', focusedNodePath: null,
      graphSelection: { anchorNodePath: null, neighborhoodDepth: 0 },
      filters: { query: '', edgeTypes: [], riskRange: null, showEdgeLabels: 'none', showNodeMeta: 'balanced' },
      tree: { collapsedPaths: ['a', 'b'], navVisible: true, navWidth: 250 },
      inspector: { visible: true, tab: 'summary' },
      viewport: { zoom: 1, panX: 0, panY: 0, pinnedNodes: {} },
      savedViews: [],
    };
    expectTypeOf(state.tree.collapsedPaths).toEqualTypeOf<string[]>();
  });

  it('SavedViewRef compiles', () => {
    const v: SavedViewRef = { id: 'v1', label: 'My View', state: 'p=overall-architecture' };
    expect(v.id).toBe('v1');
  });

  it('CompareState compiles', () => {
    const c: CompareState = { leftNodePath: 'a', rightNodePath: 'b', mode: 'node' };
    expect(c.mode).toBe('node');
  });
});

describe('adapter types', () => {
  it('CotxDataAdapter method signatures compile', () => {
    const workspaceLayout: WorkspaceLayoutSummary = {
      repoBoundaries: 1,
      packageBoundaries: 2,
      assetDirectories: 1,
      assetPaths: ['apps/web/public'],
    };
    const adapter: CotxDataAdapter = {
      listProjects: async () => [],
      getProjectMeta: async () => ({ id: 'p', compiledAt: '2025-01-01', workspaceLayout }),
      listPerspectives: async () => [],
      getPerspective: async () => ({ id: 'arch', label: 'Architecture', nodes: [], edges: [], stats: { nodeCount: 0, edgeCount: 0, maxRiskScore: 0 } }),
      getNode: async () => ({
        path: 'a', id: 'a', label: 'A', shortLabel: 'A', breadcrumb: [], directory: '',
        kind: 'leaf', stats: { fileCount: 0, functionCount: 0, totalCyclomatic: 0, maxCyclomatic: 0, maxNestingDepth: 0, riskScore: 0 },
      }),
    };
    expectTypeOf(adapter.listProjects!).returns.resolves.toEqualTypeOf<ProjectSummary[]>();
    expectTypeOf(adapter.getProjectMeta).returns.resolves.toEqualTypeOf<ProjectMeta>();
    expectTypeOf(adapter.listPerspectives).returns.resolves.toEqualTypeOf<PerspectiveSummary[]>();
  });

  it('optional adapter methods compile', () => {
    const adapter: CotxDataAdapter = {
      getProjectMeta: async () => ({ id: 'p', compiledAt: '2025-01-01', workspaceLayout: { repoBoundaries: 1, packageBoundaries: 1, assetDirectories: 0, assetPaths: [] } }),
      listPerspectives: async () => [],
      getPerspective: async () => ({ id: 'arch', label: 'Architecture', nodes: [], edges: [], stats: { nodeCount: 0, edgeCount: 0, maxRiskScore: 0 } }),
      getNode: async () => ({
        path: 'a', id: 'a', label: 'A', shortLabel: 'A', breadcrumb: [], directory: '',
        kind: 'leaf', stats: { fileCount: 0, functionCount: 0, totalCyclomatic: 0, maxCyclomatic: 0, maxNestingDepth: 0, riskScore: 0 },
      }),
      getImpact: async () => ({ root: 'a', affected: ['b'], status: 'grounded', risk: 'MEDIUM' }),
      getDiff: async () => ({ changedNodes: ['a'] }),
      search: async () => ({ matches: ['a'] }),
    };
    expectTypeOf(adapter.getImpact!).returns.resolves.toEqualTypeOf<ImpactData>();
    expectTypeOf(adapter.getDiff!).returns.resolves.toEqualTypeOf<DiffData>();
    expectTypeOf(adapter.search!).returns.resolves.toEqualTypeOf<SearchResults>();
  });
});

describe('intent types', () => {
  it('all intent interfaces compile', () => {
    const w: WriteIntent = { nodePath: 'a', field: 'responsibility' };
    const r: RefactorIntent = { nodePath: 'a', action: 'split' };
    const a: AgentIntent = { task: 'enrich' };
    const t: ToolIntent = { toolName: 'cotx_compile', args: {} };
    const p: PersistViewIntent = {
      label: 'My View',
      state: {
        projectId: 'p', perspectiveId: 'arch', focusedNodePath: null,
        graphSelection: { anchorNodePath: null, neighborhoodDepth: 0 },
        filters: { query: '', edgeTypes: [], riskRange: null, showEdgeLabels: 'none', showNodeMeta: 'balanced' },
        tree: { collapsedPaths: [], navVisible: true, navWidth: 250 },
        inspector: { visible: true, tab: 'summary' },
        viewport: { zoom: 1, panX: 0, panY: 0, pinnedNodes: {} },
        savedViews: [],
      },
    };
    const c: CompareIntent = { left: 'a', right: 'b' };
    expect(w.field).toBe('responsibility');
    expect(r.action).toBe('split');
    expect(a.task).toBe('enrich');
    expect(t.toolName).toBe('cotx_compile');
    expect(p.label).toBe('My View');
    expect(c.left).toBe('a');
  });

  it('WorkbenchIntents all optional', () => {
    const intents: WorkbenchIntents = {};
    expect(intents.onWriteIntent).toBeUndefined();
  });
});

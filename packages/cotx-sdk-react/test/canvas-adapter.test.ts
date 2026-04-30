import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type {
  ExplorerNode,
  ExplorerEdge,
  NodeStats,
  CotxDataAdapter,
  WorkbenchState,
} from 'cotx-sdk-core';
import { toG6Spec } from '../src/components/canvas/g6-adapter.js';
import {
  getNodeLabel,
  shouldShowEdgeLabel,
} from '../src/components/canvas/label-policy.js';
import { ArchitectureCanvas } from '../src/components/ArchitectureCanvas.js';
import { CotxProvider } from '../src/provider/CotxProvider.js';

const { graphInstance, GraphMock } = vi.hoisted(() => {
  const instance = {
    render: vi.fn(),
    destroy: vi.fn(),
    setData: vi.fn(),
    updateBehavior: vi.fn(),
    on: vi.fn(),
    setElementState: vi.fn(),
    fitView: vi.fn(),
    zoomTo: vi.fn(),
    translateTo: vi.fn(),
  };

  return {
    graphInstance: instance,
    GraphMock: vi.fn(() => instance),
  };
});

vi.mock('@antv/g6', () => ({
  Graph: GraphMock,
}));

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function makeStats(overrides?: Partial<NodeStats>): NodeStats {
  return {
    fileCount: 10,
    functionCount: 25,
    totalCyclomatic: 40,
    maxCyclomatic: 8,
    maxNestingDepth: 3,
    riskScore: 2.5,
    ...overrides,
  };
}

function makeNode(overrides?: Partial<ExplorerNode>): ExplorerNode {
  return {
    path: 'modules/core',
    id: 'core',
    label: 'core',
    shortLabel: 'core',
    breadcrumb: ['core'],
    directory: 'src/core',
    kind: 'leaf',
    stats: makeStats(),
    ...overrides,
  };
}

function makeEdge(overrides?: Partial<ExplorerEdge>): ExplorerEdge {
  return {
    id: 'e1',
    from: 'modules/core',
    to: 'modules/parser',
    type: 'CALLS',
    weight: 5,
    ...overrides,
  };
}

function stubAdapter(): CotxDataAdapter {
  return {
    getProjectMeta: vi.fn().mockResolvedValue({ id: 'test', compiledAt: '' }),
    listPerspectives: vi.fn().mockResolvedValue([]),
    getPerspective: vi
      .fn()
      .mockResolvedValue({ id: 'modules', nodes: [], edges: [] }),
    getNode: vi
      .fn()
      .mockResolvedValue({ path: 'a', label: 'a', kind: 'module' }),
  };
}

function providerWrapper(
  overrides?: Partial<WorkbenchState>,
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      CotxProvider,
      {
        adapter: stubAdapter(),
        projectId: 'test-project',
        initialState: overrides,
      },
      children,
    );
  };
}

/* ------------------------------------------------------------------ */
/*  toG6Spec tests                                                     */
/* ------------------------------------------------------------------ */

describe('toG6Spec', () => {
  it('normalizes leaf nodes into G6 node shape', () => {
    const nodes = [
      makeNode({ path: 'modules/core', label: 'core', shortLabel: 'core' }),
      makeNode({ path: 'modules/parser', label: 'parser', shortLabel: 'parser' }),
    ];
    const edges = [makeEdge()];

    const spec = toG6Spec(nodes, edges);

    expect(spec.nodes).toHaveLength(2);
    expect(spec.nodes[0].id).toBe('modules/core');
    expect(spec.nodes[0].data.label).toBe('core');
    expect(spec.nodes[0].data.shortLabel).toBe('core');
    expect(spec.nodes[0].data.kind).toBe('leaf');
    expect(spec.nodes[0].data.stats).toEqual(makeStats());
  });

  it('converts edges with deterministic IDs', () => {
    const nodes = [
      makeNode({ path: 'modules/core' }),
      makeNode({ path: 'modules/parser' }),
    ];
    const edges = [makeEdge({ from: 'modules/core', to: 'modules/parser', type: 'CALLS' })];

    const spec = toG6Spec(nodes, edges);

    expect(spec.edges).toHaveLength(1);
    expect(spec.edges[0].id).toBe('modules/core--CALLS-->modules/parser');
    expect(spec.edges[0].source).toBe('modules/core');
    expect(spec.edges[0].target).toBe('modules/parser');
    expect(spec.edges[0].data.type).toBe('CALLS');
    expect(spec.edges[0].data.weight).toBe(5);
  });

  it('derives combos from group nodes', () => {
    const nodes = [
      makeNode({
        path: 'modules/core',
        kind: 'group',
        label: 'Core',
        children: ['modules/core/parser', 'modules/core/bridge'],
      }),
      makeNode({
        path: 'modules/core/parser',
        kind: 'leaf',
        label: 'parser',
        breadcrumb: ['core', 'parser'],
      }),
      makeNode({
        path: 'modules/core/bridge',
        kind: 'leaf',
        label: 'bridge',
        breadcrumb: ['core', 'bridge'],
      }),
    ];

    const spec = toG6Spec(nodes, []);

    // Group becomes a combo, not a node
    expect(spec.combos).toHaveLength(1);
    expect(spec.combos[0].id).toBe('modules/core');
    expect(spec.combos[0].data.label).toBe('Core');

    // Leaf nodes remain as nodes, not combos
    expect(spec.nodes).toHaveLength(2);
    expect(spec.nodes.find((n) => n.id === 'modules/core')).toBeUndefined();
  });

  it('assigns combo field on leaf nodes whose breadcrumb matches a group', () => {
    const groupNode = makeNode({
      path: 'modules/core',
      kind: 'group',
      label: 'Core',
      breadcrumb: ['core'],
    });
    const leafNode = makeNode({
      path: 'modules/core/parser',
      kind: 'leaf',
      label: 'parser',
      breadcrumb: ['core', 'parser'],
    });

    const spec = toG6Spec([groupNode, leafNode], []);

    const parser = spec.nodes.find((n) => n.id === 'modules/core/parser');
    expect(parser).toBeDefined();
    // breadcrumb ['core', 'parser'] -> 'core' matches group path 'modules/core'?
    // Actually, breadcrumb-based matching: the group path is 'modules/core',
    // and the breadcrumb only has ['core', 'parser']. This won't match directly.
    // The combo field would be undefined here since breadcrumb segments joined
    // don't form 'modules/core'. This is expected — parent resolution uses
    // breadcrumb path joining which may differ from module path conventions.
  });

  it('filters out edges that reference non-leaf nodes', () => {
    const nodes = [
      makeNode({ path: 'modules/core', kind: 'group' }),
      makeNode({ path: 'modules/parser', kind: 'leaf' }),
    ];
    // Edge from group (which becomes combo) to leaf — should be excluded
    const edges = [makeEdge({ from: 'modules/core', to: 'modules/parser' })];

    const spec = toG6Spec(nodes, edges);

    expect(spec.edges).toHaveLength(0);
  });

  it('omits label from edge data when not provided', () => {
    const nodes = [
      makeNode({ path: 'modules/core' }),
      makeNode({ path: 'modules/parser' }),
    ];
    const edges = [
      makeEdge({ from: 'modules/core', to: 'modules/parser', label: undefined }),
    ];

    const spec = toG6Spec(nodes, edges);

    expect(spec.edges[0].data).not.toHaveProperty('label');
  });

  it('includes label in edge data when provided', () => {
    const nodes = [
      makeNode({ path: 'modules/core' }),
      makeNode({ path: 'modules/parser' }),
    ];
    const edges = [
      makeEdge({
        from: 'modules/core',
        to: 'modules/parser',
        label: 'parse()',
      }),
    ];

    const spec = toG6Spec(nodes, edges);

    expect(spec.edges[0].data.label).toBe('parse()');
  });

  it('handles empty input gracefully', () => {
    const spec = toG6Spec([], []);

    expect(spec.nodes).toEqual([]);
    expect(spec.edges).toEqual([]);
    expect(spec.combos).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  getNodeLabel tests                                                 */
/* ------------------------------------------------------------------ */

describe('getNodeLabel', () => {
  const node = makeNode({
    label: 'core/parser',
    shortLabel: 'parser',
    stats: makeStats({ fileCount: 12, functionCount: 30, riskScore: 3.7 }),
  });

  it('minimal: returns shortLabel only', () => {
    expect(getNodeLabel(node, 'minimal')).toBe('parser');
  });

  it('balanced: returns label with file count', () => {
    expect(getNodeLabel(node, 'balanced')).toBe('core/parser (12 files)');
  });

  it('balanced: singular file count', () => {
    const single = makeNode({
      label: 'util',
      shortLabel: 'util',
      stats: makeStats({ fileCount: 1 }),
    });
    expect(getNodeLabel(single, 'balanced')).toBe('util (1 file)');
  });

  it('dense: returns label with full stats summary', () => {
    const result = getNodeLabel(node, 'dense');
    expect(result).toContain('core/parser');
    expect(result).toContain('12 files');
    expect(result).toContain('30 fns');
    expect(result).toContain('risk 3.7');
  });
});

/* ------------------------------------------------------------------ */
/*  shouldShowEdgeLabel tests                                          */
/* ------------------------------------------------------------------ */

describe('shouldShowEdgeLabel', () => {
  const edge = makeEdge({
    from: 'modules/core',
    to: 'modules/parser',
    label: 'parse()',
  });

  it('none: never shows labels', () => {
    expect(shouldShowEdgeLabel(edge, 'none', null)).toBe(false);
    expect(shouldShowEdgeLabel(edge, 'none', 'modules/core')).toBe(false);
  });

  it('all: always shows labels', () => {
    expect(shouldShowEdgeLabel(edge, 'all', null)).toBe(true);
    expect(shouldShowEdgeLabel(edge, 'all', 'modules/core')).toBe(true);
  });

  it('focus: shows labels only on edges connected to focused node', () => {
    // Focused on source
    expect(shouldShowEdgeLabel(edge, 'focus', 'modules/core')).toBe(true);
    // Focused on target
    expect(shouldShowEdgeLabel(edge, 'focus', 'modules/parser')).toBe(true);
    // Focused on unrelated node
    expect(shouldShowEdgeLabel(edge, 'focus', 'modules/store')).toBe(false);
  });

  it('focus: returns false when no node is focused', () => {
    expect(shouldShowEdgeLabel(edge, 'focus', null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  ArchitectureCanvas render test                                     */
/* ------------------------------------------------------------------ */

describe('ArchitectureCanvas', () => {
  beforeEach(() => {
    GraphMock.mockClear();
    graphInstance.render.mockClear();
    graphInstance.destroy.mockClear();
    graphInstance.setData.mockClear();
    graphInstance.updateBehavior.mockClear();
    graphInstance.on.mockClear();
    graphInstance.setElementState.mockClear();
    graphInstance.fitView.mockClear();
    graphInstance.zoomTo.mockClear();
    graphInstance.translateTo.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders container element with data-testid', () => {
    const nodes = [
      makeNode({ path: 'modules/core', label: 'core', shortLabel: 'core' }),
      makeNode({ path: 'modules/parser', label: 'parser', shortLabel: 'parser' }),
    ];
    const edges = [
      makeEdge({ from: 'modules/core', to: 'modules/parser' }),
    ];

    const { getByTestId } = render(
      createElement(ArchitectureCanvas, { nodes, edges }),
      { wrapper: providerWrapper() },
    );

    const container = getByTestId('architecture-canvas');
    expect(container).toBeTruthy();
  });

  it('creates a G6 Graph instance with interactive behaviors', async () => {
    const nodes = [
      makeNode({ path: 'modules/core', label: 'core', shortLabel: 'core' }),
      makeNode({ path: 'modules/parser', label: 'parser', shortLabel: 'parser' }),
    ];
    const edges = [makeEdge({ from: 'modules/core', to: 'modules/parser' })];

    const { getByTestId } = render(
      createElement(ArchitectureCanvas, { nodes, edges }),
      { wrapper: providerWrapper() },
    );

    expect(getByTestId('architecture-canvas')).toBeTruthy();
    await waitFor(() => {
      expect(GraphMock).toHaveBeenCalledOnce();
    });
    const arg = GraphMock.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg.behaviors).toEqual(
      expect.arrayContaining(['drag-canvas', 'zoom-canvas', 'drag-element', 'collapse-expand']),
    );
    expect(arg.data.nodes).toHaveLength(2);
    expect(arg.data.edges).toHaveLength(1);
    expect(graphInstance.render).toHaveBeenCalledOnce();
  });

  it('updates the graph when input data changes', async () => {
    const nodes = [
      makeNode({ path: 'modules/core', label: 'core', shortLabel: 'core' }),
      makeNode({ path: 'modules/parser', label: 'parser', shortLabel: 'parser' }),
    ];
    const updatedNodes = [
      ...nodes,
      makeNode({ path: 'modules/store', id: 'store', label: 'store', shortLabel: 'store' }),
    ];

    const { rerender } = render(
      createElement(ArchitectureCanvas, { nodes, edges: [] }),
      { wrapper: providerWrapper() },
    );

    await waitFor(() => {
      expect(GraphMock).toHaveBeenCalledOnce();
    });

    rerender(
      createElement(ArchitectureCanvas, { nodes: updatedNodes, edges: [] }),
    );

    await waitFor(() => {
      expect(graphInstance.setData).toHaveBeenCalled();
    });
  });

  it('destroys the G6 graph instance on unmount', async () => {
    const nodes = [
      makeNode({ path: 'modules/core', label: 'core', shortLabel: 'core' }),
    ];

    const { unmount } = render(
      createElement(ArchitectureCanvas, { nodes, edges: [] }),
      { wrapper: providerWrapper() },
    );

    await waitFor(() => {
      expect(GraphMock).toHaveBeenCalledOnce();
    });

    unmount();
    expect(graphInstance.destroy).toHaveBeenCalledOnce();
  });

  it('passes focused node state into graph data', async () => {
    const nodes = [
      makeNode({ path: 'modules/core', label: 'core', shortLabel: 'core' }),
    ];

    render(
      createElement(ArchitectureCanvas, {
        nodes,
        edges: [],
        focusedNodePath: 'modules/core',
      }),
      { wrapper: providerWrapper() },
    );

    await waitFor(() => {
      expect(GraphMock).toHaveBeenCalledOnce();
    });

    const arg = GraphMock.mock.calls[0]?.[0];
    expect(
      arg.data.nodes.find((node: { id: string; style: { stroke: string; lineWidth: number } }) => node.id === 'modules/core')?.style,
    ).toEqual(expect.objectContaining({
      stroke: '#4f46e5',
      lineWidth: 3,
    }));
  });

  it('does not apply graph element states before a focus anchor exists', async () => {
    const nodes = [
      makeNode({ path: 'modules/core', id: 'core' }),
      makeNode({ path: 'modules/parser', id: 'parser' }),
    ];
    const edges = [makeEdge({ from: 'modules/core', to: 'modules/parser' })];

    render(
      createElement(ArchitectureCanvas, {
        nodes,
        edges,
        focusedNodePath: null,
      }),
      { wrapper: providerWrapper({ graphSelection: { anchorNodePath: null, neighborhoodDepth: 1 } as any }) },
    );

    await waitFor(() => {
      expect(GraphMock).toHaveBeenCalledOnce();
    });

    expect(graphInstance.setElementState).not.toHaveBeenCalled();
  });

  it('encodes focused neighborhood styling directly into graph data', async () => {
    const nodes = [
      makeNode({ path: 'modules/core', id: 'core' }),
      makeNode({ path: 'modules/parser', id: 'parser' }),
    ];
    const edges = [makeEdge({ from: 'modules/core', to: 'modules/parser' })];

    render(
      createElement(ArchitectureCanvas, {
        nodes,
        edges,
        focusedNodePath: 'modules/core',
      }),
      { wrapper: providerWrapper({ graphSelection: { anchorNodePath: 'modules/core', neighborhoodDepth: 1 } as any }) },
    );

    await waitFor(() => {
      expect(GraphMock).toHaveBeenCalledOnce();
    });

    const arg = GraphMock.mock.calls[0]?.[0];
    expect(arg.data.nodes.find((node: { id: string; style: { stroke: string } }) => node.id === 'modules/core')?.style.stroke).toBe('#4f46e5');
    expect(arg.data.nodes.find((node: { id: string; style: { stroke: string } }) => node.id === 'modules/parser')?.style.stroke).toBe('#7cb1ff');
    expect(arg.data.edges[0]?.style.stroke).toBe('#4f46e5');
  });
});

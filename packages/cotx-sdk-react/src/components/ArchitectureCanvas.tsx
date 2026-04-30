import { useEffect, useMemo, useRef } from 'react';
import type { Graph, GraphData } from '@antv/g6';
import type { ExplorerNode, ExplorerEdge } from 'cotx-sdk-core';
import { useCotxWorkbench } from '../hooks/useCotxWorkbench.js';
import { toG6Spec } from './canvas/g6-adapter.js';
import {
  getNodeLabel,
  shouldShowEdgeLabel,
  type NodeLabelDensity,
  type EdgeLabelDensity,
} from './canvas/label-policy.js';

export interface ArchitectureCanvasProps {
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  focusedNodePath?: string | null;
  neighborhoodDepth?: 0 | 1 | 2;
  viewportCommand?: {
    kind: 'fit' | 'reset';
    token: number;
  } | null;
  width?: number;
  height?: number;
}

function buildNeighborhoodStateMap(
  nodes: ExplorerNode[],
  edges: ExplorerEdge[],
  focusedNodePath: string | null,
  neighborhoodDepth: 0 | 1 | 2,
): Record<string, string[]> | null {
  if (!focusedNodePath) {
    return null;
  }

  const stateMap: Record<string, string[]> = {};
  const renderableLeafIds = new Set(
    nodes.filter((node) => node.kind === 'leaf').map((node) => node.path),
  );
  const renderableEdges = edges.filter(
    (edge) => renderableLeafIds.has(edge.from) && renderableLeafIds.has(edge.to),
  );

  const adjacency = new Map<string, Set<string>>();
  const edgeIdsByNode = new Map<string, string[]>();

  const addNeighbor = (from: string, to: string) => {
    const existing = adjacency.get(from) ?? new Set<string>();
    existing.add(to);
    adjacency.set(from, existing);
  };

  const addEdgeRef = (nodePath: string, edgeId: string) => {
    const existing = edgeIdsByNode.get(nodePath) ?? [];
    existing.push(edgeId);
    edgeIdsByNode.set(nodePath, existing);
  };

  for (const edge of renderableEdges) {
    const edgeId = `${edge.from}--${edge.type}-->${edge.to}`;
    addNeighbor(edge.from, edge.to);
    addNeighbor(edge.to, edge.from);
    addEdgeRef(edge.from, edgeId);
    addEdgeRef(edge.to, edgeId);
  }

  const relatedNodes = new Set<string>([focusedNodePath]);
  let frontier = new Set<string>([focusedNodePath]);

  for (let depth = 0; depth < neighborhoodDepth; depth += 1) {
    const next = new Set<string>();
    for (const nodePath of frontier) {
      for (const neighbor of adjacency.get(nodePath) ?? []) {
        if (relatedNodes.has(neighbor)) continue;
        relatedNodes.add(neighbor);
        next.add(neighbor);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  const relatedEdges = new Set<string>();
  for (const nodePath of relatedNodes) {
    for (const edgeId of edgeIdsByNode.get(nodePath) ?? []) {
      relatedEdges.add(edgeId);
    }
  }

  for (const node of nodes) {
    if (node.path === focusedNodePath) {
      stateMap[node.path] = ['selected'];
    } else if (relatedNodes.has(node.path)) {
      stateMap[node.path] = ['related'];
    } else {
      stateMap[node.path] = ['dimmed'];
    }
  }

  for (const edge of renderableEdges) {
    const edgeId = `${edge.from}--${edge.type}-->${edge.to}`;
    if (edge.from === focusedNodePath || edge.to === focusedNodePath) {
      stateMap[edgeId] = ['selected'];
    } else if (relatedEdges.has(edgeId)) {
      stateMap[edgeId] = ['related'];
    } else {
      stateMap[edgeId] = ['dimmed'];
    }
  }

  return stateMap;
}

function buildGraphData(
  nodes: ExplorerNode[],
  edges: ExplorerEdge[],
  nodeDensity: NodeLabelDensity,
  edgeDensity: EdgeLabelDensity,
  focusedNodePath: string | null,
  graphElementStates: Record<string, string[]> | null,
): GraphData {
  const spec = toG6Spec(nodes, edges);
  const nodeByPath = new Map(nodes.map((node) => [node.path, node]));

  return {
    nodes: spec.nodes.map((node) => {
      const explorerNode = nodeByPath.get(node.id);
      const label = explorerNode
        ? getNodeLabel(explorerNode, nodeDensity)
        : node.data.shortLabel;
      const visualState = graphElementStates?.[node.id]?.[0] ?? null;

      return {
        ...node,
        style: {
          ...(node.style ?? {}),
          size: [170, 56] as [number, number],
          radius: 10,
          fill: visualState === 'selected'
            ? '#1f2542'
            : visualState === 'related'
              ? '#182337'
              : '#161b22',
          stroke: visualState === 'selected'
            ? '#4f46e5'
            : visualState === 'related'
              ? '#7cb1ff'
              : '#6b7280',
          lineWidth: visualState === 'selected' ? 3 : visualState === 'related' ? 2 : 1.5,
          opacity: visualState === 'dimmed' ? 0.28 : 1,
          labelText: label,
          labelFill: '#e5e7eb',
          labelFontSize: 12,
          labelMaxWidth: 140,
          labelPlacement: 'center',
        },
      };
    }),
    edges: spec.edges.map((edge) => {
      const visualState = graphElementStates?.[edge.id]?.[0] ?? null;
      return {
        ...edge,
        style: {
          stroke: visualState === 'selected'
            ? '#4f46e5'
            : visualState === 'related'
              ? '#7cb1ff'
              : '#8b9baf',
          lineWidth: visualState === 'selected'
            ? Math.max(2.4, edge.data.weight * 0.42)
            : Math.max(1.5, edge.data.weight * 0.35),
          opacity: visualState === 'dimmed' ? 0.18 : visualState === 'related' ? 0.92 : 1,
          endArrow: true,
          labelText: visualState === 'dimmed'
            ? undefined
            : shouldShowEdgeLabel(
              {
                id: edge.id,
                from: edge.source,
                to: edge.target,
                type: edge.data.type,
                label: edge.data.label,
                weight: edge.data.weight,
              },
              edgeDensity,
              focusedNodePath,
            ) ? edge.data.label : undefined,
          labelFill: '#9ca3af',
          labelBackground: true,
          labelBackgroundFill: '#0f172a',
          labelBackgroundRadius: 4,
          labelPadding: [2, 4],
        },
      };
    }),
    combos: spec.combos.map((combo) => {
      const visualState = graphElementStates?.[combo.id]?.[0] ?? null;
      return {
        ...combo,
        style: {
          fill: visualState === 'selected'
            ? '#121e37'
            : '#111827',
          stroke: visualState === 'selected'
            ? '#4f46e5'
            : visualState === 'related'
              ? '#7cb1ff'
              : '#374151',
          lineWidth: visualState === 'selected' ? 2.25 : 1.5,
          opacity: visualState === 'dimmed' ? 0.24 : 1,
          radius: 14,
          labelText: combo.data.label,
          labelFill: '#93c5fd',
          labelFontSize: 13,
        },
      };
    }),
  } as unknown as GraphData;
}

export function ArchitectureCanvas({
  nodes,
  edges,
  focusedNodePath = null,
  neighborhoodDepth,
  viewportCommand = null,
  width = 800,
  height = 600,
}: ArchitectureCanvasProps) {
  const { state, actions } = useCotxWorkbench();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const initialGraphDataRef = useRef<GraphData | null>(null);

  const nodeDensity = state.filters.showNodeMeta as NodeLabelDensity;
  const edgeDensity = state.filters.showEdgeLabels as EdgeLabelDensity;
  const effectiveDepth = neighborhoodDepth ?? state.graphSelection.neighborhoodDepth;

  const graphData = useMemo(() => {
    const graphStates = buildNeighborhoodStateMap(
      nodes,
      edges,
      state.graphSelection.anchorNodePath ?? focusedNodePath,
      effectiveDepth,
    );

    return buildGraphData(
      nodes,
      edges,
      nodeDensity,
      edgeDensity,
      focusedNodePath,
      graphStates,
    );
  }, [
    nodes,
    edges,
    nodeDensity,
    edgeDensity,
    focusedNodePath,
    state.graphSelection.anchorNodePath,
    effectiveDepth,
  ]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (graphRef.current) return;
    let cancelled = false;

    void import('@antv/g6').then(({ Graph }) => {
      if (cancelled || !containerRef.current) return;

      const graph = new Graph({
        container: containerRef.current,
        width,
        height,
        autoFit: 'center',
        data: graphData,
        node: {
          type: 'rect',
        },
        edge: {
          type: 'polyline',
        },
        combo: {
          type: 'rect',
        },
        layout: {
          type: 'grid',
        },
        behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element', 'collapse-expand'],
      });

      graph.on('node:click', (event: any) => {
        const id = event?.target?.id;
        if (!id) return;
        actions.setFocusedNode(String(id));
        actions.setInspectorVisible(true);
      });

      graph.render();
      graphRef.current = graph;
      initialGraphDataRef.current = graphData;
    });

    return () => {
      cancelled = true;
      graphRef.current?.destroy();
      graphRef.current = null;
      initialGraphDataRef.current = null;
    };
  }, [actions, height, width]);

  useEffect(() => {
    if (!graphRef.current) return;
    if (initialGraphDataRef.current === graphData) {
      return;
    }
    graphRef.current.setData(graphData);
    void graphRef.current.render();
    initialGraphDataRef.current = graphData;
  }, [graphData]);

  useEffect(() => {
    if (!graphRef.current || !viewportCommand) return;

    if (viewportCommand.kind === 'fit') {
      void graphRef.current.fitView();
      return;
    }

    void graphRef.current.zoomTo(1);
    void graphRef.current.translateTo([0, 0]);
  }, [viewportCommand]);

  return (
    <div
      className="cotx-architecture-canvas"
      data-testid="architecture-canvas"
      ref={containerRef}
      style={{ width, height }}
    />
  );
}

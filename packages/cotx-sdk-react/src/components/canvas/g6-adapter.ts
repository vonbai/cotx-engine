/**
 * G6-compatible graph data adapter.
 *
 * Converts ExplorerNode[]/ExplorerEdge[] from cotx-sdk-core into a shape
 * that AntV G6 (v5) expects. Group nodes become combos; leaf nodes within
 * a group set their `combo` field to the parent path.
 */

import type {
  ExplorerNode,
  ExplorerEdge,
  NodeStats,
} from 'cotx-sdk-core';

/* ------------------------------------------------------------------ */
/*  G6 spec types                                                      */
/* ------------------------------------------------------------------ */

export interface G6NodeSpec {
  id: string;
  data: {
    label: string;
    shortLabel: string;
    kind: 'leaf' | 'group';
    stats: NodeStats;
    [key: string]: unknown;
  };
  style?: { x?: number; y?: number };
  combo?: string;
}

export interface G6EdgeSpec {
  id: string;
  source: string;
  target: string;
  data: { type: string; label?: string; weight: number };
}

export interface G6ComboSpec {
  id: string;
  data: { label: string };
}

export interface G6GraphSpec {
  nodes: G6NodeSpec[];
  edges: G6EdgeSpec[];
  combos: G6ComboSpec[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Derive a deterministic edge id from source + target + type. */
function edgeId(from: string, to: string, type: string): string {
  return `${from}--${type}-->${to}`;
}

/**
 * Find the parent group path for a leaf node.
 *
 * If the node's `breadcrumb` has more than one entry, the parent is the
 * path of the breadcrumb minus the last segment. We verify the parent
 * exists in the groupPaths set before assigning it.
 */
function findParentGroup(
  node: ExplorerNode,
  groupPaths: Set<string>,
): string | undefined {
  // Direct parent: walk breadcrumb to find the nearest ancestor that is a group
  const crumbs = node.breadcrumb;
  for (let i = crumbs.length - 1; i >= 0; i--) {
    // Build ancestor path by joining breadcrumb up to index i
    const candidatePath = crumbs.slice(0, i + 1).join('/');
    if (groupPaths.has(candidatePath) && candidatePath !== node.path) {
      return candidatePath;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Main conversion                                                    */
/* ------------------------------------------------------------------ */

/**
 * Convert ExplorerNode[]/ExplorerEdge[] into a G6-compatible graph spec.
 *
 * - Group nodes (kind === 'group') are emitted as combos.
 * - Leaf nodes within a group set their `combo` field to the parent group path.
 * - Edges are translated with deterministic IDs.
 */
export function toG6Spec(
  nodes: ExplorerNode[],
  edges: ExplorerEdge[],
): G6GraphSpec {
  // Collect group paths first so we can resolve parent membership
  const groupPaths = new Set(
    nodes.filter((n) => n.kind === 'group').map((n) => n.path),
  );

  const g6Nodes: G6NodeSpec[] = [];
  const g6Combos: G6ComboSpec[] = [];

  for (const node of nodes) {
    if (node.kind === 'group') {
      g6Combos.push({
        id: node.path,
        data: { label: node.label },
      });
    } else {
      const parent = findParentGroup(node, groupPaths);
      const g6Node: G6NodeSpec = {
        id: node.path,
        data: {
          label: node.label,
          shortLabel: node.shortLabel,
          kind: node.kind,
          stats: node.stats,
        },
      };
      if (parent !== undefined) {
        g6Node.combo = parent;
      }
      g6Nodes.push(g6Node);
    }
  }

  // Only include edges whose source and target are present as leaf nodes
  const leafIds = new Set(g6Nodes.map((n) => n.id));

  const g6Edges: G6EdgeSpec[] = edges
    .filter((e) => leafIds.has(e.from) && leafIds.has(e.to))
    .map((e) => ({
      id: edgeId(e.from, e.to, e.type),
      source: e.from,
      target: e.to,
      data: {
        type: e.type,
        ...(e.label != null ? { label: e.label } : {}),
        weight: e.weight,
      },
    }));

  return { nodes: g6Nodes, edges: g6Edges, combos: g6Combos };
}

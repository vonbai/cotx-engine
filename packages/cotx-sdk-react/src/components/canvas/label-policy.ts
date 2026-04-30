/**
 * Label density policy for graph rendering.
 *
 * Controls how much textual information is shown on nodes and edges
 * depending on the user's density preference and the current graph focus.
 */

import type { ExplorerNode, ExplorerEdge } from 'cotx-sdk-core';

/* ------------------------------------------------------------------ */
/*  Density types (mirror WorkbenchState filter values)                */
/* ------------------------------------------------------------------ */

export type NodeLabelDensity = 'minimal' | 'balanced' | 'dense';
export type EdgeLabelDensity = 'none' | 'focus' | 'all';

/* ------------------------------------------------------------------ */
/*  Node labels                                                        */
/* ------------------------------------------------------------------ */

/**
 * Return the display label for a node at the given density.
 *
 * - `minimal`  — shortLabel only (e.g. "parser")
 * - `balanced` — label + file count (e.g. "core/parser (12 files)")
 * - `dense`    — label + full stats summary
 */
export function getNodeLabel(
  node: ExplorerNode,
  density: NodeLabelDensity,
): string {
  switch (density) {
    case 'minimal':
      return node.shortLabel;

    case 'balanced': {
      const count = node.stats.fileCount;
      return `${node.label} (${count} file${count !== 1 ? 's' : ''})`;
    }

    case 'dense': {
      const { fileCount, functionCount, riskScore } = node.stats;
      const parts = [
        `${fileCount} file${fileCount !== 1 ? 's' : ''}`,
        `${functionCount} fn${functionCount !== 1 ? 's' : ''}`,
        `risk ${riskScore.toFixed(1)}`,
      ];
      return `${node.label}\n${parts.join(' | ')}`;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Edge labels                                                        */
/* ------------------------------------------------------------------ */

/**
 * Decide whether an edge label should be displayed.
 *
 * - `none`  — never show edge labels
 * - `focus` — only show labels on edges connected to the focused node
 * - `all`   — always show edge labels
 */
export function shouldShowEdgeLabel(
  edge: ExplorerEdge,
  density: EdgeLabelDensity,
  focusedNodePath: string | null,
): boolean {
  switch (density) {
    case 'none':
      return false;

    case 'all':
      return true;

    case 'focus':
      if (focusedNodePath === null) return false;
      return edge.from === focusedNodePath || edge.to === focusedNodePath;
  }
}

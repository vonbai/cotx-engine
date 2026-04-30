import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import type { ExplorerNode } from 'cotx-sdk-core';
import { useCotxWorkbench } from '../hooks/useCotxWorkbench.js';

/* ------------------------------------------------------------------ */
/*  Internal tree-node type                                            */
/* ------------------------------------------------------------------ */

interface TreeNode {
  /** Segment label for this tree level */
  label: string;
  /** Full path used as the node identity (matches ExplorerNode.path) */
  path: string;
  /** Original explorer node, if this tree level corresponds to one */
  explorerNode: ExplorerNode | null;
  children: TreeNode[];
}

/* ------------------------------------------------------------------ */
/*  Build hierarchy from flat ExplorerNode[]                           */
/* ------------------------------------------------------------------ */

function buildTree(nodes: ExplorerNode[]): TreeNode[] {
  const root: TreeNode = { label: '', path: '', explorerNode: null, children: [] };

  for (const node of nodes) {
    const segments = node.breadcrumb.length > 0 ? node.breadcrumb : [node.label];
    let cursor = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const partialPath = segments.slice(0, i + 1).join('/');
      let child = cursor.children.find((c) => c.label === seg);
      if (!child) {
        child = {
          label: seg,
          path: partialPath,
          explorerNode: null,
          children: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    }
    // attach the real explorer node at the deepest level
    cursor.explorerNode = node;
    cursor.path = node.path;
  }

  return root.children;
}

/* ------------------------------------------------------------------ */
/*  Search filter helper                                               */
/* ------------------------------------------------------------------ */

function matchesSearch(node: ExplorerNode, query: string): boolean {
  const q = query.toLowerCase();
  return (
    node.label.toLowerCase().includes(q) ||
    node.path.toLowerCase().includes(q)
  );
}

function filterTree(tree: TreeNode[], query: string): TreeNode[] {
  if (!query) return tree;

  return tree.reduce<TreeNode[]>((acc, node) => {
    const directMatch =
      node.explorerNode !== null && matchesSearch(node.explorerNode, query);
    const filteredChildren = filterTree(node.children, query);

    if (directMatch || filteredChildren.length > 0) {
      acc.push({
        ...node,
        children: directMatch ? node.children : filteredChildren,
      });
    }
    return acc;
  }, []);
}

/* ------------------------------------------------------------------ */
/*  Recursive tree row                                                 */
/* ------------------------------------------------------------------ */

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  collapsedPaths: string[];
  focusedNodePath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function TreeRow({
  node,
  depth,
  collapsedPaths,
  focusedNodePath,
  onToggle,
  onSelect,
}: TreeRowProps) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsedPaths.includes(node.path);
  const isFocused = focusedNodePath === node.path;
  const displayLabel = node.explorerNode?.label ?? node.label;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (node.explorerNode) {
          onSelect(node.path);
        }
      }
      if (e.key === 'ArrowRight' && hasChildren && isCollapsed) {
        e.preventDefault();
        onToggle(node.path);
      }
      if (e.key === 'ArrowLeft' && hasChildren && !isCollapsed) {
        e.preventDefault();
        onToggle(node.path);
      }
    },
    [node.path, node.explorerNode, hasChildren, isCollapsed, onToggle, onSelect],
  );

  return (
    <li role="treeitem" aria-expanded={hasChildren ? !isCollapsed : undefined}>
      <div
        className="cotx-tree-row"
        data-depth={depth}
        data-focused={isFocused || undefined}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        tabIndex={0}
        role="button"
        onKeyDown={handleKeyDown}
        onClick={() => {
          if (node.explorerNode) onSelect(node.path);
        }}
      >
        {hasChildren ? (
          <button
            className="cotx-tree-toggle"
            aria-label={isCollapsed ? 'expand' : 'collapse'}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
          >
            {isCollapsed ? '\u25B6' : '\u25BC'}
          </button>
        ) : (
          <span className="cotx-tree-leaf-spacer" />
        )}
        <span className="cotx-tree-label">{displayLabel}</span>
      </div>

      {hasChildren && !isCollapsed && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsedPaths={collapsedPaths}
              focusedNodePath={focusedNodePath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */

export interface ArchitectureTreeProps {
  nodes: ExplorerNode[];
  /** Optional override for the search input (uncontrolled by default) */
  searchQuery?: string;
  /** Called when user selects a node. Defaults to workbench setFocusedNode. */
  onSelectNode?: (path: string) => void;
}

export function ArchitectureTree({
  nodes,
  searchQuery: controlledQuery,
  onSelectNode,
}: ArchitectureTreeProps) {
  const { state, actions } = useCotxWorkbench();
  const [localQuery, setLocalQuery] = useState('');
  const query = controlledQuery ?? localQuery;

  const fullTree = useMemo(() => buildTree(nodes), [nodes]);
  const visibleTree = useMemo(() => filterTree(fullTree, query), [fullTree, query]);

  const handleSelect = useCallback(
    (path: string) => {
      if (onSelectNode) {
        onSelectNode(path);
      } else {
        actions.setFocusedNode(path);
        actions.setInspectorVisible(true);
      }
    },
    [onSelectNode, actions],
  );

  if (!state.tree.navVisible) {
    return (
      <aside className="cotx-tree" data-nav-visible="false" aria-hidden="true" />
    );
  }

  return (
    <aside
      className="cotx-tree"
      data-nav-visible="true"
      style={{ width: `${state.tree.navWidth}px` }}
    >
      <div className="cotx-tree-search">
        <input
          type="search"
          placeholder="Filter tree..."
          aria-label="Filter architecture tree"
          value={query}
          onChange={(e) => {
            if (controlledQuery === undefined) {
              setLocalQuery(e.target.value);
            }
          }}
        />
      </div>

      <ul role="tree" className="cotx-tree-root">
        {visibleTree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            collapsedPaths={state.tree.collapsedPaths}
            focusedNodePath={state.focusedNodePath}
            onToggle={actions.toggleTreePath}
            onSelect={handleSelect}
          />
        ))}
      </ul>
    </aside>
  );
}

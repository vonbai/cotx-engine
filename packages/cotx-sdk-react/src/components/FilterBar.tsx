import { useCallback, type ChangeEvent } from 'react';
import type { WorkbenchState } from 'cotx-sdk-core';
import { useCotxWorkbench } from '../hooks/useCotxWorkbench.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type EdgeLabelDensity = WorkbenchState['filters']['showEdgeLabels'];
type NodeMetaDensity = WorkbenchState['filters']['showNodeMeta'];

export interface FilterBarProps {
  /** Additional CSS class name */
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function FilterBar({ className }: FilterBarProps) {
  const { state, actions } = useCotxWorkbench();
  const { filters } = state;

  const handleQueryChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      actions.setFilter({ query: e.target.value });
    },
    [actions],
  );

  const handleEdgeLabelsChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      actions.setFilter({ showEdgeLabels: e.target.value as EdgeLabelDensity });
    },
    [actions],
  );

  const handleNodeMetaChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      actions.setFilter({ showNodeMeta: e.target.value as NodeMetaDensity });
    },
    [actions],
  );

  return (
    <div
      className={['cotx-filter-bar', className].filter(Boolean).join(' ')}
      role="search"
    >
      <label className="cotx-filter-field">
        <span className="cotx-filter-label">Search</span>
        <input
          type="search"
          placeholder="Query..."
          aria-label="Query filter"
          value={filters.query}
          onChange={handleQueryChange}
        />
      </label>

      <label className="cotx-filter-field">
        <span className="cotx-filter-label">Edge labels</span>
        <select
          aria-label="Edge label density"
          value={filters.showEdgeLabels}
          onChange={handleEdgeLabelsChange}
        >
          <option value="none">None</option>
          <option value="focus">Focus</option>
          <option value="all">All</option>
        </select>
      </label>

      <label className="cotx-filter-field">
        <span className="cotx-filter-label">Node detail</span>
        <select
          aria-label="Node meta density"
          value={filters.showNodeMeta}
          onChange={handleNodeMetaChange}
        >
          <option value="minimal">Minimal</option>
          <option value="balanced">Balanced</option>
          <option value="dense">Dense</option>
        </select>
      </label>
    </div>
  );
}

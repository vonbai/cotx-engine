import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import type {
  CotxDataAdapter,
  ExplorerNode,
  SavedViewRef,
  WorkbenchState,
} from 'cotx-sdk-core';
import { CotxProvider } from '../src/provider/CotxProvider.js';
import { useCotxWorkbench } from '../src/hooks/useCotxWorkbench.js';
import { ArchitectureTree } from '../src/components/ArchitectureTree.js';
import { FilterBar } from '../src/components/FilterBar.js';
import { LayerOverview } from '../src/components/LayerOverview.js';
import { SavedViewsPanel } from '../src/components/SavedViewsPanel.js';
import type { ReactNode } from 'react';

afterEach(cleanup);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

afterEach(() => {
  cleanup();
});

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

function makeWrapper(overrides?: Partial<WorkbenchState>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <CotxProvider
        adapter={stubAdapter()}
        projectId="test"
        initialState={overrides}
      >
        {children}
      </CotxProvider>
    );
  };
}

function makeNode(partial: Partial<ExplorerNode> & { path: string }): ExplorerNode {
  return {
    id: partial.path,
    label: partial.label ?? partial.path.split('/').pop()!,
    shortLabel: partial.shortLabel ?? partial.path.split('/').pop()!,
    breadcrumb: partial.breadcrumb ?? partial.path.split('/'),
    directory: partial.directory ?? '',
    kind: partial.kind ?? 'leaf',
    stats: partial.stats ?? {
      fileCount: 1,
      functionCount: 1,
      totalCyclomatic: 1,
      maxCyclomatic: 1,
      maxNestingDepth: 1,
      riskScore: 0,
    },
    ...partial,
  };
}

/* ------------------------------------------------------------------ */
/*  ArchitectureTree                                                   */
/* ------------------------------------------------------------------ */

describe('ArchitectureTree', () => {
  const sampleNodes: ExplorerNode[] = [
    makeNode({
      path: 'core/parser',
      label: 'parser',
      breadcrumb: ['core', 'parser'],
      kind: 'group',
    }),
    makeNode({
      path: 'core/parser/ts',
      label: 'ts',
      breadcrumb: ['core', 'parser', 'ts'],
    }),
    makeNode({
      path: 'core/parser/py',
      label: 'py',
      breadcrumb: ['core', 'parser', 'py'],
    }),
    makeNode({
      path: 'compiler/module',
      label: 'module',
      breadcrumb: ['compiler', 'module'],
    }),
    makeNode({
      path: 'compiler/concept',
      label: 'concept',
      breadcrumb: ['compiler', 'concept'],
    }),
  ];

  it('renders nested paths with collapse/expand', () => {
    const { container } = render(<ArchitectureTree nodes={sampleNodes} />, {
      wrapper: makeWrapper(),
    });

    // Top-level groups should be visible
    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(screen.getByText('core')).toBeDefined();
    expect(screen.getByText('compiler')).toBeDefined();

    // Nested items should be visible (not collapsed by default)
    expect(screen.getByText('parser')).toBeDefined();
    expect(screen.getByText('ts')).toBeDefined();
    expect(screen.getByText('py')).toBeDefined();
    expect(screen.getByText('module')).toBeDefined();
    expect(screen.getByText('concept')).toBeDefined();

    // Verify nesting structure: core > parser > ts
    const treeItems = container.querySelectorAll('[role="treeitem"]');
    expect(treeItems.length).toBeGreaterThan(0);

    // core treeitem should have aria-expanded
    const coreItem = screen.getByText('core').closest('[role="treeitem"]');
    expect(coreItem?.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapses and expands nodes via toggle button', () => {
    render(<ArchitectureTree nodes={sampleNodes} />, {
      wrapper: makeWrapper(),
    });

    // "core" is a group -- find its collapse button
    const coreRow = screen.getByText('core').closest('.cotx-tree-row')!;
    const toggleBtn = within(coreRow).getByRole('button', { name: 'collapse' });

    // Collapse the core group
    fireEvent.click(toggleBtn);

    // "parser" should now be hidden (core's children are collapsed)
    expect(screen.queryByText('parser')).toBeNull();
    expect(screen.queryByText('ts')).toBeNull();

    // Expand again
    const expandBtn = within(coreRow).getByRole('button', { name: 'expand' });
    fireEvent.click(expandBtn);

    expect(screen.getByText('parser')).toBeDefined();
  });

  it('hidden when navVisible is false', () => {
    const { container } = render(<ArchitectureTree nodes={sampleNodes} />, {
      wrapper: makeWrapper({
        tree: { navVisible: false, collapsedPaths: [], navWidth: 260 },
      }),
    });

    const aside = container.querySelector('.cotx-tree');
    expect(aside).not.toBeNull();
    expect(aside!.getAttribute('data-nav-visible')).toBe('false');
    expect(aside!.getAttribute('aria-hidden')).toBe('true');
    // No tree content rendered
    expect(screen.queryByText('core')).toBeNull();
  });

  it('visible when navVisible is true', () => {
    const { container } = render(<ArchitectureTree nodes={sampleNodes} />, {
      wrapper: makeWrapper({
        tree: { navVisible: true, collapsedPaths: [], navWidth: 260 },
      }),
    });

    const aside = container.querySelector('.cotx-tree');
    expect(aside!.getAttribute('data-nav-visible')).toBe('true');
    expect(screen.getByText('core')).toBeDefined();
  });

  it('search filters tree nodes by label/path', () => {
    render(<ArchitectureTree nodes={sampleNodes} />, {
      wrapper: makeWrapper(),
    });

    const searchInput = screen.getByPlaceholderText('Filter tree...');

    // Filter to "ts" -- should show core > parser > ts, but not py, module, concept
    fireEvent.change(searchInput, { target: { value: 'ts' } });

    expect(screen.getByText('ts')).toBeDefined();
    expect(screen.getByText('core')).toBeDefined(); // ancestor preserved
    expect(screen.getByText('parser')).toBeDefined(); // ancestor preserved
    expect(screen.queryByText('py')).toBeNull();
    expect(screen.queryByText('concept')).toBeNull();
  });

  it('search filters by path (not only label)', () => {
    render(<ArchitectureTree nodes={sampleNodes} />, {
      wrapper: makeWrapper(),
    });

    const searchInput = screen.getByPlaceholderText('Filter tree...');
    fireEvent.change(searchInput, { target: { value: 'compiler/module' } });

    expect(screen.getByText('module')).toBeDefined();
    expect(screen.queryByText('concept')).toBeNull();
  });

  it('supports keyboard expand/collapse', () => {
    render(<ArchitectureTree nodes={sampleNodes} />, {
      wrapper: makeWrapper(),
    });

    const coreRow = screen.getByText('core').closest('.cotx-tree-row')!;

    // ArrowLeft collapses when expanded
    fireEvent.keyDown(coreRow, { key: 'ArrowLeft' });
    expect(screen.queryByText('parser')).toBeNull();

    // ArrowRight expands when collapsed
    fireEvent.keyDown(coreRow, { key: 'ArrowRight' });
    expect(screen.getByText('parser')).toBeDefined();
  });

  it('calls onSelectNode when a node is clicked', () => {
    const onSelect = vi.fn();
    render(
      <ArchitectureTree nodes={sampleNodes} onSelectNode={onSelect} />,
      { wrapper: makeWrapper() },
    );

    fireEvent.click(screen.getByText('module'));
    expect(onSelect).toHaveBeenCalledWith('compiler/module');
  });
});

/* ------------------------------------------------------------------ */
/*  FilterBar                                                          */
/* ------------------------------------------------------------------ */

describe('FilterBar', () => {
  it('dispatches query filter changes', () => {
    render(<FilterBar />, { wrapper: makeWrapper() });

    const queryInput = screen.getByPlaceholderText('Query...');
    fireEvent.change(queryInput, { target: { value: 'parser' } });

    // The input should reflect the new value
    expect((queryInput as HTMLInputElement).value).toBe('parser');
  });

  it('dispatches edge label density changes', () => {
    function TestHarness() {
      const { state } = useCotxWorkbench();
      return (
        <div>
          <FilterBar />
          <span data-testid="edge-state">{state.filters.showEdgeLabels}</span>
        </div>
      );
    }

    render(<TestHarness />, { wrapper: makeWrapper() });

    const select = screen.getByLabelText('Edge label density');
    expect(screen.getByTestId('edge-state').textContent).toBe('focus');

    fireEvent.change(select, { target: { value: 'all' } });
    expect(screen.getByTestId('edge-state').textContent).toBe('all');
  });

  it('dispatches node meta density changes', () => {
    function TestHarness() {
      const { state } = useCotxWorkbench();
      return (
        <div>
          <FilterBar />
          <span data-testid="meta-state">{state.filters.showNodeMeta}</span>
        </div>
      );
    }

    render(<TestHarness />, { wrapper: makeWrapper() });

    const select = screen.getByLabelText('Node meta density');
    expect(screen.getByTestId('meta-state').textContent).toBe('balanced');

    fireEvent.change(select, { target: { value: 'dense' } });
    expect(screen.getByTestId('meta-state').textContent).toBe('dense');
  });

  it('renders all three filter controls', () => {
    render(<FilterBar />, { wrapper: makeWrapper() });

    expect(screen.getByLabelText('Query filter')).toBeDefined();
    expect(screen.getByLabelText('Edge label density')).toBeDefined();
    expect(screen.getByLabelText('Node meta density')).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  LayerOverview                                                      */
/* ------------------------------------------------------------------ */

describe('LayerOverview', () => {
  it('renders all canonical layers and marks unpublished layers', () => {
    render(
      <LayerOverview
        activePerspectiveId="overall-architecture"
        perspectives={[
          {
            id: 'overall-architecture',
            label: 'Overall Architecture',
            layer: 'architecture',
            status: 'grounded',
            nodeCount: 4,
            edgeCount: 3,
          },
          {
            id: 'routes',
            label: 'Routes',
            layer: 'routes',
            status: 'gap',
            nodeCount: 0,
            edgeCount: 0,
          },
        ]}
      />,
    );

    expect(screen.getByTestId('layer-overview')).toBeDefined();
    expect(screen.getByRole('button', { name: /architecture: grounded/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /routes: gap/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /change impact: not published/i })).toBeDefined();
  });

  it('calls onSelectPerspective for published layers', () => {
    const onSelect = vi.fn();
    render(
      <LayerOverview
        activePerspectiveId="overall-architecture"
        perspectives={[
          {
            id: 'flows',
            label: 'Flows',
            layer: 'flows',
            nodeCount: 2,
            edgeCount: 1,
          },
        ]}
        onSelectPerspective={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /flows: unknown/i }));
    expect(onSelect).toHaveBeenCalledWith('flows');
  });
});

/* ------------------------------------------------------------------ */
/*  SavedViewsPanel                                                    */
/* ------------------------------------------------------------------ */

describe('SavedViewsPanel', () => {
  const views: SavedViewRef[] = [
    { id: 'v1', label: 'Core overview' },
    { id: 'v2', label: 'Risk hotspots' },
    { id: 'v3', label: 'Data pipeline' },
  ];

  it('renders saved views list', () => {
    const onSelect = vi.fn();
    render(<SavedViewsPanel views={views} onSelectView={onSelect} />);

    expect(screen.getByText('Core overview')).toBeDefined();
    expect(screen.getByText('Risk hotspots')).toBeDefined();
    expect(screen.getByText('Data pipeline')).toBeDefined();
  });

  it('calls onSelectView with the correct view on click', () => {
    const onSelect = vi.fn();
    render(<SavedViewsPanel views={views} onSelectView={onSelect} />);

    fireEvent.click(screen.getByText('Risk hotspots'));
    expect(onSelect).toHaveBeenCalledWith({ id: 'v2', label: 'Risk hotspots' });
  });

  it('triggers callback via keyboard Enter', () => {
    const onSelect = vi.fn();
    render(<SavedViewsPanel views={views} onSelectView={onSelect} />);

    const item = screen.getByText('Data pipeline');
    fireEvent.keyDown(item, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith({ id: 'v3', label: 'Data pipeline' });
  });

  it('triggers callback via keyboard Space', () => {
    const onSelect = vi.fn();
    render(<SavedViewsPanel views={views} onSelectView={onSelect} />);

    const item = screen.getByText('Core overview');
    fireEvent.keyDown(item, { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith({ id: 'v1', label: 'Core overview' });
  });

  it('renders empty state when no views', () => {
    const onSelect = vi.fn();
    render(<SavedViewsPanel views={[]} onSelectView={onSelect} />);

    expect(screen.getByText('No saved views.')).toBeDefined();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

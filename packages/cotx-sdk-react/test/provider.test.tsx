import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import type { CotxDataAdapter, WorkbenchState } from 'cotx-sdk-core';
import { CotxProvider } from '../src/provider/CotxProvider.js';
import { useCotxWorkbench } from '../src/hooks/useCotxWorkbench.js';
import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/*  Test adapter stub                                                  */
/* ------------------------------------------------------------------ */

function stubAdapter(): CotxDataAdapter {
  return {
    getProjectMeta: vi.fn().mockResolvedValue({ id: 'test', compiledAt: '' }),
    listPerspectives: vi.fn().mockResolvedValue([]),
    getPerspective: vi.fn().mockResolvedValue({ id: 'modules', nodes: [], edges: [] }),
    getNode: vi.fn().mockResolvedValue({ path: 'a', label: 'a', kind: 'module' }),
  };
}

function wrapper(
  overrides?: {
    adapter?: CotxDataAdapter;
    projectId?: string;
    perspectiveId?: string;
    initialState?: Partial<WorkbenchState>;
  },
) {
  const adapter = overrides?.adapter ?? stubAdapter();
  const projectId = overrides?.projectId ?? 'my-project';
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <CotxProvider
        adapter={adapter}
        projectId={projectId}
        perspectiveId={overrides?.perspectiveId}
        initialState={overrides?.initialState}
      >
        {children}
      </CotxProvider>
    );
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('CotxProvider + useCotxWorkbench', () => {
  it('bootstraps with adapter and initial project/perspective', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper({ projectId: 'proj-1', perspectiveId: 'flows' }),
    });

    expect(result.current.state.projectId).toBe('proj-1');
    expect(result.current.state.perspectiveId).toBe('flows');
  });

  it('uses default perspective when none is supplied', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper({ projectId: 'proj-2' }),
    });

    expect(result.current.state.perspectiveId).toBe('overall-architecture');
  });

  it('hook exposes workbench state and actions', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    expect(result.current.state).toBeDefined();
    expect(result.current.actions).toBeDefined();
    expect(typeof result.current.actions.setFocusedNode).toBe('function');
    expect(typeof result.current.actions.setPerspective).toBe('function');
    expect(typeof result.current.actions.setFilter).toBe('function');
    expect(typeof result.current.actions.toggleTreePath).toBe('function');
    expect(typeof result.current.actions.setInspectorTab).toBe('function');
    expect(typeof result.current.actions.setInspectorVisible).toBe('function');
    expect(typeof result.current.actions.setNavVisible).toBe('function');
    expect(typeof result.current.actions.setNeighborhoodDepth).toBe('function');
    expect(typeof result.current.actions.hydrateState).toBe('function');
    expect(typeof result.current.actions.setSavedViews).toBe('function');
  });

  it('setFocusedNode updates state', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    expect(result.current.state.focusedNodePath).toBeNull();

    act(() => {
      result.current.actions.setFocusedNode('modules/core');
    });

    expect(result.current.state.focusedNodePath).toBe('modules/core');
    expect(result.current.state.graphSelection.anchorNodePath).toBe('modules/core');
  });

  it('setFocusedNode(null) clears focus', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    act(() => {
      result.current.actions.setFocusedNode('modules/core');
    });
    act(() => {
      result.current.actions.setFocusedNode(null);
    });

    expect(result.current.state.focusedNodePath).toBeNull();
    expect(result.current.state.graphSelection.anchorNodePath).toBeNull();
  });

  it('setPerspective updates perspectiveId', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    act(() => {
      result.current.actions.setPerspective('contracts');
    });

    expect(result.current.state.perspectiveId).toBe('contracts');
  });

  it('setFilter merges partial filter update', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    act(() => {
      result.current.actions.setFilter({ query: 'parser' });
    });

    expect(result.current.state.filters.query).toBe('parser');
    // other defaults preserved
    expect(result.current.state.filters.showEdgeLabels).toBe('focus');
  });

  it('toggleTreePath adds and removes collapsed paths', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    expect(result.current.state.tree.collapsedPaths).toEqual([]);

    act(() => {
      result.current.actions.toggleTreePath('src/core');
    });
    expect(result.current.state.tree.collapsedPaths).toContain('src/core');

    act(() => {
      result.current.actions.toggleTreePath('src/core');
    });
    expect(result.current.state.tree.collapsedPaths).not.toContain('src/core');
  });

  it('setInspectorTab changes active tab', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    act(() => {
      result.current.actions.setInspectorTab('files');
    });

    expect(result.current.state.inspector.tab).toBe('files');
  });

  it('setInspectorVisible toggles inspector', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    expect(result.current.state.inspector.visible).toBe(false);

    act(() => {
      result.current.actions.setInspectorVisible(true);
    });

    expect(result.current.state.inspector.visible).toBe(true);
  });

  it('setNavVisible toggles navigation panel', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    expect(result.current.state.tree.navVisible).toBe(true);

    act(() => {
      result.current.actions.setNavVisible(false);
    });

    expect(result.current.state.tree.navVisible).toBe(false);
  });

  it('setNeighborhoodDepth updates graph selection depth', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    act(() => {
      result.current.actions.setNeighborhoodDepth(2);
    });

    expect(result.current.state.graphSelection.neighborhoodDepth).toBe(2);
  });

  it('hydrateState merges partial workbench state', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    act(() => {
      result.current.actions.hydrateState({
        focusedNodePath: 'core',
        filters: { query: 'parser' },
        tree: { navVisible: false },
      } as Partial<WorkbenchState>);
    });

    expect(result.current.state.focusedNodePath).toBe('core');
    expect(result.current.state.filters.query).toBe('parser');
    expect(result.current.state.tree.navVisible).toBe(false);
  });

  it('setSavedViews replaces saved view refs', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper(),
    });

    act(() => {
      result.current.actions.setSavedViews([
        { id: 'v1', label: 'Core Focus', state: 'p=overall-architecture&f=core' },
      ]);
    });

    expect(result.current.state.savedViews).toEqual([
      { id: 'v1', label: 'Core Focus', state: 'p=overall-architecture&f=core' },
    ]);
  });

  it('host can override initial state', () => {
    const { result } = renderHook(() => useCotxWorkbench(), {
      wrapper: wrapper({
        initialState: {
          focusedNodePath: 'modules/preset',
          inspector: { visible: true, tab: 'relations' },
        },
      }),
    });

    expect(result.current.state.focusedNodePath).toBe('modules/preset');
    expect(result.current.state.inspector.visible).toBe(true);
    expect(result.current.state.inspector.tab).toBe('relations');
    // non-overridden defaults survive
    expect(result.current.state.filters.query).toBe('');
  });

  it('hook throws if used outside provider', () => {
    // Suppress console.error for the expected error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useCotxWorkbench());
    }).toThrow('useCotxWorkbench must be used within a <CotxProvider>');

    spy.mockRestore();
  });
});
